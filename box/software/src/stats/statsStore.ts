import { readFile } from 'node:fs/promises';
import * as z from 'zod';
import { writeFileAtomic } from '../config/atomicWrite.ts';
import type { ButtonIndex } from '../config/schema.ts';

/**
 * How much has been sent to and received from each button, kept across restarts.
 *
 * Deliberately **not** part of `config.json`. Two reasons, and either one on its own would be
 * enough: saving config restarts the daemon (see `docs/architecture.md`), so writing a counter
 * through it would reboot the box every time a child pressed a button; and a counter that fails
 * the config schema would drop the device into onboarding and cost a parent their contacts. A
 * corrupt stats file, by contrast, is allowed to mean nothing worse than "back to zero".
 *
 * On the card rather than in the tmpfs (`audio/directories.ts` has the full argument about the
 * two): the point of a total is that it survives the power cut, and unlike a voice note there is
 * nothing here anyone could listen to — three counts and three durations per button, and no
 * timestamps of individual messages.
 */

/** Where the totals live. Beside `config.json`, on the writable volume. */
export const DEFAULT_STATS_PATH = process.env['STATS_PATH'] ?? '/data/stats.json';

/**
 * How long a change waits before it is written.
 *
 * Every counted event is a button press, so they arrive in ones and twos — but a burst of
 * arriving notes is a real thing, and this is an SD card. Coalescing a burst into one write
 * costs nothing anybody can perceive and is the difference between one erase cycle and ten.
 */
export const STATS_FLUSH_DELAY_MS = 2000;

/** Schema version this module writes. Anything else is read as no file at all. */
export const STATS_VERSION = 1;

/** One button's running totals. */
export type ContactStats = {
  /** Voice notes this box sent to the contact, and how much audio that was. */
  readonly sentCount: number;
  readonly sentMs: number;
  /** Voice notes that arrived from the contact. `receivedMs` counts only notes WhatsApp gave a
   *  duration for, so it can lag `receivedCount` — `receivedTimedCount` says by how much. */
  readonly receivedCount: number;
  readonly receivedMs: number;
  readonly receivedTimedCount: number;
  /** Arrived notes the child has actually listened to. Never more than `receivedCount`. */
  readonly playedCount: number;
  /** Epoch ms of the last send and the last arrival, or null if there has not been one. */
  readonly lastSentAt: number | null;
  readonly lastReceivedAt: number | null;
};

export type StatsSnapshot = {
  /** When counting started — the first boot with a stats file, or the last reset. */
  readonly since: number;
  /** Index-aligned with the buttons, exactly like `unreadCounts`. */
  readonly contacts: readonly [ContactStats, ContactStats, ContactStats];
};

const EMPTY_CONTACT: ContactStats = {
  sentCount: 0,
  sentMs: 0,
  receivedCount: 0,
  receivedMs: 0,
  receivedTimedCount: 0,
  playedCount: 0,
  lastSentAt: null,
  lastReceivedAt: null,
};

/**
 * Every field carries `.catch()`, for the same reason `netState.ts` does: this document is a
 * convenience, and one wrong number must degrade to zero rather than throw away five right ones.
 * Only `version` is strict, because a document from a future schema cannot be reasoned about.
 */
const contactStatsSchema = z.object({
  sentCount: z.number().int().min(0).catch(0),
  sentMs: z.number().min(0).catch(0),
  receivedCount: z.number().int().min(0).catch(0),
  receivedMs: z.number().min(0).catch(0),
  receivedTimedCount: z.number().int().min(0).catch(0),
  playedCount: z.number().int().min(0).catch(0),
  lastSentAt: z.number().nullable().catch(null),
  lastReceivedAt: z.number().nullable().catch(null),
});

const statsDocumentSchema = z.object({
  version: z.literal(STATS_VERSION),
  since: z.number().catch(() => Date.now()),
  /*
   * A malformed list is not a malformed *file*: `since` is still worth keeping, and the
   * alternative is discarding a parent's whole history over one bad entry.
   */
  contacts: z
    .tuple([contactStatsSchema, contactStatsSchema, contactStatsSchema])
    .catch([EMPTY_CONTACT, EMPTY_CONTACT, EMPTY_CONTACT]),
});

export type StatsStoreOptions = {
  readonly path?: string;
  readonly flushDelayMs?: number;
  /** Injectable clock, so a test asserting on `lastSentAt` needs no real time. */
  readonly now?: () => number;
};

/**
 * The running totals, and the only thing that writes them.
 *
 * Records are synchronous and never reject: they are called from the device's interaction path,
 * where nothing may wait on a card and nothing may throw. The write happens later, coalesced,
 * and a failed one is dropped — losing a count is the correct trade against delaying a button.
 */
export class StatsStore {
  readonly #path: string;
  readonly #flushDelayMs: number;
  readonly #now: () => number;

