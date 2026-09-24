import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimulatorTransport } from '../hal/simulatorDriver.ts';

/**
 * The capture half of the GPIO driver: `arecord` into a WAV, then an encode.
 *
 * `opengpio` is never loaded: only `init()` imports it, and capture does not need it. The
 * simulator's duration is covered here too, because both drivers answer the same question —
 * how much audio did the child actually record — and used to answer it with the clock.
 */

type FakeChild = EventEmitter & {
  kills: string[];
  exitCode: number | null;
  signalCode: string | null;
};

const spawned: { command: string; args: readonly string[]; child: FakeChild }[] = [];

/** Closes a fake child the way a real one does: exit state first, then the event. */
function close(child: FakeChild, code: number | null, signal: string | null): void {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit('close', code, signal);
}

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stderr: null,
      kills: [] as string[],
      exitCode: null,
      signalCode: null,
    });
    Object.assign(child, {
      kill: (signal: string) => {
        child.kills.push(signal);
        // arecord finalises its header on SIGTERM and exits; no timer involved.
        setImmediate(() => close(child, null, signal));
        return true;
      },
    });
    spawned.push({ command, args, child });
    // aplay (the pop, the whoosh) plays to the end at once. arecord runs until stopped.
    if (command !== 'arecord') setImmediate(() => close(child, 0, null));
    return child;
  },
}));

const encoded = vi.fn<(input: string, output: string, durationMs: number | null) => void>();
const probed = vi.fn<(path: string) => Promise<number | null>>();

vi.mock('../audio/ffmpeg.ts', () => ({
  toPlayableWav: () => Promise.resolve(),
  toVoiceNote: async (input: string, output: string, _filter: unknown, durationMs: number) => {
    encoded(input, output, durationMs);
    await writeFile(output, 'ogg');
  },
  probeDurationMs: (path: string) => probed(path),
  PLAYBACK_DECODING: { sampleRate: 16_000, channels: 1 },
  CAPTURE_FILTER_CHAIN: 'highpass=f=110',
  PLAYBACK_FILTER_CHAIN: 'loudnorm=I=-16:TP=-1.5:LRA=11',
}));

const { GpioHal, CAPTURE_FORMAT, wavDurationMs } = await import('../hal/gpioDriver.ts');
const { SimulatorHal } = await import('../hal/simulatorDriver.ts');

let directory: string;

function makeHal() {
  return new GpioHal({ recordingDirectory: directory, volumePercent: 50, micGainPercent: 70 });
}

/** The WAV `arecord` was told to write. */
function capturePath(): string {
  const entry = spawned.find(({ command }) => command === 'arecord');
  const path = entry?.args.at(-1);
  if (path === undefined) throw new Error('arecord was not spawned');
  return path;
}

/** A WAV of exactly `ms` of silence at the capture format, header included. */
function wavOf(ms: number): Buffer {
  const bytesPerSecond = CAPTURE_FORMAT.rate * CAPTURE_FORMAT.channels * 2;
  return Buffer.alloc(44 + Math.round((bytesPerSecond * ms) / 1000));
}

beforeEach(async () => {
  spawned.length = 0;
  encoded.mockClear();
  probed.mockReset();
  directory = await mkdtemp(join(tmpdir(), 'bloopbox-capture-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe('wavDurationMs', () => {
  it('reads the length from the samples, not the header', () => {
    expect(wavDurationMs(wavOf(1500).length)).toBe(1500);
  });

  it('calls a header with nothing after it zero, which is what an empty microphone gives', () => {
    expect(wavDurationMs(44)).toBe(0);
    expect(wavDurationMs(0)).toBe(0);
  });

  it('follows the capture format, so CAPTURE_RATE=48000 does not triple the answer', () => {
    const format = { rate: 48_000, channels: 1, format: 'S16_LE' } as const;
    expect(wavDurationMs(44 + 48_000 * 2, format)).toBe(1000);
  });
});

describe('stopRecording', () => {
  it('reports how much audio was captured, not how long the whole thing took', async () => {
    const hal = makeHal();
    const handle = await hal.startRecording(0);
    await writeFile(capturePath(), wavOf(1200));
    /*
     * The clock runs well past the audio: resume grace, the stop, the encode. The old code
     * reported this 30 s as the duration.
     */
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(handle.startedAt + 30_000);

    const result = await hal.stopRecording(handle);

    expect(result.durationMs).toBe(1200);
    // And the encode's deadline is sized from the same number.
    expect(encoded).toHaveBeenCalledWith(capturePath(), result.path, 1200);
  });

  it('reports zero for a capture that recorded nothing, so the controller can refuse it', async () => {
    const hal = makeHal();
    const handle = await hal.startRecording(1);
    await writeFile(capturePath(), wavOf(0));

    await expect(hal.stopRecording(handle)).resolves.toMatchObject({ durationMs: 0 });
  });
});

/** A browser that is connected and says nothing. */
function transport(): SimulatorTransport {
  return {
    connected: true,
    sendLeds: () => undefined,
    sendStartCapture: () => undefined,
    sendStopCapture: () => undefined,
    sendCancelCapture: () => undefined,
    sendPlay: () => undefined,
    sendPlayCue: () => undefined,
    sendStopPlayback: () => undefined,
  };
}

describe('the simulator', () => {
  it('reports the duration of the encoded file, not the time the browser took to flush', async () => {
    probed.mockResolvedValue(900);
    const hal = new SimulatorHal(transport(), {
      recordingDirectory: directory,
      volumePercent: 50,
      micGainPercent: 70,
    });
    const handle = await hal.startRecording(0);
    const stopped = hal.stopRecording(handle);
    hal.handleAudioChunk(handle.id, Buffer.from('webm'));
    await hal.handleAudioComplete(handle.id, 'audio/webm');

    await expect(stopped).resolves.toMatchObject({ durationMs: 900 });
    expect(probed).toHaveBeenCalledWith(join(directory, `${handle.id}.ogg`));
  });

  it('falls back to the clock where ffprobe is missing', async () => {
    probed.mockResolvedValue(null);
    const hal = new SimulatorHal(transport(), {
      recordingDirectory: directory,
      volumePercent: 50,
      micGainPercent: 70,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = await hal.startRecording(0);
    const stopped = hal.stopRecording(handle);
    hal.handleAudioChunk(handle.id, Buffer.from('webm'));
    vi.setSystemTime(handle.startedAt + 700);
    await hal.handleAudioComplete(handle.id, 'audio/webm');

    // Read before the encode, so at least the encode is not counted as audio.
    await expect(stopped).resolves.toMatchObject({ durationMs: 700 });
  });
});
