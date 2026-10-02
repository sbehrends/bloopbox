/**
 * Process 2 — WhatsApp bridge daemon (PRODUCT.md §4).
 *
 * Owns the Baileys socket and nothing else. It connects to the hardware server as a Socket.io
 * client on localhost and speaks only the contract in `src/ipc/events.ts`, so it never touches
 * GPIO, LEDs or audio devices — and the hardware server never imports Baileys.
 *
 * The two are deliberately separate processes: WhatsApp is an unofficial API on a release
 * candidate, and a crash here must not take the buttons and lights with it.
 */
import { notesDirectory, recordingDirectory } from '../audio/directories.ts';
import { rm } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { probeDurationMs } from '../audio/ffmpeg.ts';
import {
  BRIDGE_AUTH_HEADER,
  BRIDGE_NAMESPACE,
  type BridgeToServerEvents,
  type ServerToBridgeEvents,
} from '../ipc/events.ts';
import { readButtonIndex, readString } from '../ipc/payload.ts';
import { childLogger } from '../logger.ts';
import { WhatsAppClient, type Revocation, type VoiceNote } from '../whatsapp/client.ts';
import { HoldUntilReady } from '../whatsapp/holdUntilReady.ts';
import { Whitelist, type AllowedTarget } from '../whatsapp/whitelist.ts';
import { Shutdown } from './shutdown.ts';

const log = childLogger('whatsapp');

/** Where Baileys keeps its credentials. Must be on the writable volume, and is gitignored. */
const AUTH_DIRECTORY = process.env['WA_AUTH_DIR'] ?? '/data/auth_info';
/** Inbound voice notes land here — on the card, apart from the captures (`audio/directories.ts`). */
const NOTES_DIRECTORY = notesDirectory();
/**
 * Where outbound captures are. The only directory `wa:send` may upload from: the path arrives over
 * IPC, and uploading whatever it names would let anything holding the bridge token post any file
 * this daemon can read — WhatsApp credentials included — to a family's chat.
 */
const RECORDING_DIRECTORY = resolve(recordingDirectory());
/** The hardware server's Socket.io endpoint. */
const HARDWARE_URL = process.env['HARDWARE_URL'] ?? 'http://localhost:3000';

/** Keys of messages played but not yet acknowledged upstream, so we can mark them read. */
const MAX_TRACKED_MESSAGES = 200;
/**
 * Voice notes held until the first contact list arrives — see `whatsapp/holdUntilReady.ts`.
 * Far above any real offline backlog for three buttons, and small enough not to matter in RAM.
 */
const MAX_NOTES_BEFORE_WHITELIST = 50;
/** Revoked ids remembered, so a note still downloading when its revoke lands is thrown away. */
const MAX_TRACKED_REVOKES = 200;

/**
 * What waits for the whitelist, in one queue so a revoke is never judged before its own note.
 */
type Inbound = { readonly kind: 'note'; readonly note: VoiceNote } | Revoke;
type Revoke = { readonly kind: 'revoke'; readonly revocation: Revocation };

/**
 * Owns the way out. A crash here used to be whatever Node did by default; now it closes the
 * WhatsApp socket first, so Baileys is not killed mid-write to `creds.json`.
 */
const lifecycle = new Shutdown({ log });

