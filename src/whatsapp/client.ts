import { EventEmitter } from 'node:events';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type ConnectionState,
  type WAMessage,
  type WASocket,
} from 'baileys';
import type { Logger } from 'pino';
import type { WhatsAppConnectionState } from '../ipc/events.ts';

/**
 * Baileys connection lifecycle (PRODUCT.md §4, Process 2).
 *
 * Owns the socket, the auth state on disk, reconnection, and turning a WhatsApp media message
 * into a file on the RAM disk. Deliberately knows nothing about buttons or LEDs — the bridge
 * daemon maps between this and the device.
 *
 * Baileys is an unofficial WhatsApp API and this is a release candidate, so everything here
 * assumes the connection will drop, be replaced, or be logged out at any moment.
 */

/** Backoff bounds for reconnecting. A device in a cupboard must not hammer WhatsApp. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/** Voice notes longer than this are almost certainly not for a toddler; skip the download. */
const MAX_INBOUND_SECONDS = 300;

export type VoiceNote = {
  readonly messageId: string;
  readonly chatJid: string;
  readonly participantJid: string | undefined;
  readonly fromMe: boolean;
  readonly seconds: number | null;
  /** Downloads the audio to `directory` and returns the path. */
  readonly download: (directory: string) => Promise<{ path: string; byteLength: number }>;
  /** The raw message, for marking read. */
  readonly raw: WAMessage;
};

export type GroupSummary = { readonly id: string; readonly subject: string };

export type WhatsAppClientEvents = {
  /** Connection state changed. `qr` is present only while awaiting a pairing scan. */
  status: [{ state: WhatsAppConnectionState; detail?: string; qr?: string }];
  /** A voice note arrived. Filtering happens above — this fires for every chat. */
  voiceNote: [VoiceNote];
};

export type WhatsAppClientOptions = {
  /** Directory for Baileys' multi-file auth state. Must be on the writable volume. */
  readonly authDirectory: string;
  readonly logger: Logger;
};

export class WhatsAppClient extends EventEmitter<WhatsAppClientEvents> {
  readonly #authDirectory: string;
  readonly #log: Logger;

  #socket: WASocket | null = null;
  #reconnectAttempts = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #stopping = false;
  #state: WhatsAppConnectionState = 'connecting';

  constructor(options: WhatsAppClientOptions) {
    super();
    this.#authDirectory = options.authDirectory;
    this.#log = options.logger;
  }

  get state(): WhatsAppConnectionState {
    return this.#state;
  }

  get connected(): boolean {
    return this.#state === 'connected';
  }

