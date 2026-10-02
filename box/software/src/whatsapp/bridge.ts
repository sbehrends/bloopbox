import type { EventEmitter } from 'node:events';
import { dirname, extname, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { BridgeToServerEvents } from '../ipc/events.ts';
import { readButtonIndex, readString } from '../ipc/payload.ts';
import type { Revocation, VoiceNote, WhatsAppClient, WhatsAppClientEvents } from './client.ts';
import { HoldUntilReady } from './holdUntilReady.ts';
import { maskJid } from './privacy.ts';
import type { ReadKeyStore } from './readKeys.ts';
import { Whitelist, type AllowedTarget } from './whitelist.ts';

/**
 * The WhatsApp bridge's decisions, out of its process file so they can be tested.
 *
 * Everything here used to be closures inside `whatsapp-bridge.ts`'s `main()`, which is excluded
 * from coverage — so the one call site that enforces **whitelist before download**, the product's
 * safety boundary, had no test of its own; `whitelist.test.ts` proved the rule, nothing proved it
 * was applied. The process file now only opens the two connections and wires them to this.
 *
 * Injected: the WhatsApp client (only the members used, so a test double is an EventEmitter),
 * the way to talk to the hardware server, and the two file-system effects. Nothing here opens a
 * socket or spawns a process.
 */

/**
 * The part of `WhatsAppClient` the bridge uses. `on` comes from the emitter type rather than the
 * client, so a test double only has to be an emitter of the same events.
 */
export type BridgeWhatsApp = Pick<
  WhatsAppClient,
  | 'state'
  | 'unlink'
  | 'beginLinking'
  | 'requestPairingCode'
  | 'listGroups'
  | 'sendVoiceNote'
  | 'markRead'
> &
  Pick<EventEmitter<WhatsAppClientEvents>, 'on'>;

/** One event for the hardware server, as `[name, payload]`, typed by the shared contract. */
export type HardwareEvent = {
  [E in keyof BridgeToServerEvents]: [E, ...Parameters<BridgeToServerEvents[E]>];
}[keyof BridgeToServerEvents];

/** Sends one event to the hardware server. */
export type ToHardware = (...event: HardwareEvent) => void;

export type BridgeOptions = {
  readonly client: BridgeWhatsApp;
  readonly toHardware: ToHardware;
  /** Where accepted notes are downloaded to: the card. */
  readonly notesDirectory: string;
  /** The only directory `wa:send` may upload from. */
  readonly recordingDirectory: string;
  /** The audio's length, for a send; `null` when it cannot be read. */
  readonly probeDuration: (path: string) => Promise<number | null>;
  /** Deletes a file, resolving when it is gone or was never there. */
  readonly removeFile: (path: string) => Promise<void>;
  /** Where each accepted note's read-receipt key waits until the child has heard it. */
  readonly readKeys: ReadKeyStore;
  readonly log: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
};

/** What the hardware server can ask of the bridge; the process wires each to its event. */
export type Bridge = {
  /** The hardware server (re)connected. It has no memory of us, so re-announce the state. */
  readonly connected: () => void;
  readonly contactsChanged: (payload: unknown) => void;
  readonly send: (payload: unknown) => Promise<void>;
  readonly markRead: (payload: unknown) => Promise<void>;
  readonly unlink: () => Promise<void>;
  readonly beginLinking: () => Promise<void>;
  readonly requestPairingCode: (payload: unknown) => Promise<void>;
  readonly listGroups: (payload: unknown) => Promise<void>;
};

/**
 * Voice notes held until the first contact list arrives — see `holdUntilReady.ts`.
 * Far above any real offline backlog for three buttons, and small enough not to matter in RAM.
 */
export const MAX_NOTES_BEFORE_WHITELIST = 50;
/** Revoked ids remembered, so a note still downloading when its revoke lands is thrown away. */
export const MAX_TRACKED_REVOKES = 200;

/** What waits for the whitelist, in one queue so a revoke is never judged before its own note. */
type Inbound =
  | { readonly kind: 'note'; readonly note: VoiceNote }
  | { readonly kind: 'revoke'; readonly revocation: Revocation };

export function createBridge(options: BridgeOptions): Bridge {
  const { client, toHardware, log } = options;
  const recordingDirectory = resolve(options.recordingDirectory);
  const whitelist = new Whitelist();
  /**
   * Ids deleted for everyone by an assigned chat. A download takes seconds, and "oops, wrong
   * chat" takes about as long: the revoke can arrive while the note is still on its way to disk,
   * when the hardware server has nothing to remove yet.
   */
  const revokedIds = new Set<string>();

  /*
   * Opened by the first contact list, and never closed again: after that the whitelist is only
   * ever replaced, and an empty list is still a real answer ("nobody is assigned").
   */
  const inbound = new HoldUntilReady<Inbound>({
    handle: (item) => {
      if (item.kind === 'note') void handleVoiceNote(item.note);
      else handleRevoke(item.revocation);
    },
    capacity: MAX_NOTES_BEFORE_WHITELIST,
    onOverflow: (item) => {
      const messageId = item.kind === 'note' ? item.note.messageId : item.revocation.messageId;
      log.warn(
        { messageId, kind: item.kind },
        'dropped an inbound event: too many before the whitelist',
      );
    },
  });

  /* ---- WhatsApp -> hardware server ---- */

  client.on('status', ({ state, detail, qr }) => {
    toHardware('wa:status', {
      state,
      ...(detail === undefined ? {} : { detail }),
      ...(qr === undefined ? {} : { qr }),
    });
  });
  client.on('voiceNote', (note) => {
    inbound.push({ kind: 'note', note });
  });
  client.on('revoked', (revocation) => {
    inbound.push({ kind: 'revoke', revocation });
  });

  /**
   * "Delete for everyone", from a chat the whitelist resolves to a button.
   *
   * The same check a note gets, so a revoke can only ever reach the button its own chat is on;
   * the hardware server then removes the note only if that button is still holding that id.
   */
  function handleRevoke(revocation: Revocation): void {
    const decision = whitelist.evaluate(revocation);
    if (!decision.allowed) return;

    revokedIds.add(revocation.messageId);
    while (revokedIds.size > MAX_TRACKED_REVOKES) {
      const oldest = revokedIds.values().next();
      if (oldest.done === true) break;
      revokedIds.delete(oldest.value);
    }
    void options.readKeys
      .forget(decision.target.index, revocation.messageId)
      .catch((error: unknown) => {
        log.warn({ err: error }, 'could not delete the read key of a revoked note');
      });

    log.info({ index: decision.target.index }, 'a voice note was deleted by its sender');
    toHardware('wa:revoked', { index: decision.target.index, messageId: revocation.messageId });
  }

  /**
   * Applies the whitelist, then downloads.
   *
   * Order matters: downloading first would write a stranger's audio to the device before we
   * decided we did not want it.
   */
  async function handleVoiceNote(note: VoiceNote): Promise<void> {
    const decision = whitelist.evaluate({
      chatJid: note.chatJid,
      chatJidAlt: note.chatJidAlt,
      participantJid: note.participantJid,
      fromMe: note.fromMe,
    });

    if (!decision.allowed) {
      // Both spellings, or a LID drop is indistinguishable from an actual stranger in the log.
      log.debug(
        { chat: maskJid(note.chatJid), chatAlt: maskJid(note.chatJidAlt), reason: decision.reason },
        'dropped a voice note',
      );
      return;
    }

    const { target } = decision;
    if (revokedIds.has(note.messageId)) return;
    try {
      const { path, byteLength } = await note.download(options.notesDirectory, target.index);
      if (revokedIds.has(note.messageId)) {
        // Deleted while it downloaded. Nothing was announced, so nothing needs taking back.
        await options.removeFile(path);
        log.info({ index: target.index }, 'discarded a voice note its sender deleted');
        return;
      }
      const durationMs =
        note.seconds !== null ? note.seconds * 1000 : await options.probeDuration(path);

      // Before the announcement, so a tap the moment the lamp lights still finds it.
      await options.readKeys
        .save(target.index, note.messageId, note.raw.key)
        .catch((error: unknown) => {
          // The note still plays; only its blue ticks are at stake.
          log.warn(
            { err: error, messageId: note.messageId },
            'could not keep the read key of a note',
          );
        });

      log.info(
        {
          index: target.index,
          kind: target.kind,
          from: maskJid(target.kind === 'group' ? note.participantJid : note.chatJid),
          bytes: byteLength,
        },
        'voice note accepted',
      );

      toHardware('wa:incoming', {
        index: target.index,
        messageId: note.messageId,
        path,
        durationMs,
        receivedAt: Date.now(),
      });
    } catch (error: unknown) {
      log.error({ err: error, messageId: note.messageId }, 'failed to download a voice note');
    }
  }

  /** A voice note the HAL finished encoding: an `.ogg` directly inside the recordings directory. */
  function isOutboundCapture(path: string): boolean {
    const resolved = resolve(path);
    return dirname(resolved) === recordingDirectory && extname(resolved) === '.ogg';
  }

  /* ---- hardware server -> bridge ---- */

  return {
    connected: () => {
      toHardware('wa:status', { state: client.state });
    },

    contactsChanged: (payload) => {
      const targets = readTargets(payload);
      whitelist.replace(targets);
      log.info(
        { count: targets.length, jids: whitelist.jids().map((jid) => maskJid(jid)) },
        'whitelist updated',
      );
      if (!inbound.ready && inbound.heldCount > 0) {
        log.info({ count: inbound.heldCount }, 'evaluating voice notes that arrived before it');
      }
      inbound.open();
    },

    send: async (payload) => {
      const requestId = readString(payload, 'requestId', 64);
      const index = readButtonIndex(payload);
      const path = readString(payload, 'path', 1024);

      if (requestId === null || index === null || path === null) {
        log.warn('ignoring a malformed send request');
        return;
      }

      /*
       * The path arrives over IPC, and uploading whatever it names would let anything holding the
       * bridge token post any file this daemon can read — WhatsApp credentials included — to a
       * family's chat.
       */
      if (!isOutboundCapture(path)) {
        log.warn({ path }, 'refused to send a file that is not an outbound capture');
        toHardware('wa:sendResult', {
          requestId,
          index,
          ok: false,
          error: 'that file is not a recording',
        });
        return;
      }

      const target = whitelist.forIndex(index);
      if (!target) {
        toHardware('wa:sendResult', {
          requestId,
          index,
          ok: false,
          error: 'no contact assigned to that button',
        });
        return;
      }

      const durationMs = (await options.probeDuration(path)) ?? 0;

      try {
        await client.sendVoiceNote(target.jid, path, durationMs);
        log.info({ index, kind: target.kind }, 'voice note sent');
        toHardware('wa:sendResult', { requestId, index, ok: true });
        // Delivered — the RAM disk copy has no further use.
        await options.removeFile(path);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ err: error, index }, 'send failed');
        // Left on disk deliberately: the purge collects it, and it aids diagnosis meanwhile.
        toHardware('wa:sendResult', { requestId, index, ok: false, error: message });
      }
    },

    markRead: async (payload) => {
      const index = readButtonIndex(payload);
      if (index === null) return;
      // From the card, not from memory: a note that arrived before a bridge restart still has one.
      const taken = await Promise.all(
        readMessageIds(payload).map((id) => options.readKeys.take(index, id).catch(() => null)),
      );
      const keys = taken.filter((key) => key !== null);

      if (keys.length === 0) return;
      try {
        await client.markRead(keys);
        log.debug({ count: keys.length }, 'marked read upstream');
      } catch (error: unknown) {
        // Cosmetic — the child has already heard the message.
        log.warn({ err: error }, 'could not mark messages read');
      }
    },

    unlink: async () => {
      log.warn('unlink requested');
      await client.unlink().catch((error: unknown) => {
        log.error({ err: error }, 'unlink failed');
      });
    },

    beginLinking: async () => {
      await client.beginLinking().catch((error: unknown) => {
        log.error({ err: error }, 'beginLinking failed');
      });
    },

    requestPairingCode: async (payload) => {
      const requestId = readString(payload, 'requestId', 64);
      const phone = readString(payload, 'phone', 32);
      if (requestId === null) return;
      if (phone === null) {
        toHardware('wa:pairingCode', { requestId, error: 'a phone number is required' });
        return;
      }
      try {
        const code = await client.requestPairingCode(phone);
        log.info('issued a pairing code');
        toHardware('wa:pairingCode', { requestId, code });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ err: error }, 'pairing code request failed');
        toHardware('wa:pairingCode', { requestId, error: message });
      }
    },

    listGroups: async (payload) => {
      const requestId = readString(payload, 'requestId', 64);
      if (requestId === null) return;
      try {
        toHardware('wa:groups', { requestId, groups: await client.listGroups() });
      } catch (error: unknown) {
        // An empty list is better than leaving the admin panel waiting.
        log.warn({ err: error }, 'could not list groups');
        toHardware('wa:groups', { requestId, groups: [] });
      }
    },
  };
}

/** Reads the contact list the hardware server sends. */
function readTargets(payload: unknown): AllowedTarget[] {
  if (typeof payload !== 'object' || payload === null || !('contacts' in payload)) return [];
  const contacts = payload.contacts;
  if (!Array.isArray(contacts)) return [];

  return contacts.flatMap((entry: unknown): AllowedTarget[] => {
    const index = readButtonIndex(entry);
    const jid = readString(entry, 'jid', 256);
    if (index === null || jid === null) return [];
    const kind = jid.endsWith('@g.us') ? 'group' : 'individual';
    return [{ index, jid, kind }];
  });
}

function readMessageIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || !('messageIds' in payload)) return [];
  const ids = payload.messageIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
}
