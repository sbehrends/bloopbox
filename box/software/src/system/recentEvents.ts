/**
 * The last few warnings and errors the hardware server logged, kept in memory for the admin panel.
 *
 * The journal is the real record, and it needs ssh: the one tool a parent does not have. When the
 * box gives an "oops" and nothing else, this is the post-mortem they can reach — the health card
 * lists these, newest first, as `GET /api/system/events` returns them.
 *
 * In memory on purpose. It empties on every restart, which is also every settings save; what it
 * is for is "what went wrong just now", and a store on the card would add writes for a reading
 * the journal already keeps.
 */

export type RecentEvent = {
  readonly atMs: number;
  readonly level: 'warn' | 'error' | 'fatal';
  readonly message: string;
  /** Small facts from the log line: its subsystem, a fault kind, a button. Primitives only. */
  readonly fields: Readonly<Record<string, string | number | boolean>>;
};

/** Enough for "what happened in the last hour" on a box that is mostly quiet. */
export const RECENT_EVENTS_CAPACITY = 50;
/** Per field, and per message: a reading for a person, not a log shipper. */
const MAX_TEXT = 200;
const MAX_FIELDS = 10;

/** pino's numeric levels. */
const LEVEL_NAMES: ReadonlyMap<number, RecentEvent['level']> = new Map([
  [40, 'warn'],
  [50, 'error'],
  [60, 'fatal'],
]);

const clip = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;

export class RecentEvents {
  readonly #capacity: number;
  readonly #events: RecentEvent[] = [];

  constructor(capacity = RECENT_EVENTS_CAPACITY) {
    this.#capacity = capacity;
  }

  /**
   * Records one log call, if it is a warning or worse. `args` is what was passed to the log
   * method — `(object, message)` or `(message)` — and `bindings` the child logger's own fields.
   *
   * Only primitive fields are kept, clipped, and an `err` becomes its message: a full error, or a
   * payload someone logged by accident, has no business in a list a browser fetches.
   */
  record(level: number, args: readonly unknown[], bindings: object, atMs = Date.now()): void {
    const name = LEVEL_NAMES.get(level);
    if (name === undefined) return;

    const [first, second] = args;
    const object = typeof first === 'object' && first !== null ? first : {};
    const message = typeof first === 'string' ? first : typeof second === 'string' ? second : '';

    const fields: Record<string, string | number | boolean> = {};
    for (const [key, value] of [...Object.entries(bindings), ...Object.entries(object)]) {
      if (Object.keys(fields).length >= MAX_FIELDS) break;
      if (key === 'err' || key === 'error') {
        if (value instanceof Error) fields['error'] = clip(value.message);
      } else if (typeof value === 'string') {
        fields[key] = clip(value);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        fields[key] = value;
      }
    }

    this.#events.push({ atMs, level: name, message: clip(message), fields });
    if (this.#events.length > this.#capacity) this.#events.shift();
  }

  /** Newest first. */
  list(): readonly RecentEvent[] {
    return this.#events.toReversed();
  }
}
