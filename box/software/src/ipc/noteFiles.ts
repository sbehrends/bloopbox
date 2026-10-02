import type { ButtonIndex } from '../config/schema.ts';

/**
 * How an inbound note is named on the card: the one file-system contract between the two daemons.
 *
 * The WhatsApp bridge writes `wa-<index>-<messageId>.ogg` into the notes directory; the hardware
 * server checks the path the bridge reports against the same name, and after a restart rebuilds
 * the unread queue from those names alone (`audio/recovery.ts`). Here, beside the Socket.io event
 * maps, rather than in `audio/`: the bridge needs the name and nothing else of the audio code, and
 * importing it from there pulled the ffprobe wrapper and, for types, the HAL into the process that
 * must never touch either.
 */

/**
 * How far back a restart may reach.
 *
 * A product decision, not a technical limit: a note from this morning is still worth hearing
 * when the box comes back, and one from yesterday is a confusing thing to hand a small child
 * who has no way to know it is old. Deliberately far below `AUDIO_TTL_MS` (48 h), which
 * bounds how long audio may *exist*, not how long it stays worth playing. Both daemons apply it:
 * the hardware server to what it recovers, the bridge to notes WhatsApp delivers late.
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
 * `wa-<index>-<messageId>.key`: the WhatsApp message key a note needs to be marked read, beside the
 * note itself so it survives a bridge restart. The bridge deletes it once the receipt is sent or the
 * note is revoked; otherwise the purge takes it with the audio, on the same 48 h clock.
 */
export function readKeyName(index: ButtonIndex, messageId: string): string {
  return recordingName(index, messageId).replace(/\.ogg$/, '.key');
}

/** The inverse of {@link recordingName}. Notes written before the index was encoded do not match. */
const RECORDING_PATTERN = /^wa-([0-2])-([A-Za-z0-9_-]{1,128})\.ogg$/;

/** An explicit map rather than a cast, so the digit narrows to a real index or to nothing. */
const INDEX_BY_DIGIT: Readonly<Record<string, ButtonIndex>> = { '0': 0, '1': 1, '2': 2 };

export function parseRecordingName(
  name: string,
): { readonly index: ButtonIndex; readonly messageId: string } | null {
  const match = RECORDING_PATTERN.exec(name);
  const index = INDEX_BY_DIGIT[match?.[1] ?? ''];
  const messageId = match?.[2];
  return index === undefined || messageId === undefined ? null : { index, messageId };
}