  #contacts: [ContactStats, ContactStats, ContactStats] = [
    EMPTY_CONTACT,
    EMPTY_CONTACT,
    EMPTY_CONTACT,
  ];
  #since: number;
  #timer: NodeJS.Timeout | null = null;
  /**
   * The last write queued. Writes chain onto it, so two can never run at once, and each one
   * serialises the totals as they are when it *starts* — the latest, not a stale snapshot.
   */
  #writing: Promise<void> = Promise.resolve();
  #dirty = false;

  constructor(options: StatsStoreOptions = {}) {
    this.#path = options.path ?? DEFAULT_STATS_PATH;
    this.#flushDelayMs = options.flushDelayMs ?? STATS_FLUSH_DELAY_MS;
    this.#now = options.now ?? Date.now;
    this.#since = this.#now();
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Reads what is on disk, if anything trustworthy is.
   *
   * Never rejects. A missing file is the ordinary first-boot case, and an unreadable or
   * unparseable one means the counters start again — which is a cosmetic loss, unlike the same
   * failure in `config.json`.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const result = statsDocumentSchema.safeParse(parsed);
    if (!result.success) return;
    this.#since = result.data.since;
    this.#contacts = [result.data.contacts[0], result.data.contacts[1], result.data.contacts[2]];
  }

  snapshot(): StatsSnapshot {
    return { since: this.#since, contacts: [...this.#contacts] as const };
  }

  /** A voice note this box actually delivered. Failed sends are not counted. */
  recordSent(index: ButtonIndex, durationMs: number): void {
    const current = this.#contacts[index];
    this.#contacts[index] = {
      ...current,
      sentCount: current.sentCount + 1,
      sentMs: current.sentMs + Math.max(0, Math.round(durationMs)),
      lastSentAt: this.#now(),
    };
    this.#schedule();
  }

  /**
   * A voice note that arrived and was queued.
   *
   * `durationMs` is null when WhatsApp did not state one, which happens — so the duration and
   * the count are tracked separately rather than letting an unknown silently read as zero and
   * drag the average down.
   */
  recordReceived(index: ButtonIndex, durationMs: number | null): void {
    const current = this.#contacts[index];
    const timed = typeof durationMs === 'number' && Number.isFinite(durationMs);
    this.#contacts[index] = {
      ...current,
      receivedCount: current.receivedCount + 1,
      receivedMs: current.receivedMs + (timed ? Math.max(0, Math.round(durationMs)) : 0),
      receivedTimedCount: current.receivedTimedCount + (timed ? 1 : 0),
      lastReceivedAt: this.#now(),
    };
    this.#schedule();
  }

  /** Notes the child listened to, counted as a queue drains. */
  recordPlayed(index: ButtonIndex, count: number): void {
    if (count <= 0) return;
    const current = this.#contacts[index];
    this.#contacts[index] = { ...current, playedCount: current.playedCount + count };
    this.#schedule();
  }

  /** Back to zero, from now. Awaited, because the panel reports whether it worked. */
  async reset(): Promise<void> {
    this.#contacts = [EMPTY_CONTACT, EMPTY_CONTACT, EMPTY_CONTACT];
    this.#since = this.#now();
    this.#dirty = true;
    await this.flush();
  }

  /**
   * Writes now rather than on the timer.
   *
   * Called before anything that ends the process — a restart, a reboot, a shutdown — because
   * the whole point of the delay above is that the last few seconds are not yet on disk.
   */
  async flush(): Promise<void> {
    this.#clearTimer();
    /*
     * Queued synchronously, with no await first. The old version awaited the previous write
     * before checking `dirty`, so a second `flush()` arriving during the first saw `dirty`
     * already cleared and returned *before the first write had landed* — which let the
     * shutdown path exit mid-write. Every caller now waits for a write that covers what it
     * asked to be flushed, whether it queued that write or found it already queued.
     */
    if (this.#dirty) {
      this.#dirty = false;
      this.#writing = this.#writing.then(async () => this.#write());
    }
    await this.#writing;
  }

  /** Drops the pending write timer. The daemon's shutdown path calls `flush()` instead. */
  stop(): void {
    this.#clearTimer();
  }

  #schedule(): void {
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      // Detached on purpose: nothing upstream is waiting, and a card that will not take the
      // write must not turn into an unhandled rejection on a device with no screen.
      void this.flush();
    }, this.#flushDelayMs);
    // Never hold the event loop open for a counter.
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Atomic, exactly as `ConfigManager` writes config — see `config/atomicWrite.ts`.
   *
   * Less load-bearing than the config write — a half-written stats file only costs the totals —
   * but the same power cut hits both, and there is no reason for the cheap file to be the one
   * that leaves rubbish on the card.
   */
  async #write(): Promise<void> {
    const payload = `${JSON.stringify(
      { version: STATS_VERSION, since: this.#since, contacts: this.#contacts },
      null,
      2,
    )}\n`;
    try {
      await writeFileAtomic(this.#path, payload);
    } catch {
      /*
       * Swallowed by design: nothing the device does for a child depends on this file. But
       * marked dirty again, so the totals still on disk are not mistaken for current — the
       * next change, or the shutdown path's `flush()`, tries again.
       */
      this.#dirty = true;
    }
  }
}
