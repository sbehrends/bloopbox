import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioCue } from '../audio/cues.ts';
import { ConfigManager, DEFAULT_TEMPLATE_PATH } from '../config/configManager.ts';
import { configSchema, DEFAULT_BUTTON_TIMINGS, type DeviceConfig } from '../config/schema.ts';

const {
  recordThresholdMs: RECORD_THRESHOLD_MS,
  minRecordingMs: MIN_RECORDING_MS,
  resumeGraceMs: RESUME_GRACE_MS,
  silentComboMs: SILENT_COMBO_MS,
} = DEFAULT_BUTTON_TIMINGS;

/**
 * A hold that carries a message: past the tap/hold boundary, with room to spare.
 *
 * Derived rather than written out, because the boundary is `recordThresholdMs +
 * minRecordingMs` and both are tunable — a literal here would quietly become a tap the next
 * time either is retuned, and the test would pass while asserting nothing.
 */
const HOLD_MS = RECORD_THRESHOLD_MS + MIN_RECORDING_MS + 500;

/** The production deletion. `src/core/` does no I/O, so the composition root hands it over. */
const deleteFile = (path: string): Promise<void> => rm(path, { force: true });

import {
  DeviceController,
  MIN_USABLE_AUDIO_MS,
  type DeviceFault,
  QUIET_HOURS_MAX_SLEEP_MS,
  type OutboundRequest,
  type StatsRecorder,
} from '../core/deviceController.ts';
import { DeviceStatus } from '../core/deviceState.ts';
import { MockHal } from '../hal/mockDriver.ts';
import { waitFor } from './support/waitFor.ts';

/**
 * End-to-end behaviour of the wired device: a HAL button edge in, cues and sends out.
 *
 * This is the layer that decides what the child actually experiences, so the cases here are
 * the ones a person would notice — a fragment being sent, a cue firing at night, a queue
 * that does not clear its light.
 */

let workDir: string;
let hal: MockHal;
let config: ConfigManager;
let controller: DeviceController;
let sent: OutboundRequest[];
let marked: { index: number; messageIds: string[] }[];
let sendResult: 'ok' | 'fail';
/**
 * What the controller told the counters, in order.
 *
 * A recording stub rather than a real `StatsStore`: what is worth pinning here is *which*
 * events count, not how they are written to a card. The store has its own suite.
 */
let counted: { kind: 'sent' | 'received' | 'played'; index: number; value: number | null }[];
/** Every failure the controller swallowed and reported, in order. */
let faults: DeviceFault[];

async function buildConfig(): Promise<DeviceConfig> {
  const template = configSchema.parse(
    JSON.parse(await readFile(DEFAULT_TEMPLATE_PATH, 'utf8')) as unknown,
  );
  return {
    ...template,
    system: { ...template.system, configured: true, adminPasswordHash: '$2b$10$x' },
    contacts: {
      button1: { name: 'Mom', target: '15551234567', enabled: true },
      button2: { name: 'Dad', target: '15559876543', enabled: true },
      button3: { name: 'Grandma', target: '15555555555', enabled: true },
    },
  };
}

beforeEach(async () => {
  /*
   * setImmediate is deliberately left real. The commit path awaits filesystem work, which
   * completes on libuv's I/O phase — fully faked timers never yield there, so assertions
   * would run before the chain finished. `flush()` below uses it to hand back control.
   */
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));

  workDir = await mkdtemp(join(tmpdir(), 'bloopbox-controller-'));
  const configPath = join(workDir, 'config.json');
  await writeFile(configPath, JSON.stringify(await buildConfig()), 'utf8');

  config = new ConfigManager({ configPath, templatePath: DEFAULT_TEMPLATE_PATH });
  await config.load();

  hal = new MockHal();
  await hal.init();

  sent = [];
  marked = [];
  counted = [];
  faults = [];
  sendResult = 'ok';
  const stats: StatsRecorder = {
    recordSent: (index, durationMs) => counted.push({ kind: 'sent', index, value: durationMs }),
    recordReceived: (index, durationMs) =>
      counted.push({ kind: 'received', index, value: durationMs }),
    recordPlayed: (index, count) => counted.push({ kind: 'played', index, value: count }),
  };
  controller = new DeviceController({
    hal,
    config,
    deleteFile,
    send: (request) => {
      if (sendResult === 'fail') return Promise.reject(new Error('bridge offline'));
      sent.push(request);
      return Promise.resolve();
    },
    markRead: (index, messageIds) => {
      marked.push({ index, messageIds: [...messageIds] });
    },
    stats,
    onFault: (fault) => faults.push(fault),
  });
  controller.setStatus(DeviceStatus.Ready);
});

afterEach(async () => {
  await controller.dispose();
  vi.useRealTimers();
  await rm(workDir, { recursive: true, force: true });
});

/** Yields to the real event loop so pending filesystem callbacks can run. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Holds every cue open until the returned function is called, so a test can act while the bip
 * is still playing. Every cue, not just the bip: releasing a press plays the "oops" too, and
 * resolving only the most recent one would leave the bip — and the capture behind it — pending
 * forever.
 */
function holdCues(): { release: () => void; restore: () => void } {
  const pending: (() => void)[] = [];
  const original = hal.playCue.bind(hal);
  const spy = vi.spyOn(hal, 'playCue').mockImplementation(async (cue) => {
    // Still logged by the mock, so `cueSequence()` shows what was asked for.
    await original(cue);
    await new Promise<void>((resolve) => {
      pending.push(resolve);
    });
  });
  return {
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
    restore: () => {
      spy.mockRestore();
    },
  };
}

/**
 * Presses and releases a button, holding for `holdMs` of fake time.
 *
 * The wait after release clears the resume window: a recording is not committed the moment
 * the button comes up, so anything asserting on a send has to let that window expire.
 */
async function press(index: 0 | 1 | 2, holdMs: number): Promise<void> {
  hal.pressButton(index);
  await vi.advanceTimersByTimeAsync(holdMs);
  hal.releaseButton(index);
  // Let the capture/commit chain settle, including its filesystem work.
  await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
  await flush();
}

