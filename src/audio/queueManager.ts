import { EventEmitter } from 'node:events';
import { AudioCue } from './cues.ts';
import type { ButtonIndex } from '../config/schema.ts';
import type { Hal } from '../hal/types.ts';

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
  /** Playback was interrupted before finishing. */
  playbackAborted: [{ index: ButtonIndex; remaining: number }];
};

export type QueueManagerOptions = {
  readonly hal: Hal;
  /** Whether to play the separator chime. False during silent mode. */
  readonly playCues: () => boolean;
};

export class AudioQueueManager extends EventEmitter<QueueEvents> {
  readonly #hal: Hal;
  readonly #playCues: () => boolean;
  /** Pending notes per button, oldest first. */
  readonly #queues: [QueuedNote[], QueuedNote[], QueuedNote[]] = [[], [], []];
  #playing: ButtonIndex | null = null;
  #abort = false;

  constructor(options: QueueManagerOptions) {
    super();
    this.#hal = options.hal;
    this.#playCues = options.playCues;
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
  enqueue(index: ButtonIndex, note: QueuedNote): void {
    // Ignore duplicates: WhatsApp can redeliver the same message id.
    if (this.#queues[index].some((queued) => queued.messageId === note.messageId)) return;
    this.#queues[index].push(note);
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
    this.emit('playbackStarted', { index, count: batch.length });

    const played: string[] = [];

    try {
      for (const [position, note] of batch.entries()) {
        if (this.#shouldAbort()) {
          // Put the unplayed remainder back at the front, preserving order.
          const remaining = batch.slice(position);
          this.#queues[index].unshift(...remaining);
          this.emit('playbackAborted', { index, remaining: remaining.length });
          return;
        }

        // A chime between notes so a child can tell one message from the next.
        if (position > 0 && this.#playCues()) {
          await this.#safePlayCue(AudioCue.Chime);
        }

        this.emit('noteStarted', {
          index,
          messageId: note.messageId,
          position: position + 1,
          count: batch.length,
        });

        const ok = await this.#safePlay(note.path);
        played.push(note.messageId);
        this.emit('noteFinished', { index, messageId: note.messageId, ok });
      }

      this.emit('queueDrained', { index, messageIds: played });
    } finally {
      this.#playing = null;
      this.#abort = false;
    }
  }

  /**
   * Interrupts playback. The current note finishes its `play()` call, then the loop stops
   * and returns the remainder to the queue.
   */
  async stop(): Promise<void> {
    if (this.#playing === null) return;
    this.#abort = true;
    await this.#hal.stopPlayback();
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
   * skipped so the remaining messages still play.
   */
  async #safePlay(path: string): Promise<boolean> {
    try {
      await this.#hal.play(path);
      return true;
    } catch {
      return false;
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
