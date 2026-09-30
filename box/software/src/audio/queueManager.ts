import { EventEmitter } from 'node:events';
import { AudioCue } from './cues.ts';
import type { ButtonIndex } from '../config/schema.ts';
import type { Hal, PlaybackOutcome } from '../hal/types.ts';

/**
 * Sequential playback of received voice notes (PRODUCT.md §1, §5).
 *
 * One tap plays everything waiting from that contact, in arrival order, separated by a
 * soft chime. The LED clears only once the queue drains.
 *
 * Playback is never suppressed by silent mode — tapping a blinking button always plays at
 * the configured volume (PRODUCT.md §7). Only the *cues* are gated, and the caller decides
 * that via `playCues`.
 */

export type QueuedNote = {
  readonly messageId: string;
  /** File in the RAM disk. */
  readonly path: string;
  readonly receivedAt: number;
  readonly durationMs: number | null;
};

export type QueueEvents = {
  /** A queue started playing. */
  playbackStarted: [{ index: ButtonIndex; count: number }];
  /** One note began. */
  noteStarted: [{ index: ButtonIndex; messageId: string; position: number; count: number }];
  /** One note finished (or failed and was skipped). */
  noteFinished: [{ index: ButtonIndex; messageId: string; ok: boolean }];
  /**
   * Everything queued at tap time has played. Carries the message ids so the caller can
   * mark them read upstream and delete the files.
   */
  queueDrained: [{ index: ButtonIndex; messageIds: readonly string[] }];
  /**
   * Playback stopped before the end — a `stop()`, or a sound that cut a note off.
   *
   * `messageIds` are the notes heard to the end before that, which the caller treats exactly as
   * it treats a drained queue: they were heard. Everything else, the interrupted note included,
   * is back at the front of the queue, still unread. Losing either half was a bug: heard notes
   * reappeared as unread after a restart, and a cut-off note was deleted as if heard.
   */
  playbackAborted: [{ index: ButtonIndex; messageIds: readonly string[]; remaining: number }];
};

export type QueueManagerOptions = {
  readonly hal: Hal;
  /** Whether to play the separator chime. False during silent mode. */
  readonly playCues: () => boolean;
  /**
   * Told when a note fails to play outright — the note is still skipped, so the rest of the queue
   * plays, but the reason is no longer thrown away. Must not throw.
   */
  readonly onPlaybackError?: (index: ButtonIndex, path: string, error: unknown) => void;
};