describe('recording and sending', () => {
  it('sends a recording that is long enough [D-09]', async () => {
    hal.fixedDurationMs = 3000;

    await press(0, HOLD_MS);
    await waitFor(() => sent.length > 0, 'the recording to be sent');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ index: 0, durationMs: 3000 });
    /*
     * Exactly two sounds, in this order: the bip that invited the child to speak, and one
     * confirmation that the message went. There used to be a third — a "delivered" cue after
     * WhatsApp accepted it — and two sounds back to back read as noise rather than as news.
     */
    expect(hal.cueSequence()).toEqual([AudioCue.Pop, AudioCue.Whoosh]);
  });

  it('plays the whoosh only once the take is finalised [D-08]', async () => {
    // The bip's rule at the other end of the take: a cue over a capture still closing is recorded
    // into it. Finalising is held open here, so a whoosh played first would show up before it.
    hal.fixedDurationMs = 3000;
    let finalise: (() => void) | undefined;
    const original = hal.stopRecording.bind(hal);
    vi.spyOn(hal, 'stopRecording').mockImplementation(async (handle) => {
      await new Promise<void>((resolve) => {
        finalise = resolve;
      });
      return original(handle);
    });
    await press(0, HOLD_MS);
    expect(hal.cueSequence()).toEqual([AudioCue.Pop]);

    finalise?.();
    await waitFor(() => hal.cueSequence().includes(AudioCue.Whoosh), 'the whoosh after finalising');
    expect(hal.cueSequence()).toEqual([AudioCue.Pop, AudioCue.Whoosh]);
  });

  it('plays the bip before opening the microphone, never during [D-06]', async () => {
    /*
     * The speaker is centimetres from the microphone: a cue played while capture is open is
     * recorded into the message, which is exactly what the pop used to do 500ms into every
     * take. Asserting on order rather than on timing, because the ordering is the guarantee.
     */
    hal.fixedDurationMs = 3000;
    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + 50);

    expect(hal.cueSequence()).toEqual([AudioCue.Pop]);
    expect(hal.activeRecordings.size).toBe(1);
    const [recording] = [...hal.activeRecordings.values()];
    const [pop] = hal.cuesPlayed;
    expect(pop?.at).toBeLessThanOrEqual(recording?.startedAt ?? 0);
  });

  it('discards a recording whose audio is shorter than the minimum, and says so', async () => {
    // The hold was long enough, but the microphone delivered almost nothing.
    hal.fixedDurationMs = MIN_USABLE_AUDIO_MS - 1;

    await press(0, HOLD_MS + 500);
    await waitFor(
      () => hal.cueSequence().includes(AudioCue.Oops),
      'the oops cue after discarding a fragment',
    );

    expect(sent).toHaveLength(0);
    expect(hal.cueSequence()).not.toContain(AudioCue.Whoosh);
  });

  it('deletes the fragment rather than leaving it for the purge', async () => {
    hal.fixedDurationMs = 100;
    const recordingPath = join(workDir, 'fragment.ogg');
    await writeFile(recordingPath, 'x');

    // Point the mock at a real file so deletion is observable.
    const originalStop = hal.stopRecording.bind(hal);
    hal.stopRecording = async (handle) => {
      const result = await originalStop(handle);
      return { ...result, path: recordingPath, durationMs: 100 };
    };

    await press(1, HOLD_MS);
    await waitFor(() => !existsSync(recordingPath), 'the fragment file to be deleted');

    await expect(readFile(recordingPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('reports failure with the oops cue when the bridge is offline', async () => {
    hal.fixedDurationMs = 3000;
    sendResult = 'fail';

    await press(2, HOLD_MS);
    await waitFor(
      () => hal.cueSequence().includes(AudioCue.Oops),
      'the oops cue after a failed send',
    );

    expect(sent).toHaveLength(0);
  });

  it('holds the LED solid while recording, then releases it', async () => {
    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + MIN_RECORDING_MS + 100);
    expect(controller.state.recording).toBe(0);

    hal.releaseButton(0);
    // Still solid through the resume window — the capture has not stopped yet.
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS - 50);
    expect(controller.state.recording).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(controller.state.recording).toBeNull();
  });
});

describe('the resume window', () => {
  it('carries on the same recording when the button comes back in time', async () => {
    hal.fixedDurationMs = 3000;
    const start = vi.spyOn(hal, 'startRecording');
    const stop = vi.spyOn(hal, 'stopRecording');

    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + MIN_RECORDING_MS + 400);
    hal.releaseButton(0);

    // The grip slipped: nothing has stopped and nothing has been sent.
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS - 100);
    expect(controller.state.recording).toBe(0);
    expect(stop).not.toHaveBeenCalled();

    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(800);
    hal.releaseButton(0);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await waitFor(() => sent.length > 0, 'the resumed recording to be sent');

    // One capture, one file, one message — and one pop, not one per grip.
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(hal.cueSequence().filter((cue) => cue === AudioCue.Pop)).toHaveLength(1);
  });

  it('does not open a window for a tap', async () => {
    const start = vi.spyOn(hal, 'startRecording');

    await press(0, 300);
    // A second tap after the window would have elapsed is its own press, never a resume.
    await press(0, 300);

    /*
     * Held past the threshold, so each one did open a microphone and did bip — that is the
     * price of a bip prompt enough to be an invitation. Neither carried enough audio to be a
     * message, so both end as taps.
     */
    expect(start).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(0);
    expect(hal.cueSequence()).toEqual([AudioCue.Pop, AudioCue.Oops, AudioCue.Pop, AudioCue.Oops]);
  });
});

/**
 * A button with notes waiting takes no message until they have been heard (PRODUCT.md §1).
 *
 * The interpreter block is unit-tested in `button.test.ts`; what matters here is what the
 * child actually gets — no microphone, no send, and the "oops" that says so.
 */
