import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Automatic storage purge (PRODUCT.md §8).
 *
 * Audio lives in a RAM disk on the device, so leaked files consume memory rather than
 * disk — on a 512 MB Pi Zero that matters. Anything older than the TTL is deleted whether
 * it was played or not, which also bounds how long a child's voice stays on the device.
 */

/** Files older than this are deleted. The spec's figure. */
export const AUDIO_TTL_MS = 48 * 60 * 60 * 1000;

/** How often the sweep runs. Frequent enough to bound growth, cheap enough to ignore. */
export const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Only audio artefacts, and the metadata that travels with them, are eligible; anything else in
 * the directory is left alone.
 *
 * `.ogg.part` is a download a power cut interrupted (`whatsapp/mediaDownload.ts`): nothing else
 * ever finishes it, and nothing else would ever delete it. `.key` is a note's read-receipt key
 * (`ipc/noteFiles.ts`), normally deleted when the receipt is sent; one whose receipt never went —
 * receipts turned off, a bridge that was down — goes on the same clock as the audio.
 */
const PURGEABLE_EXTENSIONS = [
  '.ogg',
  '.wav',
  '.webm',
  '.m4a',
  '.opus',
  '.ogg.part',
  '.key',
] as const;

export type PurgeResult = {
  readonly scanned: number;
  readonly deleted: readonly string[];
  readonly freedBytes: number;
  readonly errors: readonly { path: string; reason: string }[];
};

export type PurgeOptions = {
  readonly directory: string;
  readonly ttlMs?: number;
  /**
   * Files to keep regardless of age — notes still queued behind a blinking lamp.
   *
   * A function is asked afresh on every sweep. A plain set is a snapshot, which is what the
   * daemon used to pass: taken once at boot, before any note had arrived, so it protected
   * nothing and a note that was still blinking could be swept out from under the lamp.
   */
  readonly keep?: ReadonlySet<string> | (() => ReadonlySet<string>);
  /** Injectable clock, so tests need no real waiting. */
  readonly now?: () => number;
};

function isPurgeable(name: string): boolean {
  const lower = name.toLowerCase();
  return PURGEABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Deletes expired audio from `directory`.
 *
 * Never throws: a purge failure must not take the daemon down, so per-file errors are
 * collected and reported instead. A missing directory is treated as an empty one.
 */
export async function purgeExpiredAudio(options: PurgeOptions): Promise<PurgeResult> {
  const ttlMs = options.ttlMs ?? AUDIO_TTL_MS;
  const now = options.now ?? Date.now;
  const keep =
    typeof options.keep === 'function' ? options.keep() : (options.keep ?? new Set<string>());

  let entries: string[];
  try {
    entries = await readdir(options.directory);
  } catch {
    // Not yet created, or unreadable — nothing to purge either way.
    return { scanned: 0, deleted: [], freedBytes: 0, errors: [] };
  }

  const deleted: string[] = [];
  const errors: { path: string; reason: string }[] = [];
  let freedBytes = 0;
  let scanned = 0;
  const cutoff = now() - ttlMs;

  for (const name of entries) {
    if (!isPurgeable(name)) continue;

    const path = join(options.directory, name);
    if (keep.has(path)) continue;

    scanned += 1;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      // mtime, not atime: playing a note must not extend its lifetime.
      if (info.mtimeMs > cutoff) continue;

      await rm(path, { force: true });
      deleted.push(path);
      freedBytes += info.size;
    } catch (error: unknown) {
      errors.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { scanned, deleted, freedBytes, errors };
}

/**
 * Runs {@link purgeExpiredAudio} on an interval.
 *
 * The first sweep happens immediately at start: the device may have been powered off for
 * days, so expired files from the previous run should go straight away.
 */
export class AudioPurger {
  readonly #options: PurgeOptions;
  readonly #intervalMs: number;
  readonly #onResult: ((result: PurgeResult) => void) | undefined;
  #timer: NodeJS.Timeout | null = null;
  /** The sweep currently running, if any — see {@link whenIdle}. */
  #inFlight: Promise<PurgeResult> | null = null;

  constructor(
    options: PurgeOptions & {
      readonly intervalMs?: number;
      readonly onResult?: (result: PurgeResult) => void;
    },
  ) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? PURGE_INTERVAL_MS;
    this.#onResult = options.onResult;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer !== null) return;

    this.#timer = setInterval(() => {
      void this.runOnce();
    }, this.#intervalMs);
    // Housekeeping must never hold the process open.
    this.#timer.unref();

    void this.runOnce();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Resolves once no sweep is in flight.
   *
   * Sweeps are started fire-and-forget from a timer, so callers that need to observe the
   * outcome — a clean shutdown, or a test — have no other way to wait for the filesystem
   * work to finish.
   */
  async whenIdle(): Promise<void> {
    /*
     * `runOnce` registered its own continuation on this promise first, so its `finally`
     * (which clears #inFlight) runs before we resume. The loop then only repeats if the
     * interval started a fresh sweep in the meantime.
     */
    while (this.#inFlight) {
      await this.#inFlight.catch(() => undefined);
    }
  }

  /** Runs one sweep now. Exposed for the admin UI and tests. */
  async runOnce(): Promise<PurgeResult> {
    const sweep = this.#sweep();
    this.#inFlight = sweep;
    try {
      return await sweep;
    } finally {
      if (this.#inFlight === sweep) this.#inFlight = null;
    }
  }

  async #sweep(): Promise<PurgeResult> {
    const result = await purgeExpiredAudio(this.#options);
    if (result.deleted.length > 0 || result.errors.length > 0) {
      this.#onResult?.(result);
    }
    return result;
  }
}
