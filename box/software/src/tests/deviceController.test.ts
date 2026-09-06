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
} = DEFAULT_BUTTON_TIMINGS;

import {
  DeviceController,
  MIN_USABLE_AUDIO_MS,
  type OutboundRequest,
} from '../core/deviceController.ts';
import { DeviceStatus } from '../core/deviceState.ts';
import { MockHal } from '../hal/mockDriver.ts';

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
  sendResult = 'ok';
  controller = new DeviceController({
    hal,
    config,
    send: (request) => {
      if (sendResult === 'fail') return Promise.reject(new Error('bridge offline'));
      sent.push(request);
      return Promise.resolve();
    },
    markRead: (index, messageIds) => {
      marked.push({ index, messageIds: [...messageIds] });
    },
  });
  controller.setStatus(DeviceStatus.Ready);
});

afterEach(async () => {
  await controller.stop();
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
 * Waits until `predicate` holds, yielding to the event loop between checks.
 *
 * Used instead of a fixed number of `flush()` calls wherever an assertion depends on
 * filesystem work finishing. A fixed count is a guess, and guessing low yields a test that
 * passes alone and fails intermittently under parallel load — which is exactly what happened.
 */
async function waitFor(predicate: () => boolean, label: string, attempts = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor timed out waiting for: ${label}`);
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
  it('sends a recording that is long enough', async () => {
    hal.fixedDurationMs = 3000;

    await press(0, RECORD_THRESHOLD_MS + 1500);
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

  it('plays the bip before opening the microphone, never during', async () => {
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

    await press(0, RECORD_THRESHOLD_MS + MIN_RECORDING_MS + 1000);
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

    await press(1, RECORD_THRESHOLD_MS + 500);
    await waitFor(() => !existsSync(recordingPath), 'the fragment file to be deleted');

    await expect(readFile(recordingPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('reports failure with the oops cue when the bridge is offline', async () => {
    hal.fixedDurationMs = 3000;
    sendResult = 'fail';

    await press(2, RECORD_THRESHOLD_MS + 1000);
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

describe('taps', () => {
  it('beeps when there is nothing to play', async () => {
    // Short enough that the microphone was never asked for: no bip either.
    await press(0, 100);

    expect(hal.cueSequence()).toEqual([AudioCue.Oops]);
    expect(sent).toHaveLength(0);
  });

  it('plays the queue for a tap held past the threshold, rather than sending nothing', async () => {
    // The press opened a microphone and then turned out to be a tap. What the child asked for
    // is the message, and answering "oops" while a light is blinking would be a lie.
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

describe('receiving', () => {
  it('lights the button immediately and chimes, without waiting on audio', () => {
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

  it('gets the note ready to play the moment it arrives', () => {
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

  it('prepares a note restored at boot too, not only a freshly delivered one', () => {
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

describe('boot announcement', () => {
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

    await press(0, RECORD_THRESHOLD_MS + 1000);

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
  async function withQuietHours(now: Date): Promise<DeviceController> {
    await controller.stop();
    await config.update({
      quietHours: { enabled: true, startTime: '20:00', endTime: '07:00', timezone: 'UTC' },
    });
    vi.setSystemTime(now);
    // Standing in for the restart a config save triggers.
    const rebuilt = new DeviceController({ hal, config, send: () => Promise.resolve() });
    rebuilt.setStatus(DeviceStatus.Ready);
    await rebuilt.start();
    return rebuilt;
  }

  it('applies quiet hours on start', async () => {
    // Schedule is 20:00 -> 07:00 UTC; move the clock into it.
    const scheduled = await withQuietHours(new Date(Date.UTC(2026, 5, 15, 22, 30, 0)));

    expect(scheduled.state.silentMode).toBe(true);
    expect(scheduled.state.snapshot().silentFromSchedule).toBe(true);
    await scheduled.stop();
  });

  it('stays audible outside quiet hours', async () => {
    const scheduled = await withQuietHours(new Date(Date.UTC(2026, 5, 15, 12, 0, 0)));

    expect(scheduled.state.silentMode).toBe(false);
    await scheduled.stop();
  });

  it('reads the window in the configured zone, not the device clock', async () => {
    await controller.stop();
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
    const scheduled = new DeviceController({ hal, config, send: () => Promise.resolve() });
    scheduled.setStatus(DeviceStatus.Ready);
    await scheduled.start();

    expect(scheduled.state.silentMode).toBe(true);
    await scheduled.stop();
  });
});

describe('the silent-mode chord', () => {
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
    await press(2, RECORD_THRESHOLD_MS + MIN_RECORDING_MS + 400);
    await waitFor(() => sent.length === 1, 'the recording after the chord to be sent');
  });

  /*
   * The race the stored *promise* exists for, now reached through the bip instead: capture
   * opens behind a cue, so a button released during those 90ms cancels a capture the HAL has
   * not finished opening. Losing that cancel left a capture running for the life of the
   * process, and the next press on that button reused the stale handle — the child's next
   * voice note would have been everything recorded since.
   */
  it('closes a capture that was still opening behind the bip', async () => {
    // Every cue is held open, not just the bip: releasing the press plays the "oops" too, and
    // resolving only the most recent one would leave the bip — and the capture behind it —
    // pending forever.
    const pendingCues: (() => void)[] = [];
    vi.spyOn(hal, 'playCue').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pendingCues.push(resolve);
        }),
    );

    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + 10);
    // The bip is still playing, so no microphone exists yet to cancel.
    expect(hal.activeRecordings.size).toBe(0);

    hal.releaseButton(0);
    for (const resolve of pendingCues) resolve();
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await flush();

    expect(hal.cancelledRecordings).toHaveLength(1);
    expect(hal.activeRecordings.size).toBe(0);
    expect(sent).toHaveLength(0);
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
    await controller.stop();
    const rebuilt = new DeviceController({ hal, config, send: () => Promise.resolve() });
    rebuilt.setStatus(DeviceStatus.Ready);

    hal.pressButton(0);
    await vi.advanceTimersByTimeAsync(700);
    expect(rebuilt.state.recording).toBeNull();

    await vi.advanceTimersByTimeAsync(900);
    expect(rebuilt.state.recording).toBe(0);

    hal.releaseButton(0);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 50);
    await flush();
    await rebuilt.stop();
  });
});

/**
 * Read-only mode (PRODUCT.md §1, "Read-only mode").
 *
 * The interpreter's own tests pin the intents; these pin what a person in the room gets —
 * a sound where the bip would have been, a microphone that never opens, and a receiving
 * half that carries on exactly as before.
 */
describe('read-only mode', () => {
  /**
   * Stands in for the restart a config save triggers, since config is snapshot at boot.
   *
   * On a **fresh** HAL, not the shared one: `stop()` resets the interpreter but leaves the
   * old controller's `buttonDown` listeners attached, so a press on the shared mock would be
   * answered by the two-way controller as well and the cue log would carry both replies.
   */
  async function readOnlyController(quietHours = false): Promise<DeviceController> {
    await controller.stop();
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
    await rebuilt.stop();
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
    await rebuilt.stop();
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
    await rebuilt.stop();
  });
});
