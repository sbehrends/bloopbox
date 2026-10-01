import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  byteLimit,
  DOWNLOAD_RETRY_DELAYS_MS,
  downloadToFile,
  isRetryableDownloadError,
  MAX_INBOUND_BYTES,
  MediaTooLargeError,
} from '../whatsapp/mediaDownload.ts';

/**
 * Inbound downloads onto the card: capped, timed out, retried, and never visible under their
 * final name until complete. Real files, fake streams; every wait is injected, so nothing sleeps.
 */

const silentLogger = pino({ level: 'silent' });

let directory: string;
let path: string;
let sleeps: number[];

const sleep = (ms: number): Promise<void> => {
  sleeps.push(ms);
  return Promise.resolve();
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bloopbox-dl-'));
  path = join(directory, 'wa-0-ABC.ogg');
  sleeps = [];
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function bytes(count: number): Readable {
  return Readable.from([Buffer.alloc(count, 1)]);
}

function withStatus(statusCode: number): Error {
  return Object.assign(new Error('http'), { output: { statusCode } });
}

function networkError(): Error {
  return Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
}

describe('downloadToFile', () => {
  it('lands the whole note under its final name, and nothing else', async () => {
    const size = await downloadToFile({
      path,
      log: silentLogger,
      sleep,
      openStream: () => Promise.resolve(Readable.from([Buffer.from('opus-bytes')])),
    });

    expect(size).toBe(10);
    expect(await readFile(path, 'utf8')).toBe('opus-bytes');
    expect(await readdir(directory)).toEqual(['wa-0-ABC.ogg']);
  });

  it('refuses a note that turns out bigger than the cap, and does not retry it', async () => {
    const openStream = vi.fn<() => Promise<Readable>>(() =>
      Promise.resolve(bytes(MAX_INBOUND_BYTES + 1)),
    );

    await expect(
      downloadToFile({ path, log: silentLogger, sleep, openStream }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);

    expect(openStream).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it('accepts a note exactly at the cap', async () => {
    const size = await downloadToFile({
      path,
      log: silentLogger,
      sleep,
      openStream: () => Promise.resolve(bytes(MAX_INBOUND_BYTES)),
    });

    expect(size).toBe(MAX_INBOUND_BYTES);
  });

  it('retries a network failure with the declared backoff', async () => {
    const openStream = vi
      .fn<() => Promise<Readable>>()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(bytes(5));

    await expect(downloadToFile({ path, log: silentLogger, sleep, openStream })).resolves.toBe(5);

    expect(openStream).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([...DOWNLOAD_RETRY_DELAYS_MS]);
  });

  it('gives up after the last retry', async () => {
    const openStream = vi.fn<() => Promise<Readable>>(() => Promise.reject(networkError()));

    await expect(downloadToFile({ path, log: silentLogger, sleep, openStream })).rejects.toThrow(
      'ECONNRESET',
    );

    expect(openStream).toHaveBeenCalledTimes(DOWNLOAD_RETRY_DELAYS_MS.length + 1);
    expect(await readdir(directory)).toEqual([]);
  });

  it('times out a media server that never answers', async () => {
    const controller = new AbortController();
    const pending = downloadToFile({
      path,
      log: silentLogger,
      sleep,
      timeoutSignal: () => controller.signal,
      openStream: () => new Promise<Readable>(() => undefined),
    });

    controller.abort(new Error('timed out'));

    await expect(pending).rejects.toThrow('timed out');
    expect(await readdir(directory)).toEqual([]);
  });

  it('times out a body that stalls half-way, and leaves no partial file behind', async () => {
    const controllers: AbortController[] = [];
    const stalled = new PassThrough();
    stalled.write(Buffer.from('half a note'));

    const pending = downloadToFile({
      path,
      log: silentLogger,
      sleep,
      timeoutSignal: () => {
        const controller = new AbortController();
        controllers.push(controller);
        // Every attempt after the first is told at once that it has run out of time.
        if (controllers.length > 1) controller.abort(new Error('timed out'));
        return controller.signal;
      },
      openStream: () => Promise.resolve(stalled),
    });

    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    controllers[0]?.abort(new Error('timed out'));

    // The pipeline reports its own AbortError, with the signal's reason as the cause.
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(controllers).toHaveLength(DOWNLOAD_RETRY_DELAYS_MS.length + 1);
    expect(await readdir(directory)).toEqual([]);
  });

  it('treats an empty body as a failure, not a note', async () => {
    await expect(
      downloadToFile({
        path,
        log: silentLogger,
        sleep,
        openStream: () => Promise.resolve(Readable.from([])),
      }),
    ).rejects.toThrow(/empty/);

    expect(await readdir(directory)).toEqual([]);
  });
});

describe('isRetryableDownloadError', () => {
  it('retries the network and the server, not a refusal or an oversized note', () => {
    expect(isRetryableDownloadError(networkError())).toBe(true);
    expect(isRetryableDownloadError(withStatus(503))).toBe(true);
    expect(isRetryableDownloadError(withStatus(403))).toBe(false);
    expect(isRetryableDownloadError(new MediaTooLargeError(3_000_000))).toBe(false);
  });
});

describe('byteLimit', () => {
  it('passes bytes through up to the limit', async () => {
    const chunks: Buffer[] = [];
    const limit = byteLimit(4);
    limit.on('data', (chunk: Buffer) => chunks.push(chunk));
    limit.end(Buffer.from('four'));
    await new Promise((resolve) => limit.on('end', resolve));

    expect(Buffer.concat(chunks).toString()).toBe('four');
  });
});
