/**
 * Turns a bouncing input line into settled changes.
 *
 * Measured on the reference board's arcade switches (2026-09-30): of 75 edge bursts in one bench
 * session, 42 bounced — up to 12 kernel edge events within 15 ms, the median burst over in 1 ms —
 * and 17 of those opened with the *opposite* edge to the one the press ended on, because that is
 * the order the contact happened to chatter in. Handing each edge straight to the interpreter
 * worked only because `ButtonInterpreter` ignores repeated downs and unmatched ups, with the
 * stuck-press watchdog behind it. That is tolerance, not debouncing.
 *
 * So the driver reports a change only once the line has been quiet for {@link BUTTON_SETTLE_MS},
 * and reports the level it **reads** then rather than any edge it saw: whatever order a burst came
 * in, one settled press produces one down and one up. A burst that ends where it started — a glitch,
 * or a press too short to settle — produces nothing.
 *
 * Debouncing belongs here, in the HAL, and not in opengpio: its own debounce option cannot be used
 * (2.0.2 transposes `debounce` and `bias`), and `debounceMs` in the interpreter measures how long a
 * press lasted, which it can only do once the contact chatter is gone.
 */

/**
 * How long a line must be quiet before its level counts. Above the longest burst measured (15 ms),
 * far below anything a child's press distinguishes (`debounceMs` is 60). `BUTTON_SETTLE_MS`
 * overrides it for bring-up on switches that chatter longer; 0 still coalesces edges that arrive
 * in the same tick.
 */
export const BUTTON_SETTLE_MS = parseSettleMs(process.env['BUTTON_SETTLE_MS'], 20);

export function parseSettleMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 200) {
    throw new Error(`BUTTON_SETTLE_MS must be a whole number of milliseconds from 0 to 200`);
  }
  return value;
}

export type SettledLineOptions = {
  /** The line's level when watching starts. */
  readonly initial: boolean;
  /** Reads the line's level now. May throw once the line is released; the last edge is used then. */
  readonly read: () => boolean;
  /** Called once per settled change, with the new level. */
  readonly onChange: (level: boolean) => void;
  readonly settleMs?: number;
};

export class SettledLine {
  readonly #read: () => boolean;
  readonly #onChange: (level: boolean) => void;
  readonly #settleMs: number;
  #level: boolean;
  #lastReported: boolean;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: SettledLineOptions) {
    this.#read = options.read;
    this.#onChange = options.onChange;
    this.#settleMs = options.settleMs ?? BUTTON_SETTLE_MS;
    this.#level = options.initial;
    this.#lastReported = options.initial;
  }

  /** The level last reported through `onChange` (or the initial one). */
  get level(): boolean {
    return this.#level;
  }

  /** An edge event arrived. `reported` is what it claimed; only a fallback if reading fails. */
  edge(reported: boolean): void {
    this.#lastReported = reported;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#settle();
    }, this.#settleMs);
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #settle(): void {
    let level: boolean;
    try {
      level = this.#read();
    } catch {
      level = this.#lastReported;
    }
    if (level === this.#level) return;
    this.#level = level;
    this.#onChange(level);
  }
}