describe('holds on a button with notes waiting [D-03]', () => {
  /** Queues one note on button 0 and waits for its lamp to be lit. */
  function queueNote(id = 'm-block'): string {
    const path = join(workDir, `${id}.ogg`);
    controller.handleIncoming(0, {
      messageId: id,
      path,
      receivedAt: Date.now(),
      durationMs: 1400,
    });
    return path;
  }

  it('opens no microphone and sends nothing', async () => {
    const start = vi.spyOn(hal, 'startRecording');
    queueNote();
    hal.clearHistory();

    await press(0, HOLD_MS);

    expect(start).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    // The note is still waiting: a refused hold must not consume the queue either.
    expect(controller.state.unreadCount(0)).toBe(1);
    expect(hal.playSequence()).toEqual([]);
  });

  it('answers with the "oops", and nothing else', async () => {
    queueNote();
    hal.clearHistory();

    await press(0, HOLD_MS);

    // No bip inviting speech, no whoosh claiming a send: one sound, and it means "not sent".
    expect(hal.cueSequence()).toEqual([AudioCue.Oops]);
  });

  it('says nothing at all at night, like every other refusal', async () => {
    controller.state.setManualSilent(true);
    queueNote();
    hal.clearHistory();

    await press(0, HOLD_MS);

    expect(hal.cueSequence()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('stays quiet rather than talking over a note that is playing', async () => {
    /*
     * The child is being told to listen, so an "oops" here would cut across the message —
     * cues and playback share one output. The lamp under their finger is the whole answer.
     */
    const path = queueNote();
    // The note stays playing until finishPlayback(), and a cue would cut it off, as on the device.
    hal.holdPlayback = true;

    // A tap starts the queue, and it stays open until the gate is released.
    await press(0, 300);
    await waitFor(() => controller.state.playing === 0, 'playback to start');
    expect(hal.playSequence()).toEqual([path]);
    hal.clearHistory();

    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    hal.releaseButton(0);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await flush();

    expect(hal.cueSequence()).toEqual([]);
    expect(sent).toHaveLength(0);

    // And the message the hold interrupted nothing of finishes normally.
    expect(hal.nowPlaying).toBe(path);
    hal.finishPlayback();
    await waitFor(() => controller.state.unreadCount(0) === 0, 'the queue to drain');
  });

  it('sends again once the queue has drained', async () => {
    hal.fixedDurationMs = 3000;
    queueNote();

    await press(0, HOLD_MS);
    expect(sent).toHaveLength(0);

    // Tap to listen: the light goes out, and the button takes messages again.
    await press(0, 300);
    await waitFor(() => controller.state.unreadCount(0) === 0, 'the queue to drain');

    await press(0, HOLD_MS);
    await waitFor(() => sent.length > 0, 'the recording to be sent');
    expect(sent).toHaveLength(1);
  });

  it('leaves the other buttons free to send', async () => {
    hal.fixedDurationMs = 3000;
    queueNote();

    await press(1, HOLD_MS);
    await waitFor(() => sent.length > 0, 'the recording to be sent');

    expect(sent[0]).toMatchObject({ index: 1 });
    expect(controller.state.unreadCount(0)).toBe(1);
  });
});

describe('taps', () => {
  it('beeps when there is nothing to play', async () => {
    // Short enough that the microphone was never asked for: no bip either.
    await press(0, 100);

    expect(hal.cueSequence()).toEqual([AudioCue.Oops]);
    expect(sent).toHaveLength(0);
  });

  it('plays the queue for a tap held past the threshold, rather than sending nothing', async () => {
    // A press past the threshold on a blinking button. No microphone opens at all — notes are
    // waiting, so the button is listening only — and what the child asked for is the message.
    controller.handleIncoming(0, {
      messageId: 'm-tap',
      path: join(workDir, 'm-tap.ogg'),
      receivedAt: Date.now(),
      durationMs: 900,
    });

    await press(0, 300);
    await waitFor(() => hal.playSequence().length > 0, 'the queued note to play');

    expect(hal.playSequence()).toEqual([join(workDir, 'm-tap.ogg')]);
    expect(hal.cueSequence()).not.toContain(AudioCue.Oops);
    expect(sent).toHaveLength(0);
  });

  it('stays completely silent for a press inside the debounce window', async () => {
    await press(0, 50);

    expect(hal.cueSequence()).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});

/**
 * While a note plays, the other buttons wait for it. The speaker is centimetres from the
 * microphone and cues share its output, so a bip, an "oops" or an open capture would all land
 * on top of the message the child is listening to.
 */
describe('while a note is playing [D-05] [D-07]', () => {
  /** Queues a note on button 0, taps it, and holds playback open until the returned call. */
  async function startPlayback(): Promise<() => Promise<void>> {
    hal.holdPlayback = true;
    controller.handleIncoming(0, {
      messageId: 'm-playing',
      path: join(workDir, 'm-playing.ogg'),
      receivedAt: Date.now(),
      durationMs: 5000,
    });

    await press(0, 300);
    await waitFor(() => controller.state.playing === 0, 'playback to start');
    hal.clearHistory();

    return async () => {
      hal.finishPlayback();
      await waitFor(() => controller.state.playing === null, 'playback to finish');
    };
  }

  it('ignores a hold on another button: no bip, no microphone, no send', async () => {
    const start = vi.spyOn(hal, 'startRecording');
    const finish = await startPlayback();

    await press(1, HOLD_MS);

    expect(start).not.toHaveBeenCalled();
    expect(hal.cueSequence()).toEqual([]);
    expect(sent).toHaveLength(0);
    await finish();
  });

  it('ignores a tap on another button, rather than beeping over the message', async () => {
    const finish = await startPlayback();

    await press(2, 100);

    expect(hal.cueSequence()).toEqual([]);
    await finish();
  });

  it('does not queue up another contact’s notes behind it', async () => {
    const finish = await startPlayback();
    controller.handleIncoming(1, {
      messageId: 'm-waiting',
      path: join(workDir, 'm-waiting.ogg'),
      receivedAt: Date.now(),
      durationMs: 900,
    });
    hal.clearHistory();

    await press(1, 100);
    await finish();
    await flush();

    // The tap was nothing, so nothing plays after the first note: button 1 is still blinking.
    expect(hal.playSequence()).toEqual([]);
    expect(controller.state.unreadCount(1)).toBe(1);
  });

  it('frees the other buttons once the note has finished', async () => {
    hal.fixedDurationMs = 3000;
    const finish = await startPlayback();
    await finish();

    await press(1, HOLD_MS);
    await waitFor(() => sent.length > 0, 'the recording to be sent');

    expect(sent[0]).toMatchObject({ index: 1 });
  });

  /*
   * The ordinary case that used to lose a message: a second note arrives while the child is
   * listening to the first. The arrival chime cut the first note off — one speaker — and the cut
   * note was counted as heard, deleted, and reported read. Then the drain zeroed the count, so
   * the second note's lamp went dark as well.
   */
  it('does not let a note arriving mid-playback cut off the one being heard', async () => {
    const finish = await startPlayback();

    controller.handleIncoming(0, {
      messageId: 'm-second',
      path: join(workDir, 'm-second.ogg'),
      receivedAt: Date.now(),
      durationMs: 1200,
    });
    await flush();

    // No chime over the note: it is still playing, and nothing was deleted or marked read.
    expect(hal.cueSequence()).toEqual([]);
    expect(hal.nowPlaying).toBe(join(workDir, 'm-playing.ogg'));
    expect(marked).toEqual([]);

    await finish();
    await flush();

    // The first note was heard to the end, so it is the only one reported and counted.
    expect(marked).toEqual([{ index: 0, messageIds: ['m-playing'] }]);
    expect(counted.filter((entry) => entry.kind === 'played')).toEqual([
      { kind: 'played', index: 0, value: 1 },
    ]);
    // And the second is still waiting, with its lamp still lit.
    expect(controller.queue.count(0)).toBe(1);
    expect(controller.state.unreadCount(0)).toBe(1);
  });

  it('puts a note that was cut off back in the queue, unheard', async () => {
    /*
     * The admin panel's speaker test is the one cue allowed to play over anything. Whatever it
     * interrupts must survive it: back in the queue, lamp lit, not deleted, not reported read.
     */
    const path = join(workDir, 'm-playing.ogg');
    await writeFile(path, 'note');
    await startPlayback();

    await controller.playTestCue();
    await waitFor(() => controller.state.playing === null, 'playback to stop');
    await flush();

    expect(controller.queue.count(0)).toBe(1);
    expect(controller.state.unreadCount(0)).toBe(1);
    expect(marked).toEqual([]);
    expect(counted.filter((entry) => entry.kind === 'played')).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('holds back the "oops" of a send that fails while the child is listening', async () => {
    // A failed send answers up to a minute later, which is exactly when a queue may be playing.
    hal.fixedDurationMs = 3000;
    sendResult = 'fail';
    let failSend: (() => void) | undefined;
    const pendingSend = new Promise<void>((_resolve, reject) => {
      failSend = () => reject(new Error('bridge offline'));
    });
    const deferred = new DeviceController({
      hal,
      config,
      deleteFile,
      send: () => pendingSend,
    });
    await controller.dispose();
    controller = deferred;
    controller.setStatus(DeviceStatus.Ready);

    await press(1, HOLD_MS);
    await waitFor(() => hal.cueSequence().includes(AudioCue.Whoosh), 'the send to start');
    const finish = await startPlayback();

    failSend?.();
    await flush();
    expect(hal.cueSequence()).not.toContain(AudioCue.Oops);
    expect(hal.nowPlaying).toBe(join(workDir, 'm-playing.ogg'));
    await finish();
  });

  it('keeps ignoring a button held down across the end of playback', async () => {
    const start = vi.spyOn(hal, 'startRecording');
    const finish = await startPlayback();

    hal.pressButton(1);
    await vi.advanceTimersByTimeAsync(100);
    await finish();
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    hal.releaseButton(1);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await flush();

    expect(start).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe('receiving', () => {
  it('lights the button immediately and chimes, without waiting on audio [D-15]', () => {
    controller.handleIncoming(1, {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    });

    // Synchronous on purpose: the blinking LED must not wait behind a cue.
    expect(controller.state.unreadCount(1)).toBe(1);
    expect(controller.queue.count(1)).toBe(1);
  });

  describe('while the child is recording [D-17]', () => {
    const arrive = (index: 0 | 1 | 2, messageId: string): void => {
      controller.handleIncoming(index, {
        messageId,
        path: join(workDir, `${messageId}.ogg`),
        receivedAt: Date.now(),
        durationMs: 1400,
      });
    };
    const chimes = (): number => hal.cueSequence().filter((cue) => cue === AudioCue.Notify).length;

    it('lights the button but does not chime into the open microphone', async () => {
      // Speaker and microphone are centimetres apart: a chime now is in the child's message.
      hal.fixedDurationMs = 3000;
      hal.pressButton(0);
      await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + 50);
      expect(hal.activeRecordings.size).toBe(1);

      arrive(1, 'during-take');
      await flush();
      expect(controller.state.unreadCount(1)).toBe(1);
      expect(chimes()).toBe(0);

      await vi.advanceTimersByTimeAsync(HOLD_MS - RECORD_THRESHOLD_MS - 50);
      hal.releaseButton(0);
      await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
      await waitFor(() => sent.length > 0, 'the take to be sent');
      // Dropped, not deferred: the lamp has been saying it all along.
      expect(chimes()).toBe(0);
    });

    it('does not chime during the bip either, before the microphone has opened', async () => {
      const cues = holdCues();
      hal.pressButton(0);
      await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + 10);
      expect(hal.cueSequence()).toEqual([AudioCue.Pop]);

      arrive(2, 'during-bip');
      await flush();
      expect(chimes()).toBe(0);
      cues.release();
      cues.restore();
    });

    it('does not chime in the carry-on window, while the take can still resume', async () => {
      hal.fixedDurationMs = 3000;
      hal.pressButton(0);
      await vi.advanceTimersByTimeAsync(HOLD_MS);
      hal.releaseButton(0);
      await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS / 2);

      arrive(1, 'in-window');
      await flush();
      expect(controller.state.unreadCount(1)).toBe(1);
      expect(chimes()).toBe(0);
    });

    it('chimes again once the take is over', async () => {
      hal.fixedDurationMs = 3000;
      await press(0, HOLD_MS);
      await waitFor(() => sent.length > 0, 'the take to be sent');

      arrive(1, 'after-take');
      await waitFor(() => chimes() === 1, 'the chime');
      expect(hal.cueSequence().at(-1)).toBe(AudioCue.Notify);
    });
  });

  it('gets the note ready to play the moment it arrives [D-10]', () => {
    /*
     * The decode used to sit between the tap and the first sound, on a machine where spawning
     * ffmpeg is not free. Arrival is the moment nobody is waiting — the lamp is blinking and
     * the child may not come for minutes.
     */
    controller.handleIncoming(1, {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    });

    expect(hal.prepared).toEqual(['/tmp/m1.ogg']);
  });

  it('prepares a note restored at boot too, not only a freshly delivered one [D-10]', () => {
    controller.restoreUnread(2, {
      messageId: 'm2',
      path: '/tmp/m2.ogg',
      receivedAt: Date.now(),
      durationMs: 900,
    });

    expect(hal.prepared).toEqual(['/tmp/m2.ogg']);
  });

  it('counts a note once even when it arrives by two routes', () => {
    /*
     * The boot scan restores a note from disk, then the bridge reconnects and flushes the
     * delivery it buffered while the daemon was down. One note, two arrivals — and before the
     * count followed the queue, the button claimed two messages and played one.
     */
    const note = {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    };

    expect(controller.restoreUnread(1, note)).toBe(true);
    controller.handleIncoming(1, note);

    expect(controller.state.unreadCount(1)).toBe(1);
    expect(controller.queue.count(1)).toBe(1);
  });

  it('does not chime for a redelivered note', () => {
    const note = {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    };

    controller.handleIncoming(1, note);
    const cuesAfterFirst = hal.playSequence().length;
    controller.handleIncoming(1, note);

    // WhatsApp redelivers ids on its own; a second chime announces nothing.
    expect(hal.playSequence()).toHaveLength(cuesAfterFirst);
  });

  it('tells the sender their message was heard', async () => {
    controller.handleIncoming(1, {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    });

    await press(1, 300);
    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => marked.length > 0, 'the read receipt');

    expect(marked).toEqual([{ index: 1, messageIds: ['m1'] }]);
  });

  it('stays quiet about it when a parent turns receipts off', async () => {
    /*
     * The receipt reports when a small child was at the box, which is a parent's call. Playing
     * must not depend on it: the note is still heard, still cleared and still deleted — only
     * the upstream half is withheld, and it is withheld rather than deferred.
     */
    await config.update({ whatsapp: { markPlayedAsRead: false } });

    controller.handleIncoming(1, {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    });

    await press(1, 300);
    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => controller.state.unreadCount(1) === 0, 'the queue to drain');

    expect(marked).toEqual([]);
    expect(hal.playSequence()).toContain('/tmp/m1.ogg');
  });

  it('plays the queue on a tap and clears the light when it drains', async () => {
    for (const id of ['m1', 'm2']) {
      controller.handleIncoming(1, {
        messageId: id,
        path: `/tmp/${id}.ogg`,
        receivedAt: Date.now(),
        durationMs: 1400,
      });
    }
    expect(controller.state.unreadCount(1)).toBe(2);

    await press(1, 300);
    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => controller.state.unreadCount(1) === 0, 'the queue to drain');

    expect(hal.playSequence()).toEqual(['/tmp/m1.ogg', '/tmp/m2.ogg']);
    // PRODUCT.md §1: the light goes out once the queue finishes.
    expect(controller.state.unreadCount(1)).toBe(0);
    expect(controller.state.playing).toBeNull();
    // And the decodes go with the notes: they are derived from files that no longer exist.
    await waitFor(() => hal.released.length === 2, 'the prepared decodes to be released');
    expect(hal.released.toSorted()).toEqual(['/tmp/m1.ogg', '/tmp/m2.ogg']);
  });

  it('protects queued files from the purge until they are played', () => {
    controller.handleIncoming(2, {
      messageId: 'm9',
      path: '/tmp/m9.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    });

    expect(controller.protectedFiles().has('/tmp/m9.ogg')).toBe(true);
  });
});

describe('a note deleted for everyone', () => {
  async function arrive(index: 0 | 1 | 2, messageId: string): Promise<string> {
    const path = join(workDir, `wa-${String(index)}-${messageId}.ogg`);
    await writeFile(path, 'ogg');
    controller.handleIncoming(index, { messageId, path, receivedAt: Date.now(), durationMs: 900 });
    return path;
  }

  it('comes off its button and off the card, and the lamp follows the queue', async () => {
    const kept = await arrive(1, 'KEEP');
    const revoked = await arrive(1, 'GONE');

    expect(controller.revokeNote(1, 'GONE')).toBe(true);

    expect(controller.queue.peek(1).map((note) => note.path)).toEqual([kept]);
    expect(controller.state.unreadCount(1)).toBe(1);
    await waitFor(() => !existsSync(revoked), 'the revoked file to be deleted');
    await waitFor(() => hal.released.includes(revoked), 'its decode to be released');
    expect(existsSync(kept)).toBe(true);
  });

  it('puts the lamp out when it was the only note', async () => {
    await arrive(0, 'ONLY');

    controller.revokeNote(0, 'ONLY');

    expect(controller.state.unreadCount(0)).toBe(0);
  });

  it('does nothing for an id no queue holds, or one queued on another button', async () => {
    const path = await arrive(2, 'MINE');

    expect(controller.revokeNote(2, 'UNKNOWN')).toBe(false);
    expect(controller.revokeNote(0, 'MINE')).toBe(false);

    expect(controller.state.unreadCount(2)).toBe(1);
    await flush();
    expect(existsSync(path)).toBe(true);
    expect(hal.released).toEqual([]);
  });

  it('is never reported read — nothing was heard', async () => {
    await arrive(1, 'KEEP');
    await arrive(1, 'GONE');

    controller.revokeNote(1, 'GONE');
    await press(1, 100);
    await waitFor(() => marked.length > 0, 'the queue to drain');

    expect(marked).toEqual([{ index: 1, messageIds: ['KEEP'] }]);
  });
});

describe('boot announcement [D-15]', () => {
  it('plays the boot sound once when the boot window opens', async () => {
    hal.clearHistory();

    controller.announceBoot();
    await flush();

    expect(hal.cueSequence()).toEqual([AudioCue.Boot]);
  });

  it('stays quiet at night — power comes back at any hour', async () => {
    controller.state.setManualSilent(true);
    hal.clearHistory();

    controller.announceBoot();
    await flush();

    expect(hal.cueSequence()).toEqual([]);
  });

  it('never lets a mute speaker hold up the boot', async () => {
    hal.failPlayback = true;
    hal.clearHistory();

    // Synchronous and swallowing: a cue is a courtesy, a boot is not optional.
    expect(() => {
      controller.announceBoot();
    }).not.toThrow();
    await flush();
  });
});

describe('silent mode', () => {
  it('suppresses record cues but still plays voice notes', async () => {
    controller.state.setManualSilent(true);
    hal.clearHistory();

    controller.handleIncoming(0, {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    });
    await press(0, 300);
    await vi.advanceTimersByTimeAsync(300);

    // No notify chime at night...
    expect(hal.cueSequence()).not.toContain(AudioCue.Notify);
    // ...but tapping still plays the message (PRODUCT.md §7).
    expect(hal.playSequence()).toEqual(['/tmp/m1.ogg']);
  });

  it('suppresses the pop and whoosh while recording', async () => {
    controller.state.setManualSilent(true);
    hal.fixedDurationMs = 3000;
    hal.clearHistory();

    await press(0, HOLD_MS);

    expect(hal.cueSequence()).toEqual([]);
    // The message still goes out — only the sounds are suppressed.
    expect(sent).toHaveLength(1);
  });

  /*
   * Quiet hours ships **disabled**, so these two switch it on rather than leaning on the
   * template. The zone is pinned to UTC alongside a UTC instant: with a wall clock now read
   * through `quietHours.timezone`, a local-time fixture would put the window an offset away
   * on every machine but Greenwich.
   */
  async function withQuietHours(now: Date, awaitClockSync = false): Promise<DeviceController> {
    await controller.dispose();
    await config.update({
      quietHours: { enabled: true, startTime: '20:00', endTime: '07:00', timezone: 'UTC' },
    });
    vi.setSystemTime(now);
    // Standing in for the restart a config save triggers.
    const rebuilt = new DeviceController({
      hal,
      config,
      deleteFile,
      send: () => Promise.resolve(),
      awaitClockSync,
    });
    rebuilt.setStatus(DeviceStatus.Ready);
    await rebuilt.start();
    return rebuilt;
  }

  it('applies quiet hours on start', async () => {
    // Schedule is 20:00 -> 07:00 UTC; move the clock into it.
    const scheduled = await withQuietHours(new Date(Date.UTC(2026, 5, 15, 22, 30, 0)));

    expect(scheduled.state.silentMode).toBe(true);
    expect(scheduled.state.snapshot().silentFromSchedule).toBe(true);
    await scheduled.dispose();
  });

  /*
   * A Pi boots on the time its last shutdown saved. Until NTP answers, a schedule read off that
   * clock can be hours wrong, so a real device stays audible until the time is known.
   */
  it('stays audible on a device until the clock has synced, then follows the schedule', async () => {
    const scheduled = await withQuietHours(new Date(Date.UTC(2026, 5, 15, 22, 30, 0)), true);
    expect(scheduled.state.silentMode).toBe(false);

    // No timer applies it behind the sync's back.
    await vi.advanceTimersByTimeAsync(2 * QUIET_HOURS_MAX_SLEEP_MS);
    expect(scheduled.state.silentMode).toBe(false);

    scheduled.markClockSynced();
    expect(scheduled.state.silentMode).toBe(true);
    expect(scheduled.state.snapshot().silentFromSchedule).toBe(true);
    await scheduled.dispose();
  });

  it('applies the schedule once synced, including its next boundary', async () => {
    const scheduled = await withQuietHours(new Date(Date.UTC(2026, 5, 15, 19, 59, 30)), true);
    scheduled.markClockSynced();
    // A second report changes nothing: the sync latches.
    scheduled.markClockSynced();
    expect(scheduled.state.silentMode).toBe(false);

    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(scheduled.state.silentMode).toBe(true);
    await scheduled.dispose();
  });

  it('stays audible outside quiet hours', async () => {
    const scheduled = await withQuietHours(new Date(Date.UTC(2026, 5, 15, 12, 0, 0)));

    expect(scheduled.state.silentMode).toBe(false);
    await scheduled.dispose();
  });

  it('falls silent on the boundary itself, not up to a minute after it', async () => {
    // Thirty seconds before 20:00. Counting whole minutes slept a full one from here.
    const scheduled = await withQuietHours(new Date(Date.UTC(2026, 5, 15, 19, 59, 30)));
    expect(scheduled.state.silentMode).toBe(false);

    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(scheduled.state.silentMode).toBe(true);
    await scheduled.dispose();
  });

  /*
   * The schedule used to be re-asserted on every wake, and the wakes are capped at 15 minutes,
   * so a parent who forced sound back on at bedtime had it taken away again within a quarter
   * of an hour. The override now lasts until the schedule next changes its mind.
   */
  it('keeps a chord override until the next boundary, then follows the schedule again', async () => {
    const scheduled = await withQuietHours(new Date(Date.UTC(2026, 5, 15, 22, 30, 0)));
    expect(scheduled.state.silentMode).toBe(true);

    hal.pressButton(0);
    hal.pressButton(2);
    await vi.advanceTimersByTimeAsync(SILENT_COMBO_MS + 100);
    hal.releaseButton(0);
    hal.releaseButton(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(scheduled.state.silentMode).toBe(false);

    // Past the capped re-evaluation, still inside the window: the override stands.
    await vi.advanceTimersByTimeAsync(QUIET_HOURS_MAX_SLEEP_MS + 1000);
    expect(scheduled.state.silentMode).toBe(false);

    /*
     * The clock is moved rather than run: a night of 50 ms LED ticks is too slow to advance
     * through. `setSystemTime` leaves pending timers where they were, so the next wake lands
     * at most one cap after each jump — two caps is enough to cross the boundary.
     */
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 16, 6, 59, 0)));
    await vi.advanceTimersByTimeAsync(2 * QUIET_HOURS_MAX_SLEEP_MS);
    // The window ended with sound already on; nothing to change, and nothing flipped.
    expect(scheduled.state.silentMode).toBe(false);

    vi.setSystemTime(new Date(Date.UTC(2026, 5, 16, 19, 59, 0)));
    await vi.advanceTimersByTimeAsync(2 * QUIET_HOURS_MAX_SLEEP_MS);
    // The next night starts as scheduled — the override was for one night, not for good.
    expect(scheduled.state.silentMode).toBe(true);
    expect(scheduled.state.snapshot().silentFromSchedule).toBe(true);
    await scheduled.dispose();
  });

  it('reads the window in the configured zone, not the device clock', async () => {
    await controller.dispose();
    await config.update({
      quietHours: {
        enabled: true,
        startTime: '20:00',
        endTime: '07:00',
        timezone: 'Europe/Berlin',
      },
    });
    // 19:00 UTC is 20:00 in Berlin in June (CEST, UTC+2 — so 18:00 UTC is the boundary).
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 18, 30, 0)));
    const scheduled = new DeviceController({
      hal,
      config,
      deleteFile,
      send: () => Promise.resolve(),
    });
    scheduled.setStatus(DeviceStatus.Ready);
    await scheduled.start();

    expect(scheduled.state.silentMode).toBe(true);
    await scheduled.dispose();
  });
});

describe('the silent-mode chord [D-12]', () => {
  it('toggles silent mode without sending anything', async () => {
    hal.pressButton(0);
    hal.pressButton(2);
    await vi.advanceTimersByTimeAsync(3000);
    hal.releaseButton(0);
    hal.releaseButton(2);
    await vi.advanceTimersByTimeAsync(50);

    expect(controller.state.silentMode).toBe(true);
    expect(sent).toHaveLength(0);
  });

  /*
   * The chord is swallowed inside the same `handleButtonDown` that started both presses,
   * which is before either could reach the threshold — so neither ever asks for a microphone.
   * It used to open two and rely on the cancel finding them.
   */
  it('never opens a microphone at all', async () => {
    hal.pressButton(0);
    hal.pressButton(2);
    await vi.advanceTimersByTimeAsync(3000);
    hal.releaseButton(0);
    hal.releaseButton(2);
    await vi.advanceTimersByTimeAsync(50);
    await flush();

    expect(hal.activeRecordings.size).toBe(0);
    expect(hal.completedRecordings).toHaveLength(0);
    expect(hal.cueSequence()).not.toContain(AudioCue.Pop);

    // And the button still records afterwards, into a capture of its own.
    hal.fixedDurationMs = 3000;
    await press(2, HOLD_MS);
    await waitFor(() => sent.length === 1, 'the recording after the chord to be sent');
  });

  /*
   * The race the stored *promise* exists for, now reached through the bip instead: capture
   * opens behind a cue, so a button released during those 90ms cancels a capture the HAL has
   * not finished opening. Losing that cancel left a capture running for the life of the
   * process, and the next press on that button reused the stale handle — the child's next
   * voice note would have been everything recorded since.
   *
   * Closing it afterwards was the first fix; the microphone still opened, on top of the "oops"
   * the release had just played. Now the cancel reaches the capture before the bip ends, and
   * nothing opens at all.
   */
  it('never opens the microphone for a press released during the bip [D-06]', async () => {
    const start = vi.spyOn(hal, 'startRecording');
    const cues = holdCues();

    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + 10);
    // The bip is still playing, so no microphone exists yet to cancel.
    expect(hal.cueSequence()).toEqual([AudioCue.Pop]);
    expect(hal.activeRecordings.size).toBe(0);

    hal.releaseButton(0);
    cues.release();
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await flush();

    expect(start).not.toHaveBeenCalled();
    expect(hal.activeRecordings.size).toBe(0);
    expect(sent).toHaveLength(0);

    // And the button still records afterwards, into a capture of its own.
    cues.restore();
    hal.fixedDurationMs = 3000;
    await press(0, HOLD_MS);
    await waitFor(() => sent.length === 1, 'the next recording to be sent');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('never opens the microphone once stopped, even behind a bip still playing [D-06]', async () => {
    const start = vi.spyOn(hal, 'startRecording');
    const cues = holdCues();

    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + 10);
    expect(hal.cueSequence()).toEqual([AudioCue.Pop]);

    const stopped = controller.stop();
    cues.release();
    await stopped;
    await flush();

    expect(start).not.toHaveBeenCalled();
    expect(hal.activeRecordings.size).toBe(0);
  });

  it('closes a microphone that was already open when stopped', async () => {
    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + MIN_RECORDING_MS + 100);
    expect(hal.activeRecordings.size).toBe(1);

    await controller.stop();

    expect(hal.activeRecordings.size).toBe(0);
    expect(hal.cancelledRecordings).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });
});

/**
 * Failures the child never hears about beyond an "oops" still have to reach the journal. Each was
 * once caught and dropped here, which left a box on the bench answering "oops" with nothing logged.
 */
describe('a button with no contact [D-11]', () => {
  it('never opens the microphone, answers "oops" and sends nothing', async () => {
    // Bench finding 2026-09-30: it used to record, encode and fail in the bridge.
    await config.update({ contacts: { button2: { enabled: false } } });
    await controller.dispose();
    controller = new DeviceController({
      hal,
      config,
      deleteFile,
      send: (request) => {
        sent.push(request);
        return Promise.resolve();
      },
      onFault: (fault) => faults.push(fault),
    });
    controller.setStatus(DeviceStatus.Ready);
    const start = vi.spyOn(hal, 'startRecording');
    hal.clearHistory();

    await press(1, HOLD_MS);

    expect(start).not.toHaveBeenCalled();
    expect(hal.cueSequence()).toEqual([AudioCue.Oops]);
    expect(sent).toHaveLength(0);
    expect(faults).toEqual([]);
  });
});

describe('reported faults', () => {
  const kinds = (): string[] => faults.map((fault) => fault.kind);

  it('reports a microphone that would not open', async () => {
    hal.failRecording = true;
    await press(0, HOLD_MS);

    expect(faults).toContainEqual(expect.objectContaining({ kind: 'capture-start', index: 0 }));
    expect(faults.find((fault) => fault.kind === 'capture-start')?.error).toBeInstanceOf(Error);
  });

  it('reports a take that came back with no audio, with its length', async () => {
    // Not an exception, but the one sign of a microphone that delivers nothing at all.
    hal.fixedDurationMs = MIN_USABLE_AUDIO_MS - 50;
    await press(1, HOLD_MS);
    await waitFor(() => kinds().includes('capture-empty'), 'the empty take to be reported');

    expect(faults.find((fault) => fault.kind === 'capture-empty')).toMatchObject({
      index: 1,
      detail: { durationMs: MIN_USABLE_AUDIO_MS - 50 },
    });
    expect(sent).toHaveLength(0);
  });

  it('reports a send WhatsApp did not accept', async () => {
    hal.fixedDurationMs = 3000;
    sendResult = 'fail';
    await press(2, HOLD_MS);
    await waitFor(() => kinds().includes('send'), 'the failed send to be reported');

    expect(faults.find((fault) => fault.kind === 'send')).toMatchObject({ index: 2 });
  });

  it('reports a note that would not play', async () => {
    const path = join(workDir, 'm-broken.ogg');
    controller.handleIncoming(0, {
      messageId: 'm-broken',
      path,
      receivedAt: Date.now(),
      durationMs: 900,
    });
    hal.failPlayback = true;
    await press(0, 300);
    await waitFor(() => kinds().includes('playback'), 'the failed playback to be reported');

    expect(faults.find((fault) => fault.kind === 'playback')).toMatchObject({
      index: 0,
      detail: { path },
    });
  });

  it('reports a cue that would not play, naming it', async () => {
    // The bip, on a button with nothing waiting: the press carries on without it.
    hal.failPlayback = true;
    await press(1, HOLD_MS);

    expect(faults).toContainEqual(
      expect.objectContaining({ kind: 'cue', detail: { cue: AudioCue.Pop } }),
    );
  });

  it('reports a file it could not delete, and carries on', async () => {
    // The take too short to send is deleted at once; a failed delete is left for the purge.
    await controller.dispose();
    controller = new DeviceController({
      hal,
      config,
      deleteFile: () => Promise.reject(new Error('EACCES')),
      send: () => Promise.resolve(),
      onFault: (fault) => faults.push(fault),
    });
    controller.setStatus(DeviceStatus.Ready);
    hal.fixedDurationMs = MIN_USABLE_AUDIO_MS - 50;
    await press(1, HOLD_MS);
    await waitFor(() => kinds().includes('delete'), 'the failed delete to be reported');

    const fault = faults.find(({ kind }) => kind === 'delete');
    expect(fault).toMatchObject({ index: 1, detail: { path: expect.any(String) } });
    expect(fault?.error).toBeInstanceOf(Error);
    await waitFor(() => hal.cueSequence().includes(AudioCue.Oops), 'the oops after it');
  });

  it('keeps working when the reporter itself throws', async () => {
    // Reporting must never be the thing that breaks the next press.
    await controller.dispose();
    const throwing = new DeviceController({
      hal,
      config,
      deleteFile,
      send: (request) => {
        sent.push(request);
        return Promise.resolve();
      },
      onFault: () => {
        throw new Error('the log is broken too');
      },
    });
    controller = throwing;
    controller.setStatus(DeviceStatus.Ready);
    hal.failRecording = true;
    await press(0, HOLD_MS);

    hal.failRecording = false;
    hal.fixedDurationMs = 3000;
    await press(0, HOLD_MS);
    await waitFor(() => sent.length > 0, 'the next press to send');
    expect(sent[0]).toMatchObject({ index: 0 });
  });
});

describe('volume', () => {
  it('reports the configured volume', () => {
    expect(controller.volumePercent()).toBe(70);
  });

  it('applies the configured volume to the HAL on start', async () => {
    await controller.start();
    expect(hal.volumeChanges).toContain(70);
  });
});

describe('disposal', () => {
  /*
   * The listeners are attached at construction, so a controller that is only stopped keeps
   * answering the HAL. Two on one HAL each bipped and opened a microphone for the same press.
   */
  it('lets go of the HAL, so a controller built after it is the only one answering', async () => {
    await controller.dispose();
    const start = vi.spyOn(hal, 'startRecording');
    const rebuilt = new DeviceController({
      hal,
      config,
      deleteFile,
      send: (request) => {
        sent.push(request);
        return Promise.resolve();
      },
    });
    rebuilt.setStatus(DeviceStatus.Ready);
    hal.fixedDurationMs = 3000;
    hal.clearHistory();

    await press(0, HOLD_MS);
    await waitFor(() => sent.length > 0, 'the recording to be sent');
    await flush();

    expect(start).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(hal.cueSequence()).toEqual([AudioCue.Pop, AudioCue.Whoosh]);
    expect(hal.listenerCount('buttonDown')).toBe(1);
    await rebuilt.dispose();
    expect(hal.listenerCount('buttonDown')).toBe(0);
  });

  it('is safe to call twice', async () => {
    await controller.dispose();
    await controller.dispose();
    expect(hal.listenerCount('buttonUp')).toBe(0);
  });
});

describe('config is snapshot, not watched', () => {
  it('ignores a config change until the process restarts', async () => {
    await config.update({ buttons: { recordThresholdMs: 1500 } });

    hal.pressButton(0);
    // Still the 500ms threshold this controller was built with. The saved 1500ms takes
    // effect only after the daemon restarts, which the hardware server triggers on write.
    await vi.advanceTimersByTimeAsync(700);
    expect(controller.state.recording).toBe(0);

    hal.releaseButton(0);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await flush();
  });

  it('picks up saved timings when rebuilt', async () => {
    await config.update({ buttons: { recordThresholdMs: 1500 } });

    // Standing in for the restart.
    await controller.dispose();
    const rebuilt = new DeviceController({
      hal,
      config,
      deleteFile,
      send: () => Promise.resolve(),
    });
    rebuilt.setStatus(DeviceStatus.Ready);

    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(700);
    expect(rebuilt.state.recording).toBeNull();

    await vi.advanceTimersByTimeAsync(900);
    expect(rebuilt.state.recording).toBe(0);

    hal.releaseButton(0);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await flush();
    await rebuilt.dispose();
  });
});

/**
 * Read-only mode (PRODUCT.md §1, "Read-only mode").
 *
 * The interpreter's own tests pin the intents; these pin what a person in the room gets —
 * a sound where the bip would have been, a microphone that never opens, and a receiving
 * half that carries on exactly as before.
 */
describe('read-only mode [D-11]', () => {
  /**
   * Stands in for the restart a config save triggers, since config is snapshot at boot.
   *
   * On a **fresh** HAL, so the cue log starts empty. The two-way controller is disposed as
   * well, not just stopped: `stop()` leaves its `buttonDown` listeners attached, and a press on
   * a shared mock would be answered by both controllers.
   */
  async function readOnlyController(quietHours = false): Promise<DeviceController> {
    await controller.dispose();
    await config.update({
      mode: { readOnly: true },
      ...(quietHours
        ? {
            quietHours: {
              enabled: true,
              startTime: '20:00',
              endTime: '07:00',
              timezone: 'UTC',
            },
          }
        : {}),
    });
    if (quietHours) vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 22, 30, 0)));

    hal = new MockHal();
    await hal.init();

    const rebuilt = new DeviceController({
      hal,
      config,
      deleteFile,
      send: (request) => {
        sent.push(request);
        return Promise.resolve();
      },
    });
    rebuilt.setStatus(DeviceStatus.Ready);
    await rebuilt.start();
    return rebuilt;
  }

  it('answers a hold with the oops and never opens the microphone', async () => {
    const rebuilt = await readOnlyController();

    hal.pressButton(0);
    // Well past the point where a two-way box would have bipped and started capturing.
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + MIN_RECORDING_MS + 1000);

    // The refusal lands while the button is still down — the child hears it as they hold.
    expect(hal.cueSequence()).toEqual([AudioCue.Oops]);
    expect(hal.activeRecordings.size).toBe(0);

    hal.releaseButton(0);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await flush();

    // Releasing adds nothing: no bip, no whoosh, no second oops, and nothing sent.
    expect(hal.cueSequence()).toEqual([AudioCue.Oops]);
    expect(sent).toHaveLength(0);
    await rebuilt.dispose();
  });

  it('still plays a waiting note on a tap', async () => {
    const rebuilt = await readOnlyController();

    rebuilt.handleIncoming(1, {
      messageId: 'm-ro',
      path: join(workDir, 'm-ro.ogg'),
      receivedAt: Date.now(),
      durationMs: 900,
    });

    hal.pressButton(1);
    await vi.advanceTimersByTimeAsync(100);
    hal.releaseButton(1);
    await waitFor(() => hal.playSequence().length > 0, 'the queued note to play');

    expect(hal.playSequence()).toEqual([join(workDir, 'm-ro.ogg')]);
    expect(hal.cueSequence()).not.toContain(AudioCue.Oops);
    await rebuilt.dispose();
  });

  it('says nothing at all during quiet hours', async () => {
    // The refusal is a courtesy sound like every other one, so the schedule silences it —
    // which means a hold at 22:30 produces no feedback beyond the lamp under the finger.
    const rebuilt = await readOnlyController(true);
    expect(rebuilt.state.silentMode).toBe(true);

    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + MIN_RECORDING_MS + 1000);
    hal.releaseButton(0);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await flush();

    expect(hal.cueSequence()).toEqual([]);
    expect(hal.activeRecordings.size).toBe(0);
    expect(sent).toHaveLength(0);
    await rebuilt.dispose();
  });
});

