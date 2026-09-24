import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type * as NodeOs from 'node:os';
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

/** `stubborn` makes arecord ignore SIGTERM, as a capture wedged in the driver would. */
const recorder = { stubborn: false };

/** Closes a fake child the way a real one does: exit state first, then the event. */
function close(child: FakeChild, code: number | null, signal: string | null): void {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit('close', code, signal);
}

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      // A piped stream, as spawn gives arecord: the driver reads its stderr unconditionally.
      stderr: new EventEmitter(),
      kills: [] as string[],
      exitCode: null,
      signalCode: null,
    });
    const stubborn = recorder.stubborn;
    Object.assign(child, {
      kill: (signal: string) => {
        child.kills.push(signal);
        if (stubborn && signal !== 'SIGKILL') return true;
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

type DecodeOptions = { onSpawn?: (child: { pid?: number }) => void };
const arrivalDecodes = vi.fn<(input: string, options: DecodeOptions | undefined) => void>();

const reniced = vi.fn<(pid: number, priority: number) => void>();
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  setPriority: (pid: number, priority: number) => {
    reniced(pid, priority);
  },
}));

const encoded = vi.fn<(input: string, output: string, durationMs: number | null) => void>();
const probed = vi.fn<(path: string) => Promise<number | null>>();

vi.mock('../audio/ffmpeg.ts', () => ({
  toPlayableWav: async (
    input: string,
    output: string,
    _format: unknown,
    _filter: unknown,
    options?: DecodeOptions,
  ) => {
    arrivalDecodes(input, options);
    await writeFile(output, '');
  },
  toVoiceNote: async (input: string, output: string, _filter: unknown, durationMs: number) => {
    encoded(input, output, durationMs);
    await writeFile(output, 'ogg');
  },
  probeDurationMs: (path: string) => probed(path),
  PLAYBACK_DECODING: { sampleRate: 16_000, channels: 1 },
  CAPTURE_FILTER_CHAIN: 'highpass=f=110',
  PLAYBACK_FILTER_CHAIN: 'loudnorm=I=-16:TP=-1.5:LRA=11',
}));

const warned = vi.fn<(detail: object, message: string) => void>();
vi.mock('../logger.ts', () => ({ childLogger: () => ({ warn: warned }) }));

const {
  GpioHal,
  BACKGROUND_DECODE_NICENESS,
  CAPTURE_FLUSH_TIMEOUT_MS,
  CAPTURE_FORMAT,
  wavDurationMs,
} = await import('../hal/gpioDriver.ts');
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

function captureChild(): FakeChild {
  const entry = spawned.find(({ command }) => command === 'arecord');
  if (!entry) throw new Error('arecord was not spawned');
  return entry.child;
}

/** A WAV of exactly `ms` of silence at the capture format, header included. */
function wavOf(ms: number): Buffer {
  const bytesPerSecond = CAPTURE_FORMAT.rate * CAPTURE_FORMAT.channels * 2;
  return Buffer.alloc(44 + Math.round((bytesPerSecond * ms) / 1000));
}

beforeEach(async () => {
  spawned.length = 0;
  recorder.stubborn = false;
  warned.mockClear();
  encoded.mockClear();
  arrivalDecodes.mockClear();
  reniced.mockClear();
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

describe('arrival decodes beside a capture', () => {
  /*
   * A loudnorm decode is the heaviest thing the box does. Beside an open microphone on four slow
   * cores it risks an overrun, which is a gap in the child's message.
   */
  it('waits for an open capture to end before starting', async () => {
    const note = join(directory, 'wa-0-HUSH01.ogg');
    await writeFile(note, '');
    const hal = makeHal();
    const handle = await hal.startRecording(0);

    const preparing = hal.prepare(note);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(arrivalDecodes).not.toHaveBeenCalled();

    await hal.cancelRecording(handle);
    await preparing;

    expect(arrivalDecodes).toHaveBeenCalledOnce();
  });

  it('carries on once arecord has died by itself, since nothing is left to protect', async () => {
    const note = join(directory, 'wa-1-HUSH02.ogg');
    await writeFile(note, '');
    const hal = makeHal();
    await hal.startRecording(1);

    const preparing = hal.prepare(note);
    close(captureChild(), 1, null);
    await preparing;

    expect(arrivalDecodes).toHaveBeenCalledOnce();
  });

  it('runs at a lowered priority, and a renice that fails does not fail the decode', async () => {
    const note = join(directory, 'wa-2-HUSH03.ogg');
    await writeFile(note, '');
    const hal = makeHal();

    await hal.prepare(note);

    const options = arrivalDecodes.mock.calls[0]?.[1];
    options?.onSpawn?.({ pid: 4321 });
    expect(reniced).toHaveBeenCalledWith(4321, BACKGROUND_DECODE_NICENESS);

    reniced.mockImplementationOnce(() => {
      throw new Error('ESRCH');
    });
    expect(() => options?.onSpawn?.({ pid: 4322 })).not.toThrow();
    // A child that never got a pid is simply left alone.
    expect(() => options?.onSpawn?.({})).not.toThrow();
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

describe('stopping arecord', () => {
  it('asks it to finish, so the WAV header is written', async () => {
    const hal = makeHal();
    const handle = await hal.startRecording(0);
    await writeFile(capturePath(), wavOf(500));

    await hal.stopRecording(handle);

    expect(captureChild().kills).toEqual(['SIGTERM']);
    expect(warned).not.toHaveBeenCalled();
  });

  it('notices when it already exited by itself, instead of waiting out the flush timeout', async () => {
    /*
     * The close listener used to be attached at stop, after this close had already fired, so
     * every commit that followed such an exit waited the whole flush timeout for nothing. On
     * fake timers the old code never resolves at all.
     */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hal = makeHal();
    const handle = await hal.startRecording(0);
    await writeFile(capturePath(), wavOf(800));
    close(captureChild(), 1, null);

    await expect(hal.stopRecording(handle)).resolves.toMatchObject({ durationMs: 800 });

    expect(captureChild().kills).toEqual([]);
    // And it says so: nobody asked it to stop.
    await vi.waitFor(() => expect(warned).toHaveBeenCalledOnce());
    expect(warned.mock.calls[0]?.[0]).toMatchObject({ code: 1 });
  });

  it('SIGKILLs one that will not stop, after the flush timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    recorder.stubborn = true;
    const hal = makeHal();
    const handle = await hal.startRecording(2);
    await writeFile(capturePath(), wavOf(300));

    const stopped = hal.stopRecording(handle);
    await vi.advanceTimersByTimeAsync(CAPTURE_FLUSH_TIMEOUT_MS);
    await stopped;

    expect(captureChild().kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

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
