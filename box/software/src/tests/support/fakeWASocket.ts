import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { initAuthCreds, type AuthenticationState, type BaileysEventMap } from 'baileys';
import { vi } from 'vitest';
import type { AuthStateFactory, ClientSocket, MediaDownloader } from '../../whatsapp/client.ts';

/**
 * A stand-in for a Baileys socket, enough to drive `WhatsAppClient` through its lifecycle
 * without a WhatsApp account.
 *
 * `ev` is a real EventEmitter rather than a mock that records `on` calls, so a test says what
 * WhatsApp did — `socket.emit('connection.update', …)` — and the client reacts exactly as it
 * would to the library. Every method is a `vi.fn` with the real signature, so a test can script
 * an answer or assert on a call without a cast.
 */
export class FakeEventStream {
  readonly #emitter = new EventEmitter();

  on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void {
    this.#emitter.on(event, listener);
  }

  emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]): void {
    this.#emitter.emit(event, arg);
  }

  listenerCount(event: keyof BaileysEventMap): number {
    return this.#emitter.listenerCount(event);
  }
}

export class FakeWASocket implements ClientSocket {
  readonly ev = new FakeEventStream();
  readonly end = vi.fn<ClientSocket['end']>(() => Promise.resolve());
  readonly logout = vi.fn<ClientSocket['logout']>(() => Promise.resolve());
  readonly sendMessage = vi.fn<ClientSocket['sendMessage']>(() => Promise.resolve(undefined));
  readonly readMessages = vi.fn<ClientSocket['readMessages']>(() => Promise.resolve());
  readonly requestPairingCode = vi.fn<ClientSocket['requestPairingCode']>(() =>
    Promise.resolve('FAKECODE'),
  );
  readonly groupFetchAllParticipating = vi.fn<ClientSocket['groupFetchAllParticipating']>(() =>
    Promise.resolve({}),
  );
  readonly updateMediaMessage = vi.fn<ClientSocket['updateMediaMessage']>((message) =>
    Promise.resolve(message),
  );
  readonly getPNForLID = vi.fn<(lid: string) => Promise<string | null>>(() =>
    Promise.resolve(null),
  );
  readonly signalRepository = { lidMapping: { getPNForLID: this.getPNForLID } };

  /** The socket opened: WhatsApp accepted the credentials. */
  open(): void {
    this.ev.emit('connection.update', { connection: 'open' });
  }

  /** The socket closed, for the reason Baileys reports with this status code. */
  close(statusCode?: number): void {
    const error =
      statusCode === undefined
        ? undefined
        : Object.assign(new Error(`closed with ${String(statusCode)}`), { output: { statusCode } });
    this.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error, date: new Date() },
    });
  }

  qr(code: string): void {
    this.ev.emit('connection.update', { qr: code });
  }
}

/**
 * Everything `WhatsAppClient` injects, recording what it did.
 *
 * `sockets` holds every socket the client opened, in order, so "did it reconnect" is a length
 * and "which one is live" is the last element.
 */
export function fakeBaileys(options: { paired?: boolean } = {}): {
  readonly sockets: FakeWASocket[];
  readonly socketFactory: () => FakeWASocket;
  readonly authStateFactory: AuthStateFactory;
  readonly versionProvider: () => Promise<undefined>;
  readonly download: ReturnType<typeof vi.fn<MediaDownloader>>;
  readonly saveCreds: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly creds: AuthenticationState['creds'];
} {
  const sockets: FakeWASocket[] = [];
  const creds = initAuthCreds();
  if (options.paired === true) creds.registered = true;
  const saveCreds = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const state: AuthenticationState = {
    creds,
    keys: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
  };
  return {
    sockets,
    socketFactory: () => {
      const socket = new FakeWASocket();
      sockets.push(socket);
      return socket;
    },
    authStateFactory: () => Promise.resolve({ state, saveCreds }),
    versionProvider: () => Promise.resolve(undefined),
    download: vi.fn<MediaDownloader>(() => Promise.resolve(Readable.from([Buffer.from('ogg')]))),
    saveCreds,
    creds,
  };
}
