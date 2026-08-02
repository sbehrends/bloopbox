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

import { DeviceController, type OutboundRequest } from '../core/deviceController.ts';
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
    expect(hal.cueSequence()).toContain(AudioCue.Pop);
    expect(hal.cueSequence()).toContain(AudioCue.Whoosh);
    expect(hal.cueSequence()).toContain(AudioCue.Swoosh);
  });

  it('discards a recording whose audio is shorter than the minimum, and says so', async () => {
    // The hold was long enough, but the microphone delivered almost nothing.
    hal.fixedDurationMs = MIN_RECORDING_MS - 1;

    await press(0, RECORD_THRESHOLD_MS + 1000);
    await waitFor(
      () => hal.cueSequence().includes(AudioCue.Oops),
      'the oops cue after discarding a fragment',
    );

    expect(sent).toHaveLength(0);
    expect(hal.cueSequence()).not.toContain(AudioCue.Swoosh);
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
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + 100);
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
    await vi.advanceTimersByTimeAsync(RECORD_THRESHOLD_MS + 400);
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

    expect(start).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(0);
    expect(hal.cueSequence()).toEqual([AudioCue.Oops, AudioCue.Oops]);
  });
});

describe('taps', () => {
  it('beeps when there is nothing to play', async () => {
    await press(0, 300);

    expect(hal.cueSequence()).toEqual([AudioCue.Oops]);
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

  it('applies quiet hours on start', async () => {
    // Default schedule is 20:00 -> 07:00; move the clock into it.
    vi.setSystemTime(new Date(2026, 5, 15, 22, 30, 0));
    await controller.start();

    expect(controller.state.silentMode).toBe(true);
    expect(controller.state.snapshot().silentFromSchedule).toBe(true);
  });

  it('stays audible outside quiet hours', async () => {
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
    await controller.start();

    expect(controller.state.silentMode).toBe(false);
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
   * The chord swallows both presses from inside the same `handleButtonDown` that started
   * their captures, so the cancel can reach the controller before the HAL has finished
   * opening the microphone. Losing it left a capture running for the life of the process,
   * and the next press on that button reused the stale handle — the child's next voice note
   * would have been everything recorded since the chord.
   */
  it('closes both captures it swallows, even the one still opening', async () => {
    hal.pressButton(0);
    hal.pressButton(2);
    await vi.advanceTimersByTimeAsync(3000);
    hal.releaseButton(0);
    hal.releaseButton(2);
    await vi.advanceTimersByTimeAsync(50);
    await flush();

    expect(hal.cancelledRecordings).toHaveLength(2);
    expect(hal.activeRecordings.size).toBe(0);

    // And the button still records afterwards, into a capture of its own.
    hal.fixedDurationMs = 3000;
    await press(2, RECORD_THRESHOLD_MS + 400);
    await waitFor(() => sent.length === 1, 'the recording after the chord to be sent');
  });
});

describe('volume', () => {
  it('clamps the configured volume to the safety cap', () => {
    // Default config is 70 with an 85 cap.
    expect(controller.volumePercent()).toBe(70);
  });

  it('applies the clamped volume to the HAL on start', async () => {
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