/**
 * What the activity totals in the admin panel are counting.
 *
 * The rules that matter are all about *not* counting: a send that failed, a note the boot scan
 * merely put back, and a redelivery WhatsApp sent twice. Each of the three would inflate a
 * number a parent reads as "this button works", which is the one thing the panel is for.
 */
describe('activity counting', () => {
  it('counts a delivered message, with the audio it carried', async () => {
    hal.fixedDurationMs = 3000;

    await press(0, HOLD_MS);
    await waitFor(() => sent.length > 0, 'the recording to be sent');

    expect(counted).toEqual([{ kind: 'sent', index: 0, value: 3000 }]);
  });

  it('does not count a send the bridge refused', async () => {
    /*
     * The child already heard the "oops". A total that grew anyway would tell a parent the
     * button works, which is precisely the case they are looking at the panel to rule out.
     */
    hal.fixedDurationMs = 3000;
    sendResult = 'fail';

    await press(0, HOLD_MS);
    await waitFor(() => hal.cueSequence().includes(AudioCue.Oops), 'the failure cue');

    expect(counted).toEqual([]);
  });

  it('counts a note when it arrives, and carries its duration', () => {
    controller.handleIncoming(1, {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    });

    expect(counted).toEqual([{ kind: 'received', index: 1, value: 1400 }]);
  });

  it('passes an unknown duration through as unknown rather than as zero', () => {
    controller.handleIncoming(1, {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: null,
    });

    expect(counted).toEqual([{ kind: 'received', index: 1, value: null }]);
  });

  /*
   * The reason the count sits in `handleIncoming` and not in `restoreUnread`. The boot scan
   * calls the latter for every unheard note on the card, so counting there would add the whole
   * backlog to the totals on every restart — and this device restarts on every settings save.
   */
  it('does not count a note the boot scan is merely putting back', () => {
    controller.restoreUnread(2, {
      messageId: 'm2',
      path: '/tmp/m2.ogg',
      receivedAt: Date.now(),
      durationMs: 900,
    });

    expect(counted).toEqual([]);
  });

  it('counts a redelivered note once', () => {
    const note = {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1400,
    };

    controller.handleIncoming(1, note);
    controller.handleIncoming(1, note);

    expect(counted.filter((entry) => entry.kind === 'received')).toHaveLength(1);
  });

  it('counts what the child listened to as the queue drains', async () => {
    for (const messageId of ['m1', 'm2']) {
      controller.handleIncoming(1, {
        messageId,
        path: `/tmp/${messageId}.ogg`,
        receivedAt: Date.now(),
        durationMs: 1000,
      });
    }

    await press(1, 300);
    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => counted.some((entry) => entry.kind === 'played'), 'the playback count');

    expect(counted.filter((entry) => entry.kind === 'played')).toEqual([
      { kind: 'played', index: 1, value: 2 },
    ]);
  });

  it('still counts a playback when read receipts are switched off', async () => {
    /*
     * Whether the sender is told is a parent's privacy decision (`whatsapp.markPlayedAsRead`).
     * What this box counts for its own panel is not, and the two used to be one branch.
     */
    await config.update({ whatsapp: { markPlayedAsRead: false } });

    controller.handleIncoming(1, {
      messageId: 'm1',
      path: '/tmp/m1.ogg',
      receivedAt: Date.now(),
      durationMs: 1000,
    });

    await press(1, 300);
    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => counted.some((entry) => entry.kind === 'played'), 'the playback count');

    expect(marked).toEqual([]);
    expect(counted).toContainEqual({ kind: 'played', index: 1, value: 1 });
  });
});
