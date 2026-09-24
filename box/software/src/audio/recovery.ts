import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { probeDurationMs } from './ffmpeg.ts';
import type { QueuedNote } from './queueManager.ts';
import type { ButtonIndex } from '../config/schema.ts';

/**
 * Rebuilding the unread queue after a restart (PENDING.md, "Unread notes should be recovered").
 *
 * The queue itself lives in `AudioQueueManager`'s memory, so a config save, a crash or an
 * update used to drop every note a child had not yet listened to — while the sender had
 * already seen it delivered.
 *
 * No read-state store is needed for this, because one already exists: `#deletePlayed` removes
 * a note's file the moment its queue drains, so **a file still present is a note still
 * unread**. The recordings directory is the ledger, and recovery is a scan rather than new
 * bookkeeping that could disagree with it.
 *
 * What the directory does *not* record is which button a note belongs to, so the writer
 * encodes it in the name — see `recordingName`.
 */

/**
 * How far back a restart may reach.
 *
 * A product decision, not a technical limit: a note from this morning is still worth hearing
 * when the box comes back, and one from yesterday is a confusing thing to hand a small child
 * who has no way to know it is old. Deliberately far below `AUDIO_TTL_MS` (48 h), which
 * bounds how long audio may *exist*, not how long it stays worth playing.
 *
 * Nothing above this is deleted here. The purge owns deletion, and having one owner is worth
 * more than reclaiming a few kilobytes of RAM disk a little earlier.
 */
export const RECOVERY_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * What a message id may look like before it becomes part of a file name.
 *
 * The id is chosen by the *sender's* client — Baileys only checks that one exists — and any
 * member of an assigned group counts as a sender. Real ids are hex or base32-ish runs, so this
 * refuses nothing genuine; what it refuses is `/../../x`, which `join` would happily resolve to
 * a file outside the notes directory.
 */
const SAFE_MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeMessageId(messageId: string): boolean {
  return SAFE_MESSAGE_ID.test(messageId);
}

/**
 * `wa-<index>-<messageId>.ogg`.
 *
 * The index leads because it is fixed-width and the message id is not, so the id takes the whole
 * remainder and cannot be confused with the field before it. Throws on an id that is not
 * {@link isSafeMessageId}: a name that could leave the directory is never built at all.
 */
export function recordingName(index: ButtonIndex, messageId: string): string {
  if (!isSafeMessageId(messageId)) throw new Error('refusing an unsafe message id as a file name');
  return `wa-${String(index)}-${messageId}.ogg`;
}

/**
 * Where a note for this button and message lives — the one path both daemons agree on.
 *
 * The hardware server compares what the bridge reports against this rather than trusting it,
 * because it goes on to play that file and then delete it: a path taken on faith would let
 * whatever holds the bridge token delete any file this daemon can write. `null` for an id that
 * could never have been written.
 */
export function notePath(directory: string, index: ButtonIndex, messageId: string): string | null {
  return isSafeMessageId(messageId) ? resolve(directory, recordingName(index, messageId)) : null;
}

/** Matches the above. Notes written before the index was encoded do not match, on purpose. */
const RECORDING_PATTERN = /^wa-([0-2])-([A-Za-z0-9_-]{1,128})\.ogg$/;

/** An explicit map rather than a cast, so the digit narrows to a real index or to nothing. */
const INDEX_BY_DIGIT: Readonly<Record<string, ButtonIndex>> = { '0': 0, '1': 1, '2': 2 };

export type RecoveredNote = { readonly index: ButtonIndex; readonly note: QueuedNote };

export type RecoveryResult = {
  /** Ready to enqueue, oldest first, so arrival order survives the restart. */
  readonly notes: readonly RecoveredNote[];
  /** Present and unread, but past the window. Left on disk for the purge. */
  readonly expired: number;
  /** Audio whose owning button could not be determined. Also left alone. */
  readonly unattributable: number;
};

export type RecoveryOptions = {
  readonly directory: string;
  readonly maxAgeMs?: number;
  /** Injectable so tests need no real waiting, matching `purgeExpiredAudio`. */
  readonly now?: () => number;
  /** Injectable so tests need no real ffprobe. */
  readonly probe?: (path: string) => Promise<number | null>;
};

/**
 * Scans `directory` for unread notes worth restoring.
 *
 * Never throws — a failure here must not stop the daemon booting, since the alternative to a
 * recovered queue is the empty one we had before. A missing directory is an empty one.
 *
 * Anything it cannot attribute to a button with certainty is skipped rather than guessed at.
 * A wrong guess would put one contact's voice on another contact's button, which is the one
 * outcome the whitelist exists to prevent, and it would arrive without any of the evidence
 * that produced it.
 */
export async function recoverUnplayedNotes(options: RecoveryOptions): Promise<RecoveryResult> {
  const maxAgeMs = options.maxAgeMs ?? RECOVERY_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const probe = options.probe ?? probeDurationMs;

  let entries: string[];
  try {
    entries = await readdir(options.directory);
  } catch {
    return { notes: [], expired: 0, unattributable: 0 };
  }

  const notes: RecoveredNote[] = [];
  let expired = 0;
  let unattributable = 0;

  for (const entry of entries) {
    const match = RECORDING_PATTERN.exec(entry);
    if (!match) {
      // Only count audio: a stray sound file or a partial download is not a lost note.
      if (entry.toLowerCase().endsWith('.ogg')) unattributable += 1;
      continue;
    }

    const path = join(options.directory, entry);
    let receivedAt: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      // mtime is when the download finished, which is when the note arrived.
      receivedAt = info.mtimeMs;
    } catch {
      continue;
    }

    if (now() - receivedAt > maxAgeMs) {
      expired += 1;
      continue;
    }

    const index = INDEX_BY_DIGIT[match[1] ?? ''];
    const messageId = match[2] ?? '';
    if (index === undefined || messageId.length === 0) {
      unattributable += 1;
      continue;
    }

    notes.push({
      index,
      // A recovered note is not a second-class one; it carries what a live note carries.
      note: { messageId, path, receivedAt, durationMs: await probe(path).catch(() => null) },
    });
  }

  notes.sort((a, b) => a.note.receivedAt - b.note.receivedAt);
  return { notes, expired, unattributable };
}
