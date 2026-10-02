import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';
import { writeFileAtomic } from '../config/atomicWrite.ts';

/**
 * Baileys' `useMultiFileAuthState`, with every write made atomic.
 *
 * Baileys writes `creds.json` with a plain `writeFile`, which truncates the file before it fills
 * it. A box that loses power in that window — a child pulling the plug, a power cut — boots with
 * an empty or half-written file, Baileys reads it as no credentials at all, and starts over with a
 * fresh identity: the box is silently unlinked from WhatsApp and needs a parent to pair it again.
 * Here every file goes through `writeFileAtomic` (temp file, fsync, rename, fsync the directory),
 * so a power cut leaves the old credentials or the new ones, never neither.
 *
 * Otherwise the same as Baileys' own: one JSON file per key in one directory, the same file names
 * (so a box that paired before this switch keeps its session), and writes to one file serialised,
 * so two quick updates cannot land in the wrong order.
 */
export async function useDurableAuthState(
  directory: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const info = await stat(directory).catch(() => null);
  if (info === null) {
    await mkdir(directory, { recursive: true });
  } else if (!info.isDirectory()) {
    throw new Error(`${directory} is not a directory, so it cannot hold WhatsApp credentials`);
  }

  /** The last operation queued on each file, so the next waits for it. */
  const queues = new Map<string, Promise<unknown>>();
  const serialised = <T>(file: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(file) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    queues.set(
      file,
      next.catch(() => undefined),
    );
    return next;
  };

  const pathOf = (file: string): string =>
    join(directory, file.replaceAll('/', '__').replaceAll(':', '-'));

  const write = (file: string, data: unknown): Promise<void> =>
    serialised(file, () =>
      writeFileAtomic(pathOf(file), JSON.stringify(data, BufferJSON.replacer)),
    );

  const read = (file: string): Promise<unknown> =>
    serialised(file, async () => {
      try {
        const parsed: unknown = JSON.parse(
          await readFile(pathOf(file), 'utf8'),
          BufferJSON.reviver,
        );
        return parsed;
      } catch {
        // Missing or unreadable is "none", as in Baileys: a key that is not there yet.
        return null;
      }
    });

  const remove = (file: string): Promise<void> =>
    serialised(file, () => unlink(pathOf(file)).catch(() => undefined));

  const stored = await read('creds.json');
  const creds = isCreds(stored) ? stored : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const found: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await read(`${type}-${id}.json`);
              if (typeof value !== 'object' || value === null) return;
              const decoded =
                type === 'app-state-sync-key'
                  ? proto.Message.AppStateSyncKeyData.fromObject(value)
                  : value;
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON this store wrote from the same type; Baileys' own store trusts it the same way
              found[id] = decoded as SignalDataTypeMap[T];
            }),
          );
          return found;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const [category, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              const file = `${category}-${id}.json`;
              tasks.push(value ? write(file, value) : remove(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds.json', creds),
  };
}

/** Enough of a check that a parsed file is credentials, not some other JSON. */
function isCreds(value: unknown): value is AuthenticationState['creds'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'noiseKey' in value &&
    'signedIdentityKey' in value
  );
}
