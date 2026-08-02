import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECOVERY_MAX_AGE_MS, recordingName, recoverUnplayedNotes } from '../audio/recovery.ts';

/**
 * Rebuilding the unread queue after a restart.
 *
 * The invariant under test is that the recordings directory *is* the record of what is
 * unread — playback deletes a note's file — so these tests write files and assert on what
 * comes back, rather than on any separate bookkeeping.
 *
 * Written from the position that a note put on the wrong button is worse than a note lost:
 * the whitelist exists to keep one contact's voice off another contact's button, and
 * recovery must not undo that by guessing.
 */

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

let directory: string;

/** Writes a file and backdates it, since recovery reads arrival time from mtime. */
async function writeNote(name: string, ageMs: number): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, 'not really ogg');
  const seconds = (NOW - ageMs) / 1000;
  await utimes(path, seconds, seconds);
  return path;
}

const options = {
  now: () => NOW,
  // No ffprobe: these files are not real audio, and the probe is not what is under test.
  probe: async () => Promise.resolve(1234),
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bloopbox-recovery-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('recovering unread notes', () => {
  it('restores a recent note to the button its filename names', async () => {
    await writeNote(recordingName(1, '3A77C7FB'), 2 * HOUR);

    const result = await recoverUnplayedNotes({ directory, ...options });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      index: 1,
      note: { messageId: '3A77C7FB', receivedAt: NOW - 2 * HOUR, durationMs: 1234 },
    });
  });

  it('keeps arrival order, so a queue plays back the way it filled', async () => {
    await writeNote(recordingName(0, 'newest'), 1 * HOUR);
    await writeNote(recordingName(0, 'oldest'), 5 * HOUR);
    await writeNote(recordingName(0, 'middle'), 3 * HOUR);

    const result = await recoverUnplayedNotes({ directory, ...options });

    expect(result.notes.map((entry) => entry.note.messageId)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('leaves anything past the window out of the queue', async () => {
    await writeNote(recordingName(2, 'stale'), 9 * HOUR);

    const result = await recoverUnplayedNotes({ directory, ...options });

    expect(result.notes).toHaveLength(0);
    expect(result.expired).toBe(1);
  });

  it('takes a note right at the edge of the window', async () => {
    await writeNote(recordingName(0, 'edge'), RECOVERY_MAX_AGE_MS);

    const result = await recoverUnplayedNotes({ directory, ...options });

    expect(result.notes).toHaveLength(1);
  });

  it('skips audio it cannot attribute rather than guessing a button', async () => {
    /*
     * The old naming, from before the index was encoded. Guessing would put one contact's
     * voice on another contact's button — the exact outcome the whitelist prevents, arriving
     * with none of the evidence that produced it. Losing the note is the safer failure.
     */
    await writeNote('wa-3A77C7FB.ogg', 1 * HOUR);

    const result = await recoverUnplayedNotes({ directory, ...options });

    expect(result.notes).toHaveLength(0);
    expect(result.unattributable).toBe(1);
  });

  it('ignores a button index that is not one of the three', async () => {
    await writeNote('wa-7-3A77C7FB.ogg', 1 * HOUR);

    const result = await recoverUnplayedNotes({ directory, ...options });

    expect(result.notes).toHaveLength(0);
  });

  it('leaves outbound recordings and cue files alone', async () => {
    // Sends and cues share the directory; neither is an unread note.
    await writeNote('capture-1234.webm', 1 * HOUR);
    await writeNote('chime.wav', 1 * HOUR);

    const result = await recoverUnplayedNotes({ directory, ...options });

    expect(result.notes).toHaveLength(0);
    expect(result.unattributable).toBe(0);
  });

  it('survives a directory that is not there', async () => {
    const result = await recoverUnplayedNotes({
      directory: join(directory, 'gone'),
      ...options,
    });

    expect(result).toMatchObject({ notes: [], expired: 0, unattributable: 0 });
  });

  it('falls back to a null duration rather than failing the whole recovery', async () => {
    await writeNote(recordingName(0, 'unprobeable'), 1 * HOUR);

    const result = await recoverUnplayedNotes({
      directory,
      now: () => NOW,
      probe: () => Promise.reject(new Error('ffprobe exploded')),
    });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.note.durationMs).toBeNull();
  });
});

describe('recordingName', () => {
  it('round-trips a message id containing dashes', async () => {
    // WhatsApp ids are opaque, so the id takes the whole remainder of the name.
    await writeNote(recordingName(2, '3A77-C7FB-9C8D'), 1 * HOUR);

    const result = await recoverUnplayedNotes({ directory, ...options });

    expect(result.notes[0]?.note.messageId).toBe('3A77-C7FB-9C8D');
    expect(result.notes[0]?.index).toBe(2);
  });
});
