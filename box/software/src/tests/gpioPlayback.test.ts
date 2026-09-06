import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The GPIO driver's playback path (docs/hardware.md § Audio).
 *
 * `aplay` is not a decoder: handed a file whose header it does not recognise it plays the
 * bytes as raw PCM rather than failing, and an inbound WhatsApp voice note is Ogg/Opus. On
 * the first real device that meant every received message arrived as full-volume noise with
 * `aplay` exiting 0 and nothing logged. These tests hold the decode in place — the whole
 * bug is one missing call, and it is silent in both directions.
 *
 * `opengpio` is never loaded here: only `init()` imports it, and playback does not need it.
 */

const spawned: { command: string; args: readonly string[] }[] = [];

/** Just enough of a ChildProcess for the driver: it listens, and it kills. */
function fakeChild(): EventEmitter {
  const child = new EventEmitter();
  return Object.assign(child, { stderr: null, kill: () => true });
}

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    spawned.push({ command, args });
    const child = fakeChild();
    // A real aplay exits when the file ends; nothing here awaits a timer.
    setImmediate(() => child.emit('close', 0, null));
    return child;
  },
}));

const decoded = vi.fn<(input: string, output: string) => Promise<void>>(
  async (_input: string, output: string) => {
    await writeFile(output, '');
  },
);

/*
 * The constants are re-exported by the mock, not just the functions: `gpioDriver` imports
 * PLAYBACK_DECODING and both filter chains from this module, and a mock that omits them makes
 * every one of them `undefined` at call time rather than failing at import.
 */
vi.mock('../audio/ffmpeg.ts', () => ({
  toPlayableWav: (input: string, output: string) => decoded(input, output),
  toVoiceNote: () => Promise.resolve(),
  PLAYBACK_DECODING: { sampleRate: 16_000, channels: 1 },
  CAPTURE_FILTER_CHAIN: 'highpass=f=110',
  PLAYBACK_FILTER_CHAIN: 'loudnorm=I=-16:TP=-1.5:LRA=11',
}));

let directory: string;

async function makeHal() {
  const { GpioHal } = await import('../hal/gpioDriver.ts');
  return new GpioHal({ recordingDirectory: directory, volumePercent: 50, micGainPercent: 70 });
}