async function main(): Promise<void> {
  lifecycle.installHandlers();
  const whitelist = new Whitelist();
  /** messageId -> the WhatsApp key needed to mark it read once the child has heard it. */
  const pendingReads = new Map<string, VoiceNote['raw']['key']>();
  /**
   * Ids deleted for everyone by an assigned chat. A download takes seconds, and "oops, wrong
   * chat" takes about as long: the revoke can arrive while the note is still on its way to disk,
   * when the hardware server has nothing to remove yet.
   */
  const revokedIds = new Set<string>();

  const client = new WhatsAppClient({ authDirectory: AUTH_DIRECTORY, logger: log });

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

  const socket: Socket<ServerToBridgeEvents, BridgeToServerEvents> = io(
    `${HARDWARE_URL}${BRIDGE_NAMESPACE}`,
    {
      transports: ['websocket'],
      extraHeaders: { [BRIDGE_AUTH_HEADER]: process.env['BRIDGE_TOKEN'] ?? '' },
      // The hardware server restarts when config is saved, so reconnecting is the normal case.
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    },
  );

  /* ---- hardware server -> bridge ---- */

  socket.on('connect', () => {
    log.info('connected to hardware server');
    // Re-announce, since the server has no memory of us across its own restarts.
    socket.emit('wa:status', { state: client.state });
  });

  socket.on('disconnect', (reason: string) => {
    log.warn({ reason }, 'lost the hardware server; buffering nothing until it returns');
  });

  socket.on('wa:contactsChanged', (payload: unknown) => {
    const targets = readTargets(payload);
    whitelist.replace(targets);
    log.info({ count: targets.length, jids: whitelist.jids() }, 'whitelist updated');
    if (!inbound.ready && inbound.heldCount > 0) {
      log.info({ count: inbound.heldCount }, 'evaluating voice notes that arrived before it');
    }
    inbound.open();
  });

  socket.on('wa:send', (payload: unknown) => {
    void handleSend(payload);
  });

  socket.on('wa:markRead', (payload: unknown) => {
    void handleMarkRead(payload);
  });

  socket.on('wa:unlink', () => {
    log.warn('unlink requested');
    void client.unlink().catch((error: unknown) => {
      log.error({ err: error }, 'unlink failed');
    });
  });

  socket.on('wa:beginLinking', () => {
    void client.beginLinking().catch((error: unknown) => {
      log.error({ err: error }, 'beginLinking failed');
    });
  });

  socket.on('wa:requestPairingCode', (payload: unknown) => {
    const requestId = readString(payload, 'requestId', 64);
    const phone = readString(payload, 'phone', 32);
    if (requestId === null) return;
    void (async (): Promise<void> => {
      if (phone === null) {
        socket.emit('wa:pairingCode', { requestId, error: 'a phone number is required' });
        return;
      }
      try {
        const code = await client.requestPairingCode(phone);
        log.info('issued a pairing code');
        socket.emit('wa:pairingCode', { requestId, code });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ err: error }, 'pairing code request failed');
        socket.emit('wa:pairingCode', { requestId, error: message });
      }
    })();
  });

  socket.on('wa:listGroups', (payload: unknown) => {
    const requestId = readString(payload, 'requestId', 64);
    if (requestId === null) return;
    void (async (): Promise<void> => {
      try {
        socket.emit('wa:groups', { requestId, groups: await client.listGroups() });
      } catch (error: unknown) {
        // An empty list is better than leaving the admin panel waiting.
        log.warn({ err: error }, 'could not list groups');
        socket.emit('wa:groups', { requestId, groups: [] });
      }
    })();
  });

  /* ---- WhatsApp -> hardware server ---- */

  client.on('status', ({ state, detail, qr }) => {
    socket.emit('wa:status', {
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
    pendingReads.delete(revocation.messageId);

    log.info({ index: decision.target.index }, 'a voice note was deleted by its sender');
    socket.emit('wa:revoked', { index: decision.target.index, messageId: revocation.messageId });
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
        { chat: note.chatJid, chatAlt: note.chatJidAlt, reason: decision.reason },
        'dropped a voice note',
      );
      return;
    }

    const { target } = decision;
    if (revokedIds.has(note.messageId)) return;
    try {
      const { path, byteLength } = await note.download(NOTES_DIRECTORY, target.index);
      if (revokedIds.has(note.messageId)) {
        // Deleted while it downloaded. Nothing was announced, so nothing needs taking back.
        await rm(path, { force: true });
        log.info({ index: target.index }, 'discarded a voice note its sender deleted');
        return;
      }
      const durationMs = note.seconds !== null ? note.seconds * 1000 : await probeDurationMs(path);

      rememberRead(note.messageId, note.raw.key);

      log.info(
        {
          index: target.index,
          kind: target.kind,
          from: target.kind === 'group' ? note.participantJid : note.chatJid,
          bytes: byteLength,
        },
        'voice note accepted',
      );

      socket.emit('wa:incoming', {
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

  async function handleSend(payload: unknown): Promise<void> {
    const requestId = readString(payload, 'requestId', 64);
    const index = readButtonIndex(payload);
    const path = readString(payload, 'path', 1024);

    if (requestId === null || index === null || path === null) {
      log.warn('ignoring a malformed send request');
      return;
    }

    if (!isOutboundCapture(path)) {
      log.warn({ path }, 'refused to send a file that is not an outbound capture');
      socket.emit('wa:sendResult', {
        requestId,
        index,
        ok: false,
        error: 'that file is not a recording',
      });
      return;
    }

    const target = whitelist.forIndex(index);
    if (!target) {
      socket.emit('wa:sendResult', {
        requestId,
        index,
        ok: false,
        error: 'no contact assigned to that button',
      });
      return;
    }

    const durationMs = (await probeDurationMs(path)) ?? 0;

    try {
      await client.sendVoiceNote(target.jid, path, durationMs);
      log.info({ index, kind: target.kind }, 'voice note sent');
      socket.emit('wa:sendResult', { requestId, index, ok: true });
      // Delivered — the RAM disk copy has no further use.
      await rm(path, { force: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error, index }, 'send failed');
      // Left on disk deliberately: the purge collects it, and it aids diagnosis meanwhile.
      socket.emit('wa:sendResult', { requestId, index, ok: false, error: message });
    }
  }

  async function handleMarkRead(payload: unknown): Promise<void> {
    const messageIds = readMessageIds(payload);
    const keys = messageIds.flatMap((id) => {
      const key = pendingReads.get(id);
      if (!key) return [];
      pendingReads.delete(id);
      return [key];
    });

    if (keys.length === 0) return;
    try {
      await client.markRead(keys);
      log.debug({ count: keys.length }, 'marked read upstream');
    } catch (error: unknown) {
      // Cosmetic — the child has already heard the message.
      log.warn({ err: error }, 'could not mark messages read');
    }
  }

  function rememberRead(messageId: string, key: VoiceNote['raw']['key']): void {
    pendingReads.set(messageId, key);
    // Bounded: a queue nobody ever plays must not grow without limit.
    while (pendingReads.size > MAX_TRACKED_MESSAGES) {
      const oldest = pendingReads.keys().next();
      if (oldest.done === true) break;
      pendingReads.delete(oldest.value);
    }
  }

  /* ---- start ---- */

  /*
   * Registered before the client starts, so a crash while it connects still ends the socket and
   * closes the link. Separate steps: a Baileys that fails to stop must not keep the IPC open.
   */
  lifecycle.setSteps([
    { name: 'whatsapp client', run: async () => client.stop() },
    { name: 'hardware link', run: () => socket.close() },
  ]);

  log.info({ authDirectory: AUTH_DIRECTORY, hardware: HARDWARE_URL }, 'WhatsApp bridge starting');
  await client.start();
}

/** A voice note the HAL finished encoding: an `.ogg` directly inside the recordings directory. */
function isOutboundCapture(path: string): boolean {
  const resolved = resolve(path);
  return dirname(resolved) === RECORDING_DIRECTORY && extname(resolved) === '.ogg';
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

await main().catch((error: unknown) => {
  log.error({ err: error }, 'WhatsApp bridge failed to start');
  lifecycle.begin('startup failed', 1);
});
