/**
 * Where audio lives, and why the two directions do not share a directory.
 *
 * Both daemons resolve these here rather than each reading `process.env` for itself. The
 * failure mode that motivated it is silent and total: the bridge writes an arriving note to
 * one path while the hardware server scans another, so nothing is ever played, nothing is
 * ever recovered, and no error is produced anywhere — the lamp simply never blinks.
 */

/**
 * Outbound captures and every derived file. **RAM, wiped by a power cut, and that is the point.**
 *
 * A child's own voice is recorded here, encoded, sent, and deleted. It is never at rest for
 * longer than one message takes to send, so there is nothing to protect on a card somebody
 * could walk off with. Decoded playback WAVs (`play-*.wav`) also land here, derived from notes
 * that live elsewhere — they are regenerable, several times the size of their source, and
 * would otherwise be the bulk of what a persistent directory accumulated.
 */
export const DEFAULT_RECORDING_DIR = '/run/bloopbox';

/**
 * Inbound voice notes. **The SD card, so they survive being unplugged.**
 *
 * This was `/run/bloopbox` too until 2026-09-06, when a note arrived, the lamp blinked, the
 * power went out, and the note was gone. That is not an edge case: someone unplugging the box
 * is the most likely restart in a child's room, and the note is unrecoverable afterwards —
 * WhatsApp will not re-deliver a message it has already handed over.
 *
 * The reason it hurts so much is that playback *deletes* a note's file, which makes "present
 * on disk" the unread flag itself. There is no second read-state store to fall back on: the
 * directory is the entire ledger, so putting it in RAM lost the audio and the knowledge that
 * it had ever existed, together.
 *
 * The privacy cost is real and was weighed rather than waved through. `/data` already holds
 * `auth_info`, the linked WhatsApp session — anyone who can take the card can already speak as
 * this account, which is strictly worse than reading one voice note. Against that, notes here
 * are deleted the moment they are played and swept at 48 h regardless, and the child's own
 * recordings never arrive at all. The promise that changed is "no audio is ever at rest"; the
 * promise kept is "nothing the child records is ever at rest".
 */
export const DEFAULT_NOTES_DIR = '/data/notes';

/** Outbound captures and derived WAVs. Override with `RECORDING_DIR`. */
export function recordingDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env['RECORDING_DIR'] ?? DEFAULT_RECORDING_DIR;
}

/**
 * Inbound notes. Override with `NOTES_DIR`.
 *
 * **Deliberately does not fall back to `RECORDING_DIR`**, tempting as that looks for a box
 * installed before the split. `/etc/bloopbox/environment` already sets `RECORDING_DIR`, and an
 * upgrade *keeps that file* — so a fallback would quietly resolve every existing device back to
 * the tmpfs and the fix would land nowhere it was needed, with the tests still green because a
 * test harness sets both. The default is what makes an upgrade take effect on its own;
 * `ReadWritePaths=/data` is already in both units, so the sandbox allows it with no unit change.
 *
 * The cost is that anything running off-device has to set this — `/data` does not exist on a
 * development machine. `scripts/dev-server.ts` does, next to `CONFIG_PATH`.
 */
export function notesDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env['NOTES_DIR'] ?? DEFAULT_NOTES_DIR;
}
