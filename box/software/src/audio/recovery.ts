import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { probeDurationMs } from './ffmpeg.ts';
import type { QueuedNote } from './queueManager.ts';
import type { ButtonIndex } from '../config/schema.ts';
import {
  isSafeMessageId,
  parseRecordingName,
  RECOVERY_MAX_AGE_MS,
  recordingName,
} from '../ipc/noteFiles.ts';

/**
 * Rebuilding the unread queue after a restart.
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
 * encodes it in the name — see `recordingName` in `ipc/noteFiles.ts`.
 */

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
    const named = parseRecordingName(entry);
    if (!named) {
      // Only count audio: a stray sound file or a partial download is not a lost note.
      if (entry.toLowerCase().endsWith('.ogg')) unattributable += 1;
      continue;
    }

    const path = join(options.directory, entry);
    let receivedAt: number;
    try {
      const info = await stat(path);
      /*
       * Empty is not a note. Downloads are renamed into place only once complete and synced, so
       * this should not happen — but a file from before that rule, or a card that lost blocks,
       * would otherwise light a lamp for a tap that plays nothing. Left for the purge.
       */
      if (!info.isFile() || info.size === 0) continue;
      // mtime is when the download finished, which is when the note arrived.
      receivedAt = info.mtimeMs;
    } catch {
      continue;
    }

    if (now() - receivedAt > maxAgeMs) {
      expired += 1;
      continue;
    }

    const { index, messageId } = named;
    notes.push({
      index,
      // A recovered note is not a second-class one; it carries what a live note carries.
      note: { messageId, path, receivedAt, durationMs: await probe(path).catch(() => null) },
    });
  }

  notes.sort((a, b) => a.note.receivedAt - b.note.receivedAt);
  return { notes, expired, unattributable };
}
