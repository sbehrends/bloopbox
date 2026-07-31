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
import { rm } from 'node:fs/promises';
import { io, type Socket } from 'socket.io-client';
import { probeDurationMs } from '../audio/ffmpeg.ts';
import { BRIDGE_AUTH_HEADER, BRIDGE_NAMESPACE } from '../ipc/events.ts';
import { readButtonIndex, readString } from '../ipc/payload.ts';
import { childLogger } from '../logger.ts';
import { WhatsAppClient, type VoiceNote } from '../whatsapp/client.ts';
import { Whitelist, type AllowedTarget } from '../whatsapp/whitelist.ts';

const log = childLogger('whatsapp');

/** Where Baileys keeps its credentials. Must be on the writable volume, and is gitignored. */
const AUTH_DIRECTORY = process.env['WA_AUTH_DIR'] ?? '/data/auth_info';
/** Inbound voice notes land here, alongside outgoing recordings. Should be tmpfs. */
const RECORDING_DIRECTORY = process.env['RECORDING_DIR'] ?? '/tmp/kids-messenger';
/** The hardware server's Socket.io endpoint. */
const HARDWARE_URL = process.env['HARDWARE_URL'] ?? 'http://localhost:3000';

/** Keys of messages played but not yet acknowledged upstream, so we can mark them read. */
const MAX_TRACKED_MESSAGES = 200;

async function main(): Promise<void> {
  const whitelist = new Whitelist();
  /** messageId -> the WhatsApp key needed to mark it read once the child has heard it. */
  const pendingReads = new Map<string, VoiceNote['raw']['key']>();

  const client = new WhatsAppClient({ authDirectory: AUTH_DIRECTORY, logger: log });

  const socket: Socket = io(`${HARDWARE_URL}${BRIDGE_NAMESPACE}`, {
    transports: ['websocket'],
    extraHeaders: { [BRIDGE_AUTH_HEADER]: process.env['BRIDGE_TOKEN'] ?? '' },
    // The hardware server restarts when config is saved, so reconnecting is the normal case.
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });

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
    void handleVoiceNote(note);
  });

  /**
   * Applies the whitelist, then downloads.
   *
   * Order matters: downloading first would write a stranger's audio to the device before we
   * decided we did not want it.
   */
  async function handleVoiceNote(note: VoiceNote): Promise<void> {
    const decision = whitelist.evaluate({
      chatJid: note.chatJid,
      participantJid: note.participantJid,
      fromMe: note.fromMe,
    });

    if (!decision.allowed) {
      log.debug({ chat: note.chatJid, reason: decision.reason }, 'dropped a voice note');
      return;
    }

    const { target } = decision;
    try {
      const { path, byteLength } = await note.download(RECORDING_DIRECTORY);
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

  log.info({ authDirectory: AUTH_DIRECTORY, hardware: HARDWARE_URL }, 'WhatsApp bridge starting');
  await client.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    void (async (): Promise<void> => {
      await client.stop();
      socket.close();
      process.exit(0);
    })();
    setTimeout(() => process.exit(0), 3000).unref();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown(signal));
  }
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
  process.exit(1);
});
