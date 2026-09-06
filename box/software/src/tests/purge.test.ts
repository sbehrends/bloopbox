import { notesDirectory, recordingDirectory } from '../audio/directories.ts';
import { CAPTURE_FILTER_CHAIN, PLAYBACK_FILTER_CHAIN } from '../audio/ffmpeg.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIO_TTL_MS, AudioPurger, purgeExpiredAudio } from '../audio/purge.ts';

/**
 * Automatic storage purge (PRODUCT.md §5, §8): "Validates auto-deletion of temporary audio
 * files older than 48 hours."
 */

let workDir: string;
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'bloopbox-purge-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Writes a file and backdates its mtime by `ageMs`. */
async function writeAged(name: string, ageMs: number, contents = 'audio'): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, contents);
  const when = new Date(NOW - ageMs);
  await utimes(path, when, when);
  return path;
}

const now = (): number => NOW;

describe('TTL enforcement', () => {
  it('deletes audio older than 48 hours', async () => {
    const stale = await writeAged('old.ogg', AUDIO_TTL_MS + 60_000);

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.deleted).toEqual([stale]);
    expect(await readdir(workDir)).toEqual([]);
  });

  it('keeps audio younger than 48 hours', async () => {
    await writeAged('fresh.ogg', AUDIO_TTL_MS - 60_000);

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.deleted).toEqual([]);
    expect(await readdir(workDir)).toEqual(['fresh.ogg']);
  });

  it('deletes a file exactly at the boundary', async () => {
    await writeAged('boundary.ogg', AUDIO_TTL_MS);

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.deleted).toHaveLength(1);
  });

  it('honours a custom TTL', async () => {
    await writeAged('hour-old.ogg', 60 * 60 * 1000);

    const kept = await purgeExpiredAudio({ directory: workDir, ttlMs: 2 * 60 * 60 * 1000, now });
    expect(kept.deleted).toEqual([]);

    const purged = await purgeExpiredAudio({ directory: workDir, ttlMs: 30 * 60 * 1000, now });
    expect(purged.deleted).toHaveLength(1);
  });

  it('deletes unplayed notes too — the TTL bounds how long a voice stays on the device', async () => {
    // Nothing records whether a note was heard; age alone decides.
    await writeAged('never-played.ogg', AUDIO_TTL_MS + 1000);

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.deleted).toHaveLength(1);
  });
});

describe('file selection', () => {
  it('purges every audio artefact the pipeline can leave behind', async () => {
    for (const name of ['a.ogg', 'b.wav', 'c.webm', 'd.m4a', 'e.opus']) {
      await writeAged(name, AUDIO_TTL_MS + 1000);
    }

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.deleted).toHaveLength(5);
  });

  it('leaves non-audio files alone, however old', async () => {
    await writeAged('config.json', AUDIO_TTL_MS * 10);
    await writeAged('notes.txt', AUDIO_TTL_MS * 10);

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.deleted).toEqual([]);
    expect((await readdir(workDir)).toSorted()).toEqual(['config.json', 'notes.txt']);
  });

  it('matches extensions case-insensitively', async () => {
    await writeAged('SHOUTY.OGG', AUDIO_TTL_MS + 1000);

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.deleted).toHaveLength(1);
  });

  it('spares files on the keep list, even when expired', async () => {
    const queued = await writeAged('still-queued.ogg', AUDIO_TTL_MS + 1000);
    await writeAged('done.ogg', AUDIO_TTL_MS + 1000);

    const result = await purgeExpiredAudio({
      directory: workDir,
      now,
      keep: new Set([queued]),
    });

    // A note waiting to be played must survive its own TTL.
    expect(result.deleted).toHaveLength(1);
    expect(await readdir(workDir)).toEqual(['still-queued.ogg']);
  });
});

describe('reporting', () => {
  it('reports how much space was reclaimed', async () => {
    await writeAged('big.ogg', AUDIO_TTL_MS + 1000, 'x'.repeat(4096));

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.freedBytes).toBe(4096);
    expect(result.scanned).toBe(1);
  });

  it('counts scanned files, including those it keeps', async () => {
    await writeAged('old.ogg', AUDIO_TTL_MS + 1000);
    await writeAged('new.ogg', 1000);

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.scanned).toBe(2);
    expect(result.deleted).toHaveLength(1);
  });
});

describe('robustness', () => {
  it('treats a missing directory as empty rather than failing', async () => {
    const result = await purgeExpiredAudio({ directory: join(workDir, 'nope'), now });

    // A purge failure must never take the daemon down.
    expect(result).toEqual({ scanned: 0, deleted: [], freedBytes: 0, errors: [] });
  });

  it('ignores subdirectories', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(workDir, 'nested.ogg'), { recursive: true });

    const result = await purgeExpiredAudio({ directory: workDir, now });

    expect(result.deleted).toEqual([]);
  });
});

