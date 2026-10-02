import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WAMessage } from 'baileys';
import type { ButtonIndex } from '../config/schema.ts';
import { writeFileAtomic } from '../config/atomicWrite.ts';
import { readKeyName } from '../ipc/noteFiles.ts';

/** What WhatsApp needs to mark one message read. */
export type ReadKey = WAMessage['key'];

/**
 * Where a note's read-receipt key waits between "downloaded" and "heard".
 *
 * It used to be a `Map` in the bridge's memory, so a bridge restart — an update, a crash, every
 * reboot — lost it, and a note that arrived before the restart was played without its sender ever
 * seeing the blue ticks (PENDING.md, "Read receipts do not survive a bridge restart"). Now it is a
 * small file beside the note, with the note's own lifetime: written when the note is accepted,
 * taken when the receipt is sent, dropped when the sender revokes it, and otherwise purged with
 * the audio after 48 h.
 */
export type ReadKeyStore = {
  readonly save: (index: ButtonIndex, messageId: string, key: ReadKey) => Promise<void>;
  /** The key, removed; `null` when there is none (never saved, already taken, purged). */
  readonly take: (index: ButtonIndex, messageId: string) => Promise<ReadKey | null>;
  readonly forget: (index: ButtonIndex, messageId: string) => Promise<void>;
};

/** The store on the card, in the notes directory. */
export function fileReadKeys(directory: string): ReadKeyStore {
  const pathOf = (index: ButtonIndex, messageId: string): string =>
    join(directory, readKeyName(index, messageId));

  return {
    // Async throughout, so an unsafe id (which `readKeyName` refuses) rejects instead of throwing
    // past the caller's `.catch`.
    save: async (index, messageId, key) => {
      await writeFileAtomic(pathOf(index, messageId), JSON.stringify(key));
    },
    take: async (index, messageId) => {
      const path = pathOf(index, messageId);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
      await rm(path, { force: true });
      return readKey(parsed);
    },
    forget: async (index, messageId) => {
      await rm(pathOf(index, messageId), { force: true });
    },
  };
}

/** Only the four fields a message key has, each the right type; anything else is no key. */
function readKey(value: unknown): ReadKey | null {
  if (typeof value !== 'object' || value === null) return null;
  const text = (field: string): string | undefined => {
    const raw: unknown = field in value ? Reflect.get(value, field) : undefined;
    return typeof raw === 'string' ? raw : undefined;
  };
  const id = text('id');
  const remoteJid = text('remoteJid');
  if (id === undefined || remoteJid === undefined) return null;
  const fromMe: unknown = 'fromMe' in value ? value.fromMe : undefined;
  const participant = text('participant');
  return {
    id,
    remoteJid,
    fromMe: fromMe === true,
    ...(participant === undefined ? {} : { participant }),
  };
}
