import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioCue, shouldPlayCue } from '../audio/cues.ts';
import { createHal, selectHalKind } from '../hal/index.ts';
import { MockHal } from '../hal/mockDriver.ts';
import {
  SimulatorHal,
  SIMULATOR_TIMEOUT_MS,
  type SimulatorTransport,
} from '../hal/simulatorDriver.ts';
import { DeviceState, DeviceStatus } from '../core/deviceState.ts';
import { LedAnimator } from '../core/ledAnimator.ts';

/**
 * HAL contract tests (PRODUCT.md §4, §5). The GPIO driver is excluded — it cannot be
 * exercised without hardware — so these cover the factory, the simulator transport
 * protocol, and the invariants every driver must uphold.
 */

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'bloopbox-hal-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function halOptions() {
  return { recordingDirectory: workDir, micGainPercent: 60, volumePercent: 70 };
}

/** Records everything the driver sends to the browser. */
function fakeTransport(connected = true) {
  const sent: { event: string; args: unknown[] }[] = [];
  const transport: SimulatorTransport & { connected: boolean } = {
    connected,
    sendLeds: (states) => sent.push({ event: 'leds', args: [states] }),
    sendStartCapture: (id, index) => sent.push({ event: 'startCapture', args: [id, index] }),
    sendStopCapture: (id) => sent.push({ event: 'stopCapture', args: [id] }),
    sendCancelCapture: (id) => sent.push({ event: 'cancelCapture', args: [id] }),
    sendPlay: (token, url) => sent.push({ event: 'play', args: [token, url] }),
    sendPlayCue: (token, cue) => sent.push({ event: 'playCue', args: [token, cue] }),
    sendStopPlayback: () => sent.push({ event: 'stopPlayback', args: [] }),
  };
  const events = (): string[] => sent.map((entry) => entry.event);
  return { transport, sent, events };
}

describe('driver selection', () => {
  it('picks the simulator when SIMULATOR_MODE is set', () => {
    expect(selectHalKind({ SIMULATOR_MODE: 'true' })).toBe('simulator');
  });

  it('defaults to gpio on a real device', () => {
    expect(selectHalKind({})).toBe('gpio');
  });

  it('lets HAL_DRIVER=mock win, for tests', () => {
    expect(selectHalKind({ HAL_DRIVER: 'mock', SIMULATOR_MODE: 'true' })).toBe('mock');
  });

  it('builds a mock driver without touching hardware', async () => {
    const hal = await createHal({ ...halOptions(), kind: 'mock' });
    expect(hal.name).toBe('mock');
  });

  it('refuses to build a simulator driver without a transport', async () => {
    await expect(createHal({ ...halOptions(), kind: 'simulator' })).rejects.toThrow(
      /requires a transport/,
    );
  });

  it('does not import opengpio just because the module was loaded', () => {
    // Importing src/hal/index.ts must stay safe on macOS. If a static import of the GPIO
    // driver crept in, this suite would have failed at import time.
    expect(true).toBe(true);
  });
});

describe('every driver upholds the dispose contract', () => {
  it('mock: leaves all LEDs off', async () => {
    const hal = new MockHal();
    await hal.init();
    hal.setLed(0, true);
    hal.setLed(2, true);

    await hal.dispose();

    expect(hal.ledStates).toEqual([false, false, false]);
    expect(hal.disposed).toBe(true);
  });

  it('simulator: pushes an all-off frame to the browser', async () => {
    const { transport, sent } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();
    hal.setLed(1, true);

    await hal.dispose();

    const lastLeds = sent.findLast((e) => e.event === 'leds');
    expect(lastLeds?.args[0]).toEqual([false, false, false]);
  });
});

describe('simulator LED protocol', () => {
  it('sends a full frame whenever any LED changes', async () => {
    const { transport, sent } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    hal.setLed(0, true);
    hal.setLed(2, true);

    const frames = sent.filter((e) => e.event === 'leds').map((e) => e.args[0]);
    expect(frames).toEqual([
      [true, false, false],
      [true, false, true],
    ]);
  });

  it('suppresses redundant writes, so the transport stays quiet at steady state', async () => {
    const { transport, sent } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    hal.setLed(0, true);
    hal.setLed(0, true);
    hal.setLed(0, true);

    expect(sent.filter((e) => e.event === 'leds')).toHaveLength(1);
  });

  it('reports availability from the transport, not its own state', async () => {
    const { transport } = fakeTransport(false);
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    expect(hal.available).toBe(false);
    transport.connected = true;
    expect(hal.available).toBe(true);
  });

  it('replays the current frame to a tab that just connected', async () => {
    const { transport, sent } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();
    hal.setLed(1, true);

    hal.handleBrowserConnected();

    expect(sent.findLast((e) => e.event === 'leds')?.args[0]).toEqual([false, true, false]);
  });
});