describe('AudioPurger scheduling', () => {
  /*
   * Sweeps do real filesystem I/O on the libuv threadpool, which fake timers cannot flush.
   * `whenIdle()` is what makes these deterministic — advancing timers only *starts* a
   * sweep, so each assertion waits for the work itself to finish.
   */
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps immediately on start, since the device may have been off for days', async () => {
    await writeAged('old.ogg', AUDIO_TTL_MS + 1000);

    const purger = new AudioPurger({ directory: workDir, now, intervalMs: 60_000 });
    purger.start();
    await purger.whenIdle();

    expect(await readdir(workDir)).toEqual([]);
    purger.stop();
  });

  it('sweeps again on each interval', async () => {
    const purger = new AudioPurger({ directory: workDir, now, intervalMs: 60_000 });
    purger.start();
    await purger.whenIdle();

    await writeAged('appeared-later.ogg', AUDIO_TTL_MS + 1000);
    await vi.advanceTimersByTimeAsync(60_000);
    await purger.whenIdle();

    expect(await readdir(workDir)).toEqual([]);
    purger.stop();
  });

  it('stops sweeping once stopped', async () => {
    const purger = new AudioPurger({ directory: workDir, now, intervalMs: 60_000 });
    purger.start();
    await purger.whenIdle();
    purger.stop();

    await writeAged('after-stop.ogg', AUDIO_TTL_MS + 1000);
    await vi.advanceTimersByTimeAsync(60_000 * 5);
    await purger.whenIdle();

    expect(await readdir(workDir)).toEqual(['after-stop.ogg']);
  });

  it('reports results only when something happened', async () => {
    const results: number[] = [];
    const purger = new AudioPurger({
      directory: workDir,
      now,
      intervalMs: 60_000,
      onResult: (result) => results.push(result.deleted.length),
    });

    purger.start();
    await purger.whenIdle();
    expect(results).toEqual([]); // nothing to delete, so stay quiet

    await writeAged('old.ogg', AUDIO_TTL_MS + 1000);
    await vi.advanceTimersByTimeAsync(60_000);
    await purger.whenIdle();
    expect(results).toEqual([1]);

    purger.stop();
  });

  it('reports whether it is running', () => {
    const purger = new AudioPurger({ directory: workDir, now });
    expect(purger.running).toBe(false);
    purger.start();
    expect(purger.running).toBe(true);
    purger.stop();
    expect(purger.running).toBe(false);
  });
});

/**
 * Where audio lives (`audio/directories.ts`).
 *
 * The reason these are asserted at all: on 2026-09-06 a note arrived, the lamp blinked, the
 * power went out, and the note was gone — `RECORDING_DIR` was a tmpfs and playback deleting a
 * file is what makes "present on disk" mean "unread", so the audio and the record of it went
 * together. The split below is the fix, and the second test is the one that keeps it working.
 */
describe('audio directories', () => {
  it('keeps captures in RAM and notes on the card', () => {
    // The child's own voice never reaches removable storage; an arriving note survives a
    // power cut. Those are two different promises and they need two directories.
    expect(recordingDirectory({})).toBe('/run/bloopbox');
    expect(notesDirectory({})).toBe('/data/notes');
    expect(notesDirectory({})).not.toBe(recordingDirectory({}));
  });

  it('does not resolve notes through RECORDING_DIR', () => {
    /*
     * The trap this exists for. `/etc/bloopbox/environment` sets RECORDING_DIR, and an upgrade
     * *keeps that file* — so a "sensible" fallback from NOTES_DIR to RECORDING_DIR would send
     * every already-installed box back to the tmpfs, which is precisely the set of boxes the
     * fix was written for. It would also stay green in a harness that sets both.
     */
    expect(notesDirectory({ RECORDING_DIR: '/run/bloopbox' })).toBe('/data/notes');
  });

  it('lets each be overridden on its own', () => {
    expect(recordingDirectory({ RECORDING_DIR: '/tmp/caps' })).toBe('/tmp/caps');
    expect(notesDirectory({ NOTES_DIR: '/tmp/notes' })).toBe('/tmp/notes');
  });
});

/**
 * The two filter chains (`docs/audio-quality.md`).
 *
 * Pinned as strings because every term in them is a measured result rather than a preference,
 * and because the failure they guard against is silent: a chain that ffmpeg rejects fails the
 * whole encode, which on the device is a message that never sends.
 */
describe('audio filter chains', () => {
  it('filters the microphone before it normalises it', () => {
    // Order is the point. Normalising first would lift the noise floor by exactly the gain
    // applied and hand the denoiser a moving target.
    const stages = CAPTURE_FILTER_CHAIN.split(',').map((stage) => stage.split('=')[0]);
    expect(stages).toEqual(['highpass', 'afftdn', 'speechnorm']);
  });

  it('leaves the capture peak short of the rail', () => {
    /*
     * speechnorm's default peak target is 0.95, which measured -0.4 dBFS — too close to the
     * rail to survive an Opus round trip. This is the one parameter in the chain that was
     * changed from what was measured, so it is the one worth pinning.
     */
    expect(CAPTURE_FILTER_CHAIN).toContain('p=0.7');
  });

  it('normalises playback to an integrated loudness with true-peak headroom', () => {
    // I= is what equalises a quiet sender against a loud one (18.1 dB apart -> 0.03 dB).
    // TP= is what stops the decoded WAV clipping on the way out through aplay.
    expect(PLAYBACK_FILTER_CHAIN).toContain('loudnorm');
    expect(PLAYBACK_FILTER_CHAIN).toContain('I=-16');
    expect(PLAYBACK_FILTER_CHAIN).toContain('TP=-1.5');
  });

  it('keeps the expensive filter off the capture path', () => {
    /*
     * loudnorm is affordable on arrival, where nobody is waiting, and nowhere else: encoding
     * runs inside stopRecording and the child waits it out before the whoosh.
     */
    expect(CAPTURE_FILTER_CHAIN).not.toContain('loudnorm');
  });
});
