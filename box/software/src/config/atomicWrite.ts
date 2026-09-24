import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Replaces a file's contents so that a power cut leaves either the old file or the new one,
 * never a mixture. Used for `config.json` and `stats.json` on the card.
 *
 * Four steps, each for a failure that has a name:
 *
 *  1. **A temp file named for this write alone** — pid plus a random id. With one fixed
 *     `.tmp` name, two saves in flight at once (two browser tabs) truncated each other's temp
 *     file, and the loser could rename a half-written one into place.
 *  2. **fsync the contents**, or the rename can reach the disk before the data does.
 *  3. **rename over the target**, which is atomic within one filesystem — hence the temp file
 *     sits beside the target, not in `/tmp`.
 *  4. **fsync the directory.** The rename is an entry in the directory, and until the directory
 *     itself is flushed a power cut can bring back the old entry — a save the admin panel
 *     reported as done, silently undone at the next boot.
 *
 * On any failure the temp file is removed, so a card that refuses writes does not slowly fill
 * with orphans. Rejects with the original error.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  const tempPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    // `wx`: a name this write just invented must not exist; if it does, something is wrong.
    const handle = await open(tempPath, 'wx');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
  } catch (error: unknown) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  await syncDirectory(directory);
}

/**
 * Flushes a directory's entries to disk. Best effort: some filesystems refuse to fsync a
 * directory (EINVAL, EISDIR on a few), and by this point the rename has already happened — the
 * new file is in place either way, only its durability across a power cut is at stake.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // See above: not a reason to report a completed write as failed.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Runs async work one call at a time, in call order.
 *
 * A failure is handed to that call's own caller and does not stop the next one: the queue
 * waits for a predecessor to *settle*, not to succeed.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