beforeEach(async () => {
  spawned.length = 0;
  decoded.mockClear();
  directory = await mkdtemp(join(tmpdir(), 'bloopbox-playback-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('play', () => {
  it('decodes an Ogg voice note to WAV instead of handing aplay bytes it cannot read', async () => {
    const note = join(directory, 'wa-0-ABC123.ogg');
    await writeFile(note, '');
    const hal = await makeHal();

    await hal.play(note);

    expect(decoded).toHaveBeenCalledWith(note, expect.stringContaining('.wav'));
    const played = spawned.find(({ command }) => command === 'aplay');
    expect(played?.args).toContain(join(directory, 'play-wa-0-ABC123.wav'));
    expect(played?.args).not.toContain(note);
  });

  it('deletes the decoded copy, so a queue of notes cannot fill the RAM disk', async () => {
    const note = join(directory, 'wa-1-DEF456.ogg');
    await writeFile(note, '');
    const hal = await makeHal();

    await hal.play(note);

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(directory)).toEqual(['wa-1-DEF456.ogg']);
  });

  it('plays a WAV as-is: nothing already in a container aplay reads pays for a decode', async () => {
    const wav = join(directory, 'rec-1.wav');
    await writeFile(wav, '');
    const hal = await makeHal();

    await hal.play(wav);

    expect(decoded).not.toHaveBeenCalled();
    expect(spawned.find(({ command }) => command === 'aplay')?.args).toContain(wav);
  });

  it('does not start aplay when stopPlayback() lands during the decode', async () => {
    const note = join(directory, 'wa-0-JKL012.ogg');
    await writeFile(note, '');
    let release: (() => void) | undefined;
    decoded.mockImplementationOnce(async (_input, output) => {
      await writeFile(output, '');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const hal = await makeHal();

    const playing = hal.play(note);
    await vi.waitFor(() => expect(release).toBeDefined());
    // The interrupt a button press causes: there is no process to kill yet.
    await hal.stopPlayback();
    release?.();
    await playing;

    expect(spawned.some(({ command }) => command === 'aplay')).toBe(false);
  });

  it('cleans up the decoded copy when playback itself fails', async () => {
    const note = join(directory, 'wa-2-GHI789.ogg');
    await writeFile(note, '');
    decoded.mockRejectedValueOnce(new Error('ffmpeg exited with code 1'));
    const hal = await makeHal();

    await expect(hal.play(note)).rejects.toThrow(/ffmpeg/);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(directory)).toEqual(['wa-2-GHI789.ogg']);
  });
});

describe('prepare', () => {
  it('decodes on arrival, so the tap that plays the note only has to spawn aplay', async () => {
    const note = join(directory, 'wa-0-MNO345.ogg');
    await writeFile(note, '');
    const hal = await makeHal();

    await hal.prepare(note);
    decoded.mockClear();
    await hal.play(note);

    // The decode is the expensive half, and it happened while nobody was waiting.
    expect(decoded).not.toHaveBeenCalled();
    const played = spawned.find(({ command }) => command === 'aplay');
    expect(played?.args).toContain(join(directory, 'play-wa-0-MNO345.wav'));
  });

  it('keeps the decode for a second listen rather than redoing it', async () => {
    const note = join(directory, 'wa-1-PQR678.ogg');
    await writeFile(note, '');
    const hal = await makeHal();

    await hal.prepare(note);
    await hal.play(note);
    decoded.mockClear();
    await hal.play(note);

    expect(decoded).not.toHaveBeenCalled();
  });

  it('decodes again when the purge has taken the prepared copy', async () => {
    // Both files live in a RAM disk the purge sweeps by age, and a note that outlives its own
    // decode still has to play.
    const note = join(directory, 'wa-2-STU901.ogg');
    await writeFile(note, '');
    const hal = await makeHal();

    await hal.prepare(note);
    await rm(join(directory, 'play-wa-2-STU901.wav'), { force: true });
    decoded.mockClear();
    await hal.play(note);

    expect(decoded).toHaveBeenCalledOnce();
    expect(spawned.some(({ command }) => command === 'aplay')).toBe(true);
  });

  it('never rejects, and leaves play() to decode on demand when it fails', async () => {
    const note = join(directory, 'wa-0-VWX234.ogg');
    await writeFile(note, '');
    decoded.mockRejectedValueOnce(new Error('ffmpeg exited with code 1'));
    const hal = await makeHal();

    await expect(hal.prepare(note)).resolves.toBeUndefined();
    decoded.mockClear();
    await hal.play(note);

    expect(decoded).toHaveBeenCalledOnce();
  });

  it('does not decode a WAV: aplay reads those already', async () => {
    const wav = join(directory, 'injected-1.wav');
    await writeFile(wav, '');
    const hal = await makeHal();

    await hal.prepare(wav);

    expect(decoded).not.toHaveBeenCalled();
  });

  it('decodes one note at a time, however many arrive at once', async () => {
    /*
     * Boot recovery restores every unread note in one pass. A dozen concurrent ffmpeg
     * processes on a Pi Zero, to get ahead of a tap that may never come, would be competing
     * with the daemon coming up.
     */
    let inFlight = 0;
    let peak = 0;
    decoded.mockImplementation(async (_input, output) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      await writeFile(output, '');
      inFlight -= 1;
    });

    const hal = await makeHal();
    const notes = ['wa-0-A.ogg', 'wa-1-B.ogg', 'wa-2-C.ogg'].map((name) => join(directory, name));
    await Promise.all(notes.map(async (note) => writeFile(note, '')));

    await Promise.all(notes.map(async (note) => hal.prepare(note)));

    expect(peak).toBe(1);
    expect(decoded).toHaveBeenCalledTimes(3);
  });

  it('release() frees the decode once the note it came from is gone', async () => {
    const note = join(directory, 'wa-1-YZA567.ogg');
    await writeFile(note, '');
    const hal = await makeHal();

    await hal.prepare(note);
    await hal.release(note);

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(directory)).toEqual(['wa-1-YZA567.ogg']);
  });
});

describe('playCue', () => {
  it('plays the cue WAV directly — cues are generated as WAV and never need ffmpeg', async () => {
    const hal = await makeHal();

    await hal.playCue('pop');

    expect(decoded).not.toHaveBeenCalled();
    expect(spawned.find(({ command }) => command === 'aplay')?.args.at(-1)).toMatch(/pop\.wav$/);
  });
});