export class AudioQueueManager extends EventEmitter<QueueEvents> {
  readonly #hal: Hal;
  readonly #playCues: () => boolean;
  readonly #onPlaybackError:
    ((index: ButtonIndex, path: string, error: unknown) => void) | undefined;
  /** Pending notes per button, oldest first. */
  readonly #queues: [QueuedNote[], QueuedNote[], QueuedNote[]] = [[], [], []];
  #playing: ButtonIndex | null = null;
  #abort = false;
  /**
   * The run `playQueue` took off the front of a queue, while it plays.
   *
   * Those notes are out of `#queues` for the duration, so `remove` has to look here too, or a
   * note deleted for everyone would still be played if it was merely later in the same run.
   * `started` is every note that has begun, which `remove` leaves alone; `removed` is what the
   * loop skips.
   */
  #run: {
    readonly index: ButtonIndex;
    readonly notes: readonly QueuedNote[];
    readonly started: Set<string>;
    readonly removed: Set<string>;
  } | null = null;

  constructor(options: QueueManagerOptions) {
    super();
    this.#hal = options.hal;
    this.#playCues = options.playCues;
    this.#onPlaybackError = options.onPlaybackError;
  }

  /** Which contact is currently playing, if any. */
  get playing(): ButtonIndex | null {
    return this.#playing;
  }

  count(index: ButtonIndex): number {
    return this.#queues[index].length;
  }

  get totalCount(): number {
    return this.#queues[0].length + this.#queues[1].length + this.#queues[2].length;
  }

  /** Read-only view of what is waiting, for the admin UI. */
  peek(index: ButtonIndex): readonly QueuedNote[] {
    return [...this.#queues[index]];
  }

  /** Adds a newly received note to the back of the queue. */
  /**
   * Adds a note to a contact's queue. Returns false if it was already there.
   *
   * The answer matters to the caller, not just to this queue: the unread count and the notify
   * cue are the caller's, and both would otherwise fire for a note the child cannot hear
   * twice. WhatsApp redelivers message ids on its own, and since boot recovery a note can
   * legitimately reach the queue by two routes at once — restored from disk, then delivered
   * again by a bridge flushing what it buffered while the daemon was down.
   */
  enqueue(index: ButtonIndex, note: QueuedNote): boolean {
    if (this.#queues[index].some((queued) => queued.messageId === note.messageId)) return false;
    this.#queues[index].push(note);
    return true;
  }

  /**
   * Plays everything queued for this contact, in order.
   *
   * The queue is snapshotted at tap time: notes arriving mid-playback stay pending and
   * re-light the LED, rather than extending the current run indefinitely. That keeps
   * playback bounded and makes a new arrival visible.
   */
  async playQueue(index: ButtonIndex): Promise<void> {
    if (this.#playing !== null) return; // Already playing something.

    const batch = this.#queues[index].splice(0, this.#queues[index].length);
    if (batch.length === 0) return;

    this.#playing = index;
    this.#abort = false;
    const run = { index, notes: batch, started: new Set<string>(), removed: new Set<string>() };
    this.#run = run;
    this.emit('playbackStarted', { index, count: batch.length });

    const played: string[] = [];
    /** Puts `batch[position]` onward back at the front, in order, and reports the stop. */
    const abortFrom = (position: number): void => {
      const remaining = batch.slice(position).filter((note) => !run.removed.has(note.messageId));
      this.#queues[index].unshift(...remaining);
      this.emit('playbackAborted', { index, messageIds: played, remaining: remaining.length });
    };

    try {
      for (const [position, note] of batch.entries()) {
        if (this.#shouldAbort()) {
          abortFrom(position);
          return;
        }
        // Deleted by its sender while it waited its turn: not played, and no chime for it.
        if (run.removed.has(note.messageId)) continue;

        // A chime between notes so a child can tell one message from the next.
        if (position > 0 && this.#playCues()) {
          await this.#safePlayCue(AudioCue.Chime);
          // Asked again: a stop that landed during the chime killed only the chime, and the
          // next note would otherwise play in full over whatever the stop was for.
          if (this.#shouldAbort()) {
            abortFrom(position);
            return;
          }
        }

        // Asked a third time: a revoke can land during the chime too.
        if (run.removed.has(note.messageId)) continue;
        run.started.add(note.messageId);
        this.emit('noteStarted', {
          index,
          messageId: note.messageId,
          position: position + 1,
          count: batch.length,
        });

        const outcome = await this.#safePlay(index, note.path);
        this.emit('noteFinished', { index, messageId: note.messageId, ok: outcome !== 'failed' });

        // Cut off part-way: not heard, so back it goes, with everything after it.
        if (outcome === 'interrupted') {
          abortFrom(position);
          return;
        }
        played.push(note.messageId);
      }

      this.emit('queueDrained', { index, messageIds: played });
    } finally {
      this.#playing = null;
      this.#abort = false;
      this.#run = null;
    }
  }

  /**
   * Interrupts playback. The current note is cut off, and it and the rest go back to the queue.
   */
  async stop(): Promise<void> {
    if (this.#playing === null) return;
    this.#abort = true;
    await this.#hal.stopPlayback();
  }

  /**
   * Takes one note out of a contact's queue, returning it for cleanup, or null if it is not
   * there to take.
   *
   * For "delete for everyone". A note still waiting — in the queue, or later in a run that is
   * playing — is removed. **A note that has started playing is left alone**: it is already
   * coming out of the speaker, cutting it off mid-word would be a stranger thing for a child
   * than hearing the end of it, and once it finishes it is deleted as heard anyway.
   */
  remove(index: ButtonIndex, messageId: string): QueuedNote | null {
    const queue = this.#queues[index];
    const at = queue.findIndex((note) => note.messageId === messageId);
    if (at !== -1) return queue.splice(at, 1)[0] ?? null;

    const run = this.#run;
    if (run?.index !== index || run.started.has(messageId) || run.removed.has(messageId)) {
      return null;
    }
    const note = run.notes.find((candidate) => candidate.messageId === messageId);
    if (note === undefined) return null;
    run.removed.add(messageId);
    return note;
  }

  /** Drops everything queued for a contact, returning the removed notes for cleanup. */
  clear(index: ButtonIndex): QueuedNote[] {
    return this.#queues[index].splice(0, this.#queues[index].length);
  }

  /** Drops every queue. Used on factory reset and contact reassignment. */
  clearAll(): QueuedNote[] {
    const indices: readonly ButtonIndex[] = [0, 1, 2];
    return indices.flatMap((index) => this.clear(index));
  }

  /**
   * Read through a method so TypeScript cannot narrow `#abort` to its initial value —
   * `stop()` mutates it while the playback loop is suspended on an await.
   */
  #shouldAbort(): boolean {
    return this.#abort;
  }

  /**
   * A failed clip must not strand the rest of the queue — a missing or corrupt file is
   * skipped so the remaining messages still play, and it is counted with the played ones: a file
   * that cannot be played will not become playable by blinking at the child until the purge.
   * An *interruption* is different, and is reported as one: the note was fine, it was cut off.
   */
  async #safePlay(index: ButtonIndex, path: string): Promise<PlaybackOutcome | 'failed'> {
    try {
      return await this.#hal.play(path);
    } catch (error: unknown) {
      try {
        this.#onPlaybackError?.(index, path, error);
      } catch {
        // A reporter that throws must not strand the rest of the queue.
      }
      return 'failed';
    }
  }

  async #safePlayCue(cue: AudioCue): Promise<void> {
    try {
      await this.#hal.playCue(cue);
    } catch {
      // A missing cue file is cosmetic; never let it break playback.
    }
  }
}
