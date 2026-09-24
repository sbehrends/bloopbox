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
  type AuthenticationCreds,
  type AuthenticationState,
  type ConnectionState,
  type UserFacingSocketConfig,
  type WAMessage,
  type WASocket,
  type WAVersion,
} from 'baileys';
import type { Logger } from 'pino';
import { isSafeMessageId, RECOVERY_MAX_AGE_MS, recordingName } from '../audio/recovery.ts';
import { normalisePhone, type ButtonIndex } from '../config/schema.ts';
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
  /**
   * The same chat addressed the other way round — see `#resolveAlt`.
   *
   * WhatsApp is migrating to LIDs, so `chatJid` for a direct message can arrive as
   * `44581961883857@lid` while the parent configured a phone number. Both spellings identify
   * one person; the whitelist accepts either.
   */
  readonly chatJidAlt: string | undefined;
  readonly participantJid: string | undefined;
  readonly fromMe: boolean;
  readonly seconds: number | null;
  /** Downloads the audio to `directory` and returns the path. */
  /**
   * Downloads the audio to `directory` and returns the path.
   *
   * `index` is the button the whitelist resolved this note to, and it goes into the filename:
   * after a restart the directory is the only record of what is still unread, and a file that
   * cannot say which button it belongs to cannot be put back on one. See `audio/recovery.ts`.
   */
  readonly download: (
    directory: string,
    index: ButtonIndex,
  ) => Promise<{ path: string; byteLength: number }>;
  /** The raw message, for marking read. */
  readonly raw: WAMessage;
};

/**
 * Whether a `messages.upsert` batch is one this device should act on.
 *
 * `notify` is a message arriving while we are connected. **`append` is what Baileys uses for
 * the queue WhatsApp held while we were offline** — `messages-recv.js` picks the type with
 * `node.attrs.offline ? 'append' : 'notify'` — which is precisely the case this product exists
 * for: the box spends nights, journeys and power cuts switched off, and the messages sent
 * during those hours are the ones a child most wants when it comes back.
 *
 * This used to drop everything but `notify`, on the belief that `append` meant history
 * backfill. It does not: a history sync arrives on `messaging-history.set`, never here. The
 * cost of that mistake was every message sent while the box was off, discarded in silence.
 *
 * `append` is bounded by age rather than accepted outright, because the other two things
 * Baileys sends this way are a plaintext newsletter (the whitelist drops those anyway) and a
 * placeholder resend, which can carry something old. The window is the same one boot recovery
 * uses, and for the same reason — both are the box catching up after being away, and one rule
 * is easier to reason about than two.
 *
 * An unknown age fails closed. A message that cannot say when it was sent cannot be shown to
 * be recent, and replaying something old at a child is worse than missing it.
 */
export function shouldHandleUpsert(type: string, ageMs: number | null): boolean {
  if (type === 'notify') return true;
  if (ageMs === null) return false;
  return ageMs <= RECOVERY_MAX_AGE_MS;
}

