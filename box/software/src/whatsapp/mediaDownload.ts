import { createWriteStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'pino';
import { extractStatusCode } from './statusCode.ts';

/**
 * Turning an inbound voice note into a file on the card, without letting the sender decide how
 * much of the card it takes or how long it takes to arrive.
 *
 * The notes directory sits on the same card as `config.json` and the WhatsApp credentials, and
 * the size of a note is whatever the sender's client says it is. So a download is capped (before
 * it starts, on the declared size, and while it runs, on the bytes actually received), timed out,
 * retried a couple of times on a flaky network — and written beside its final name and renamed
 * into place only once it is complete and on disk. Boot recovery treats every `.ogg` in the
 * directory as an unread note, so a half-written one must never carry that name.
 */

/**
 * The largest voice note the box will store.
 *
 * WhatsApp's Opus voice notes run at roughly 16–32 kbit/s, so the 300 s the client already
 * refuses above (`MAX_INBOUND_SECONDS`) comes to about 1.2 MB at the top end. Twice what a
 * legitimate note can reach, and a small fraction of what is left on a card.
 */
export const MAX_INBOUND_BYTES = 2 * 1024 * 1024;

/** One attempt, from asking for the media to the last byte on disk. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Waits before the second and third attempts. Two retries, then the note is given up on. */
export const DOWNLOAD_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];

/** What a download is written as until it is complete. Not an extension anything else reads. */
export const PARTIAL_SUFFIX = '.part';

/** The sender's note is over `MAX_INBOUND_BYTES`, declared or delivered. Never retried. */
export class MediaTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(`voice note is over the ${String(MAX_INBOUND_BYTES)}-byte limit (${String(bytes)})`);
    this.name = 'MediaTooLargeError';
    this.bytes = bytes;
  }
}

/** A stream stage that passes bytes through until `limit` is exceeded, then fails the pipeline. */
export function byteLimit(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback): void {
      seen += chunk.length;
      if (seen > limit) {
        callback(new MediaTooLargeError(seen));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Whether another attempt could plausibly succeed.
 *
 * Not for a note that is too big — it will be too big again — nor for a 4xx from the media
 * server: Baileys already re-requests the media itself on the 404/410 that mean "expired", so
 * a 4xx that reaches here is a refusal. Everything else (a reset, a DNS failure, a 5xx, the
 * timeout) is the network, and worth a second go.
 */
export function isRetryableDownloadError(error: unknown): boolean {
  if (error instanceof MediaTooLargeError) return false;
  const status = extractStatusCode(error);
  return status === undefined || status < 400 || status >= 500;
}

export type DownloadToFileOptions = {
  /** Opens the decrypted media as a stream. Called once per attempt. */
  readonly openStream: () => Promise<Readable>;
  /** The final name. Nothing is ever written there except by the closing rename. */
  readonly path: string;
  readonly log: Logger;
  readonly maxBytes?: number;
  /** A fresh signal per attempt. Injectable so a test can time out without waiting. */
  readonly timeoutSignal?: () => AbortSignal;
  /** Injectable so a test's retries do not wait out real backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
};

const realSleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
};

/** Downloads to `path` via `path.part`, and returns how many bytes landed. */
export async function downloadToFile(options: DownloadToFileOptions): Promise<number> {
  const sleep = options.sleep ?? realSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await downloadOnce(options);
    } catch (error: unknown) {
      const delay = DOWNLOAD_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryableDownloadError(error)) throw error;
      options.log.warn({ err: error, attempt: attempt + 1, delayMs: delay }, 'retrying a download');
      await sleep(delay);
    }
  }
}

async function downloadOnce(options: DownloadToFileOptions): Promise<number> {
  const partial = `${options.path}${PARTIAL_SUFFIX}`;
  const signal = (options.timeoutSignal ?? (() => AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)))();
  try {
    // Baileys takes no signal for this, so the wait for the media server to answer is raced
    // against it here; the pipeline below is what the signal cancels once bytes are flowing.
    const stream = await untilAborted(options.openStream(), signal);
    await pipeline(
      stream,
      byteLimit(options.maxBytes ?? MAX_INBOUND_BYTES),
      createWriteStream(partial),
      { signal },
    );

    // On the card before it has the name recovery trusts: a power cut after the rename must not
    // find a name pointing at blocks the kernel never wrote.
    const handle = await open(partial, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    const { size } = await stat(partial);
    if (size === 0) throw new Error('downloaded voice note was empty');
    await rename(partial, options.path);
    return size;
  } catch (error: unknown) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * `promise`, unless `signal` aborts first. A stream that turns up after the abort is destroyed,
 * so its socket does not stay open behind a download that has already been given up on.
 */
async function untilAborted(promise: Promise<Readable>, signal: AbortSignal): Promise<Readable> {
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } catch (error: unknown) {
    promise.then(
      (stream) => stream.destroy(),
      () => undefined,
    );
    throw error;
  }
}