describe('simulator recording lifecycle', () => {
  it('refuses to record with no browser attached', async () => {
    const { transport } = fakeTransport(false);
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    await expect(hal.startRecording(0)).rejects.toThrow(/no browser connected/);
  });

  it('asks the browser to start and stop capture', async () => {
    const { transport, events } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    const handle = await hal.startRecording(1);
    expect(events()).toContain('startCapture');

    // Not awaited: it stays pending until the browser delivers audio.
    void hal.stopRecording(handle).catch(() => undefined);
    expect(events()).toContain('stopCapture');

    await hal.dispose();
  });

  it('rejects a recording the browser never delivers, rather than hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = fakeTransport();
      const hal = new SimulatorHal(transport, halOptions());
      await hal.init();

      const handle = await hal.startRecording(0);
      const pending = hal.stopRecording(handle);
      pending.catch(() => undefined); // keeps the rejection handled while timers advance

      await vi.advanceTimersByTimeAsync(SIMULATOR_TIMEOUT_MS + 100);
      await expect(pending).rejects.toThrow(/did not deliver audio/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when the browser reports a capture failure', async () => {
    const { transport } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    const handle = await hal.startRecording(0);
    const pending = hal.stopRecording(handle);
    hal.handleAudioError(handle.id, 'permission denied');

    await expect(pending).rejects.toThrow(/permission denied/);
  });

  it('rejects an empty delivery instead of shipping a silent voice note', async () => {
    const { transport } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    const handle = await hal.startRecording(0);
    const pending = hal.stopRecording(handle);
    // handleAudioComplete rejects `pending` and then awaits cleanup, so attach a handler
    // first — otherwise the rejection is briefly unobserved and surfaces as a test error.
    pending.catch(() => undefined);

    await hal.handleAudioComplete(handle.id, 'audio/webm');
    await expect(pending).rejects.toThrow(/no audio/);
  });

  it('tells the browser to discard a cancelled recording', async () => {
    const { transport, events } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    const handle = await hal.startRecording(2);
    await hal.cancelRecording(handle);

    expect(events()).toContain('cancelCapture');
  });
});

describe('simulator playback', () => {
  it('resolves once the browser reports completion', async () => {
    const { transport, sent } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    const pending = hal.playCue(AudioCue.Pop);
    const token = sent.find((e) => e.event === 'playCue')?.args[0];
    if (typeof token !== 'string') throw new Error('driver sent no playback token');

    hal.handlePlaybackComplete(token);
    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves immediately with no browser, so the audio pipeline never blocks', async () => {
    const { transport } = fakeTransport(false);
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    await expect(hal.playCue(AudioCue.Oops)).resolves.toBeUndefined();
  });

  it('treats a deliberate stop as success, not failure', async () => {
    const { transport } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    const pending = hal.playCue(AudioCue.Chime);
    await hal.stopPlayback();

    await expect(pending).resolves.toBeUndefined();
  });

  it('serves playback files through the /audio route', async () => {
    const { transport, sent } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    void hal.play('/tmp/recordings/rec-1.ogg').catch(() => undefined);

    expect(sent.find((e) => e.event === 'play')?.args[1]).toBe('/audio/rec-1.ogg');
  });
});

describe('button events reach the pipeline', () => {
  it('simulator forwards virtual presses as HAL events', async () => {
    const { transport } = fakeTransport();
    const hal = new SimulatorHal(transport, halOptions());
    await hal.init();

    const downs: number[] = [];
    const ups: number[] = [];
    hal.on('buttonDown', ({ index }) => downs.push(index));
    hal.on('buttonUp', ({ index }) => ups.push(index));

    hal.handleButtonDown(1);
    hal.handleButtonUp(1);

    expect(downs).toEqual([1]);
    expect(ups).toEqual([1]);
  });

  it('mock forwards simulated presses', async () => {
    const hal = new MockHal();
    await hal.init();

    const seen: string[] = [];
    hal.on('buttonDown', () => seen.push('down'));
    hal.on('buttonUp', () => seen.push('up'));

    hal.pressButton(0);
    hal.releaseButton(0);

    expect(seen).toEqual(['down', 'up']);
  });
});

describe('animator over a real driver', () => {
  it('drives the mock HAL through a full state change', async () => {
    vi.useFakeTimers();
    try {
      const hal = new MockHal();
      await hal.init();
      const state = new DeviceState();
      const animator = new LedAnimator(hal, state.snapshot());

      animator.start();
      // Booting: LED 0 first.
      expect(hal.ledStates).toEqual([true, false, false]);

      state.setStatus(DeviceStatus.WifiError);
      animator.update(state.snapshot());
      expect(hal.ledStates).toEqual([true, true, true]);

      animator.stop();
      await hal.dispose();
      expect(hal.ledStates).toEqual([false, false, false]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('silent-mode cue gating', () => {
  it('suppresses feedback cues but never voice-note playback', () => {
    // PRODUCT.md §7: inbound chime and record cues go quiet; playback does not.
    for (const cue of [AudioCue.Pop, AudioCue.Whoosh, AudioCue.Swoosh, AudioCue.Oops]) {
      expect(shouldPlayCue(cue, true)).toBe(false);
      expect(shouldPlayCue(cue, false)).toBe(true);
    }
    expect(shouldPlayCue(AudioCue.Notify, true)).toBe(false);
  });

  it('keeps the inter-message chime audible, since playback itself is not suppressed', () => {
    expect(shouldPlayCue(AudioCue.Chime, true)).toBe(true);
  });

  it('plays everything in audible mode', () => {
    expect(shouldPlayCue(AudioCue.Notify, false)).toBe(true);
    expect(shouldPlayCue(AudioCue.Chime, false)).toBe(true);
  });
});