  /** Opens the socket, restoring credentials if a previous pairing exists. */
  async start(): Promise<void> {
    this.#stopping = false;
    await this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      /*
       * `end` closes the socket without logging out, so credentials survive a restart. It is
       * typed as returning a promise in this version but resolves synchronously in practice;
       * voided rather than awaited so shutdown cannot hang on a socket that is already gone.
       */
      void socket.end(undefined);
    }
    await Promise.resolve();
  }

  /**
   * Drops the pairing so the device can be linked to a different account.
   *
   * Deletes the auth directory as well as logging out — a stale creds.json would otherwise be
   * restored on the next boot and immediately rejected.
   */
  async unlink(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    try {
      await socket?.logout();
    } catch (error: unknown) {
      this.#log.warn({ err: error }, 'logout failed; clearing credentials anyway');
    }
    await rm(this.#authDirectory, { recursive: true, force: true });
    this.#setState('loggedOut', 'unlinked by admin');
    if (!this.#stopping) this.#scheduleReconnect(true);
  }

  /** Sends a voice note. Rejects if the socket is down, so the caller can report failure. */
  async sendVoiceNote(jid: string, path: string, durationMs: number): Promise<void> {
    const socket = this.#socket;
    if (!socket || !this.connected) {
      throw new Error('WhatsApp is not connected');
    }
    await socket.sendMessage(jid, {
      audio: { url: path },
      mimetype: 'audio/ogg; codecs=opus',
      // Without ptt this arrives as a file attachment rather than a voice bubble.
      ptt: true,
      seconds: Math.max(1, Math.round(durationMs / 1000)),
    });
  }

  /** Marks messages read, so the sender sees the child heard them. */
  async markRead(keys: readonly WAMessage['key'][]): Promise<void> {
    const socket = this.#socket;
    if (!socket || keys.length === 0) return;
    await socket.readMessages([...keys]);
  }

  /** Groups the linked account participates in, for the admin panel's picker. */
  async listGroups(): Promise<GroupSummary[]> {
    const socket = this.#socket;
    if (!socket || !this.connected) return [];
    const groups = await socket.groupFetchAllParticipating();
    return Object.values(groups).map((group) => ({
      id: group.id,
      subject: group.subject.length > 0 ? group.subject : group.id,
    }));
  }

  /* ---- internals ---- */

  async #connect(): Promise<void> {
    await mkdir(this.#authDirectory, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.#authDirectory);
    // A pinned protocol version is better than none, but a fetch failure must not block boot.
    const version = await fetchLatestBaileysVersion()
      .then((result) => result.version)
      .catch(() => undefined);

    this.#setState('connecting');

    const socket = makeWASocket({
      auth: state,
      // Spread rather than assigned: the config declares `version?: WAVersion`, which under
      // exactOptionalPropertyTypes will not accept an explicit undefined.
      ...(version === undefined ? {} : { version }),
      logger: this.#log.child({ lib: 'baileys' }),
      /*
       * No printQRInTerminal: it is deprecated and its feature removed in Baileys 7. The QR
       * arrives on `connection.update` and we forward it to the admin panel, which is the only
       * place it could be scanned from anyway — the device has no screen.
       */
      // The device is a listener, not a participant — no need to advertise presence.
      markOnlineOnConnect: false,
      // History would download every chat this account has ever had into a RAM disk.
      syncFullHistory: false,
    });
    this.#socket = socket;

    socket.ev.on('creds.update', () => {
      void saveCreds();
    });

    socket.ev.on('connection.update', (update) => {
      this.#handleConnectionUpdate(update, socket);
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      // `notify` is a live message; `append` is history backfill we do not want to replay.
      if (type !== 'notify') return;
      for (const message of messages) this.#handleMessage(message);
    });
  }

  #handleConnectionUpdate(update: Partial<ConnectionState>, socket: WASocket): void {
    if (this.#socket !== socket) return; // A superseded socket; ignore its events.

    if (update.qr) {
      this.#setState('awaitingPairing', 'scan the code to link this device', update.qr);
    }

    if (update.connection === 'open') {
      this.#reconnectAttempts = 0;
      this.#setState('connected');
      return;
    }

    if (update.connection !== 'close') return;

    const statusCode = extractStatusCode(update.lastDisconnect?.error);
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    this.#log.warn({ statusCode, loggedOut }, 'whatsapp connection closed');
    this.#socket = null;

    if (loggedOut) {
      // Credentials are dead. Clear them so the next connect produces a fresh QR rather than
      // looping on a rejected session.
      this.#setState('loggedOut', 'this device was unlinked from WhatsApp');
      void (async (): Promise<void> => {
        await rm(this.#authDirectory, { recursive: true, force: true }).catch(() => undefined);
        if (!this.#stopping) this.#scheduleReconnect(true);
      })();
      return;
    }

    this.#setState('disconnected', describeStatus(statusCode));
    if (!this.#stopping) this.#scheduleReconnect(false);
  }

  #handleMessage(message: WAMessage): void {
    const audio = message.message?.audioMessage;
    // Only voice notes. A music file or a video note is not what this device is for.
    if (!audio?.ptt) return;

    const messageId = message.key.id;
    const chatJid = message.key.remoteJid;
    if (!messageId || !chatJid) return;

    const seconds = typeof audio.seconds === 'number' ? audio.seconds : null;
    if (seconds !== null && seconds > MAX_INBOUND_SECONDS) {
      this.#log.warn({ messageId, seconds }, 'skipping an unreasonably long voice note');
      return;
    }

    this.emit('voiceNote', {
      messageId,
      chatJid,
      participantJid: message.key.participant ?? undefined,
      fromMe: message.key.fromMe === true,
      seconds,
      raw: message,
      download: async (directory: string) => {
        await mkdir(directory, { recursive: true });
        const path = join(directory, `wa-${messageId}.ogg`);
        // Streamed rather than buffered: this runs on a 512MB Pi.
        const stream = (await downloadMediaMessage(
          message,
          'stream',
          {},
          {
            logger: this.#log.child({ lib: 'baileys-media' }),
            reuploadRequest: (msg) => {
              const socket = this.#socket;
              if (!socket) throw new Error('cannot re-request media while disconnected');
              return socket.updateMediaMessage(msg);
            },
          },
        )) as Readable;

        try {
          await pipeline(stream, createWriteStream(path));
        } catch (error: unknown) {
          await rm(path, { force: true });
          throw error;
        }

        const { size } = await stat(path);
        if (size === 0) {
          await rm(path, { force: true });
          throw new Error('downloaded voice note was empty');
        }
        return { path, byteLength: size };
      },
    });
  }

  #setState(state: WhatsAppConnectionState, detail?: string, qr?: string): void {
    this.#state = state;
    this.emit('status', {
      state,
      ...(detail === undefined ? {} : { detail }),
      ...(qr === undefined ? {} : { qr }),
    });
  }

  /**
   * Reconnects with exponential backoff.
   *
   * `immediate` is used after a logout, where the point is to produce a fresh QR promptly
   * rather than to back off from a failing server.
   */
  #scheduleReconnect(immediate: boolean): void {
    if (this.#reconnectTimer) return;

    const delay = immediate
      ? RECONNECT_BASE_MS
      : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.#reconnectAttempts);
    this.#reconnectAttempts = Math.min(this.#reconnectAttempts + 1, 10);

    this.#log.info({ delayMs: delay, attempt: this.#reconnectAttempts }, 'reconnecting');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect().catch((error: unknown) => {
        this.#log.error({ err: error }, 'reconnect failed');
        if (!this.#stopping) this.#scheduleReconnect(false);
      });
    }, delay);
    this.#reconnectTimer.unref();
  }
}

/** Baileys wraps disconnect causes in a Boom error whose status code says why. */
export function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('output' in error)) return undefined;
  const output = error.output;
  if (typeof output !== 'object' || output === null || !('statusCode' in output)) return undefined;
  const code = output.statusCode;
  return typeof code === 'number' ? code : undefined;
}

function describeStatus(statusCode: number | undefined): string {
  switch (statusCode) {
    case DisconnectReason.connectionClosed:
      return 'connection closed';
    case DisconnectReason.connectionLost:
      return 'connection lost';
    case DisconnectReason.connectionReplaced:
      return 'replaced by another session';
    case DisconnectReason.restartRequired:
      return 'restart required';
    case DisconnectReason.badSession:
      return 'bad session';
    case DisconnectReason.multideviceMismatch:
      return 'multi-device mismatch';
    case DisconnectReason.forbidden:
      return 'forbidden';
    case DisconnectReason.unavailableService:
      return 'service unavailable';
    default:
      return statusCode === undefined ? 'unknown reason' : `status ${String(statusCode)}`;
  }
}