/** How long ago a message was sent, or null if it does not say. */
export function messageAgeMs(
  message: Pick<WAMessage, 'messageTimestamp'>,
  now: number = Date.now(),
): number | null {
  const seconds = Number(message.messageTimestamp ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // Clamp: a message stamped in the future is not evidence of anything, but it is not stale.
  return Math.max(0, now - seconds * 1000);
}

/**
 * Whether credentials on disk describe a device that is already paired.
 *
 * **`creds.registered` alone is not that question**, however much it reads like it. Baileys
 * sets the flag in exactly one place — `Socket/messages-recv.ts`, handling the
 * `link_code_companion_reg` notification — which is the **phone-number** pairing path. A QR
 * scan finishes through `configureSuccessfulPairing`, which fills in `me`, `account`,
 * `platform` and the signal identities and never touches `registered` at all.
 *
 * So a device paired by scanning ends up with a complete, working session on disk and
 * `registered: false` sitting beside it. Nothing notices while the process stays up, because
 * the live socket is authenticated either way; the flag is only ever read at boot. The next
 * restart then reports a perfectly good pairing as `notLinked` and offers a parent a QR for
 * an account that is already linked — and, because `beginLinking()` opens a fresh socket,
 * scanning it is what would finally destroy the session that was there all along.
 *
 * `me.id` plus `account` is what actually proves a pairing happened, so that is what this
 * asks. `registered` is still honoured first: it is authoritative when set.
 */
export function isPaired(
  creds: Pick<AuthenticationCreds, 'registered' | 'me' | 'account'>,
): boolean {
  if (creds.registered) return true;
  const id = creds.me?.id;
  return typeof id === 'string' && id.length > 0 && creds.account !== undefined;
}

export type GroupSummary = { readonly id: string; readonly subject: string };

export type WhatsAppClientEvents = {
  /** Connection state changed. `qr` is present only while awaiting a pairing scan. */
  status: [{ state: WhatsAppConnectionState; detail?: string; qr?: string }];
  /** A voice note arrived. Filtering happens above — this fires for every chat. */
  voiceNote: [VoiceNote];
};

/**
 * The part of a Baileys socket this client uses — and so all a test double has to provide.
 *
 * `WASocket` itself is a few hundred members; naming the dozen this file touches is what lets
 * `src/tests/support/fakeWASocket.ts` stand in for it without a cast, and it is a list worth
 * having anyway: anything added here is a new way this client depends on the library.
 */
export type ClientSocket = {
  readonly ev: Pick<WASocket['ev'], 'on'>;
  readonly end: WASocket['end'];
  readonly logout: WASocket['logout'];
  readonly sendMessage: WASocket['sendMessage'];
  readonly readMessages: WASocket['readMessages'];
  readonly requestPairingCode: WASocket['requestPairingCode'];
  readonly groupFetchAllParticipating: WASocket['groupFetchAllParticipating'];
  readonly updateMediaMessage: WASocket['updateMediaMessage'];
  readonly signalRepository: {
    readonly lidMapping: Pick<WASocket['signalRepository']['lidMapping'], 'getPNForLID'>;
  };
};

export type AuthStateFactory = (
  directory: string,
) => Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;

/** What the media download needs from the socket, in the shape `downloadMediaMessage` takes. */
export type MediaDownloadContext = {
  readonly logger: Logger;
  readonly reuploadRequest: (message: WAMessage) => Promise<WAMessage>;
};

/** Opens a media message as a stream of decrypted bytes. */
export type MediaDownloader = (
  message: WAMessage,
  context: MediaDownloadContext,
) => Promise<Readable>;

export type WhatsAppClientOptions = {
  /** Directory for Baileys' multi-file auth state. Must be on the writable volume. */
  readonly authDirectory: string;
  readonly logger: Logger;
  /*
   * The four ways this client reaches Baileys, injectable so the lifecycle can be tested
   * without a WhatsApp account. Every default is the real library call; production passes none.
   */
  readonly socketFactory?: (config: UserFacingSocketConfig) => ClientSocket;
  readonly authStateFactory?: AuthStateFactory;
  readonly download?: MediaDownloader;
  /** The protocol version to announce, or undefined for the one Baileys ships with. */
  readonly versionProvider?: () => Promise<WAVersion | undefined>;
};

const defaultDownload: MediaDownloader = (message, context) =>
  downloadMediaMessage(message, 'stream', {}, context);

const defaultVersionProvider = async (): Promise<WAVersion | undefined> =>
  (await fetchLatestBaileysVersion()).version;

export class WhatsAppClient extends EventEmitter<WhatsAppClientEvents> {
  readonly #authDirectory: string;
  readonly #log: Logger;
  readonly #socketFactory: (config: UserFacingSocketConfig) => ClientSocket;
  readonly #authStateFactory: AuthStateFactory;
  readonly #download: MediaDownloader;
  readonly #versionProvider: () => Promise<WAVersion | undefined>;

  #socket: ClientSocket | null = null;
  #reconnectAttempts = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #stopping = false;
  #state: WhatsAppConnectionState = 'connecting';
  /**
   * The in-flight `requestPairingCode` call, if any.
   *
   * Baileys keeps rotating the QR on its own timer regardless of this call, and nothing stops
   * a second pairing-code request from firing while the first is still waiting on WhatsApp's
   * servers — each one overwrites `creds.me`/`creds.pairingCode` on the same socket, so two in
   * flight together can corrupt both. One in flight at a time is enough to avoid that; it is
   * cleared on every reconnect so a hung request cannot lock the method out permanently.
   */
  #pairingCodeRequest: Promise<string> | null = null;

  constructor(options: WhatsAppClientOptions) {
    super();
    this.#authDirectory = options.authDirectory;
    this.#log = options.logger;
    this.#socketFactory = options.socketFactory ?? makeWASocket;
    this.#authStateFactory = options.authStateFactory ?? useMultiFileAuthState;
    this.#download = options.download ?? defaultDownload;
    this.#versionProvider = options.versionProvider ?? defaultVersionProvider;
  }

  get state(): WhatsAppConnectionState {
    return this.#state;
  }

  get connected(): boolean {
    return this.#state === 'connected';
  }

  /**
   * Restores a previous pairing if one exists; otherwise waits.
   *
   * Baileys starts generating a QR the instant a socket opens for an unregistered device —
   * that is WhatsApp's server driving the handshake, not a request we make — so an unpaired
   * device must not open one at boot. It settles into `notLinked` and stays there until
   * `beginLinking()` is called, which happens once a parent picks a method in the admin panel.
   * An already-paired device has nothing to wait for and connects immediately, same as before.
   */
  async start(): Promise<void> {
    this.#stopping = false;
    await mkdir(this.#authDirectory, { recursive: true });
    const { state } = await this.#authStateFactory(this.#authDirectory);
    if (isPaired(state.creds)) {
      await this.#connect();
    } else {
      this.#setState('notLinked', 'waiting for a method to be chosen before linking');
    }
  }

  /** Opens the socket for a first-time link. A no-op once linking has already started. */
  async beginLinking(): Promise<void> {
    if (this.#state !== 'notLinked') return;
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
   * restored on the next boot and immediately rejected. Settles into `notLinked` rather than
   * reconnecting on its own: the point of that state is that nothing opens a socket, and hence
   * nothing asks Baileys for a QR, without a parent choosing a method first.
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
    this.#setState('notLinked', 'unlinked — choose a method in the admin panel to link again');
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

  /**
   * Starts phone-number pairing and returns the code to type into WhatsApp.
   *
   * Only valid while unpaired — WhatsApp rejects it once credentials exist, and the socket has
   * to be up to make the request at all.
   */
  async requestPairingCode(phone: string): Promise<string> {
    const socket = this.#socket;
    if (!socket) throw new Error('not connected to WhatsApp yet — try again in a moment');
    if (this.connected) throw new Error('already linked; unlink first to pair a new account');
    if (this.#pairingCodeRequest) {
      throw new Error('already requesting a pairing code — wait for that one to answer');
    }

    // Same reduction the contact-target parser uses: strips a leading `+`/`00`, and rejects a
    // *surviving* leading 0 rather than guessing a country code — see `normalisePhone`.
    const digits = normalisePhone(phone);
    if (digits === null) {
      throw new Error('enter the full number with country code — no leading 0, +, or 00');
    }

    const request = socket.requestPairingCode(digits);
    this.#pairingCodeRequest = request;
    try {
      return await request;
    } finally {
      if (this.#pairingCodeRequest === request) this.#pairingCodeRequest = null;
    }
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
    const { state, saveCreds } = await this.#authStateFactory(this.#authDirectory);
    // A pinned protocol version is better than none, but a fetch failure must not block boot.
    const version = await this.#versionProvider().catch(() => undefined);

    this.#setState('connecting');
    // A stale lock from the superseded socket must not block pairing on the new one.
    this.#pairingCodeRequest = null;

    const socket = this.#socketFactory({
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
      /*
       * Reaching `open` means WhatsApp accepted these credentials, which is the only proof
       * of pairing that matters. Writing it down normalises the flag Baileys leaves false
       * on the QR path (see `isPaired`), so the credentials on disk agree with reality and
       * `isPaired`'s fallback stays a safety net rather than the thing every boot rests on.
       */
      if (update.connection === 'open' && !state.creds.registered) {
        state.creds.registered = true;
        void saveCreds();
      }
      this.#handleConnectionUpdate(update, socket);
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      for (const message of messages) {
        if (!shouldHandleUpsert(type, messageAgeMs(message))) continue;
        // Resolving a LID can touch the auth store, so this is async; failures logged inside.
        void this.#handleMessage(message);
      }
    });
  }

  #handleConnectionUpdate(update: Partial<ConnectionState>, socket: ClientSocket): void {
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
      // Credentials are dead. Clear them so a restored creds.json cannot be replayed against a
      // rejected session, and wait for a parent to choose a method rather than reconnecting on
      // our own — that would ask Baileys for a fresh QR nobody requested.
      this.#setState(
        'notLinked',
        'this device was unlinked from WhatsApp — choose a method to link again',
      );
      void rm(this.#authDirectory, { recursive: true, force: true }).catch(() => undefined);
      return;
    }

    this.#setState('disconnected', describeStatus(statusCode));
    if (!this.#stopping) this.#scheduleReconnect(false);
  }

  /**
   * The phone-number spelling of a `@lid` chat, if one can be found.
   *
   * WhatsApp is moving addressing from phone numbers to LIDs, and a direct message now arrives
   * as `<lid>@lid` even when the sender is someone the parent configured by number. Nothing in
   * a LID resembles the phone number, so a whitelist holding `…@s.whatsapp.net` rejects the
   * contact it was built for and the button goes silently deaf.
   *
   * Two sources, cheapest first: the key often carries the other spelling already, and
   * otherwise Baileys keeps a LID↔PN map in the auth state (the `lid-mapping-*.json` files).
   * A miss is not an error — it just means no alternative is known, and the primary JID stands
   * on its own.
   */
  async #resolveAlt(jid: string, fromKey: string | null | undefined): Promise<string | undefined> {
    if (typeof fromKey === 'string' && fromKey.length > 0) return fromKey;
    if (!jid.endsWith('@lid')) return undefined;
    const socket = this.#socket;
    if (!socket) return undefined;
    try {
      return (await socket.signalRepository.lidMapping.getPNForLID(jid)) ?? undefined;
    } catch (error: unknown) {
      this.#log.debug({ err: error, jid }, 'could not resolve a lid to a phone number');
      return undefined;
    }
  }

  async #handleMessage(message: WAMessage): Promise<void> {
    const audio = message.message?.audioMessage;
    // Only voice notes. A music file or a video note is not what this device is for.
    if (!audio?.ptt) return;

    const messageId = message.key.id;
    const chatJid = message.key.remoteJid;
    if (!messageId || !chatJid) return;
    // The sender's client picks the id and it becomes a file name, so a hostile one is dropped
    // here rather than resolved to a path outside the notes directory.
    if (!isSafeMessageId(messageId)) {
      this.#log.warn({ chat: chatJid }, 'dropped a voice note with an unsafe message id');
      return;
    }

    const seconds = typeof audio.seconds === 'number' ? audio.seconds : null;
    if (seconds !== null && seconds > MAX_INBOUND_SECONDS) {
      this.#log.warn({ messageId, seconds }, 'skipping an unreasonably long voice note');
      return;
    }

    this.emit('voiceNote', {
      messageId,
      chatJid,
      chatJidAlt: await this.#resolveAlt(chatJid, message.key.remoteJidAlt),
      participantJid: message.key.participant ?? undefined,
      fromMe: message.key.fromMe === true,
      seconds,
      raw: message,
      download: async (directory: string, index: ButtonIndex) => {
        await mkdir(directory, { recursive: true });
        const path = join(directory, recordingName(index, messageId));
        // Streamed rather than buffered: this runs on a 512MB Pi.
        const stream = await this.#download(message, {
          logger: this.#log.child({ lib: 'baileys-media' }),
          reuploadRequest: (msg) => {
            const socket = this.#socket;
            if (!socket) throw new Error('cannot re-request media while disconnected');
            return socket.updateMediaMessage(msg);
          },
        });

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
