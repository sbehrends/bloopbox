/**
 * Holds items until a precondition has been met once, then hands them over in arrival order.
 *
 * The bridge needs it for exactly one reason. It starts with an empty whitelist, filled only when
 * the hardware server sends the contacts — but it connects to WhatsApp at the same time, and
 * WhatsApp flushes everything it queued while the box was off (`append`) right after the socket
 * opens. Those notes are already acknowledged upstream and are never delivered again, so judging
 * them against a whitelist that has not arrived yet drops them for good. That race runs on every
 * boot and on every config save, since both restart the hardware server.
 *
 * Holding is not admitting: every held item still goes through the whitelist, before download,
 * once it is released. Nothing reaches the disk earlier than it would have.
 */
export class HoldUntilReady<T> {
  readonly #handle: (item: T) => void;
  readonly #capacity: number;
  readonly #onOverflow: ((dropped: T) => void) | undefined;
  #held: T[] = [];
  #ready = false;

  constructor(options: {
    readonly handle: (item: T) => void;
    /** Bounded, so a hardware server that never answers cannot grow this without limit. */
    readonly capacity: number;
    readonly onOverflow?: (dropped: T) => void;
  }) {
    this.#handle = options.handle;
    this.#capacity = options.capacity;
    this.#onOverflow = options.onOverflow;
  }

  get ready(): boolean {
    return this.#ready;
  }

  get heldCount(): number {
    return this.#held.length;
  }

  /** Handles the item now if ready; otherwise holds it, dropping the oldest when full. */
  push(item: T): void {
    if (this.#ready) {
      this.#handle(item);
      return;
    }
    this.#held.push(item);
    while (this.#held.length > this.#capacity) {
      const dropped = this.#held.shift();
      if (dropped !== undefined) this.#onOverflow?.(dropped);
    }
  }

  /** Marks the precondition met and releases everything held, oldest first. Idempotent. */
  open(): void {
    if (this.#ready) return;
    this.#ready = true;
    const held = this.#held;
    this.#held = [];
    for (const item of held) this.#handle(item);
  }
}
