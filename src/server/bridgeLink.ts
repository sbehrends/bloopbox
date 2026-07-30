import type { Namespace, Socket } from 'socket.io';
import type { ButtonIndex } from '../config/schema.ts';
import type { OutboundRequest } from '../core/deviceController.ts';
import {
  BRIDGE_AUTH_HEADER,
  createRequestId,
  type WhatsAppConnectionState,
} from '../ipc/events.ts';
import {
  optionalString,
  readButtonIndex,
  readField,
  readNumber,
  readString,
} from '../ipc/payload.ts';
import { tokensMatch } from './auth.ts';

/**
 * Server side of the hardware-server ⇄ WhatsApp-bridge link.
 *
 * The bridge connects as a Socket.io client on localhost. Only one bridge is expected; a
 * second connection replaces the first, which is what happens naturally when systemd
 * restarts the daemon.
 */

/** A send is abandoned if the bridge does not acknowledge it in this long. */
export const SEND_TIMEOUT_MS = 60_000;

export type IncomingNote = {
  readonly index: ButtonIndex;
  readonly messageId: string;
  readonly path: string;
  readonly durationMs: number | null;
  readonly receivedAt: number;
};

export type BridgeLinkOptions = {
  readonly namespace: Namespace;
  /** Shared secret the bridge must present. Empty disables the check (dev only). */
  readonly token: string;
  readonly onStatus: (payload: {
    state: WhatsAppConnectionState;
    detail?: string;
    qr?: string;
  }) => void;
  readonly onIncoming: (payload: IncomingNote) => void;
  readonly onConnectionChange: (connected: boolean) => void;
};

export type BridgeLink = {
  readonly connected: boolean;
  /** Ships a recording. Resolves when the bridge confirms delivery. */
  send(request: OutboundRequest): Promise<void>;
  sendContacts(contacts: readonly { index: ButtonIndex; jid: string }[]): void;
  markRead(index: ButtonIndex, messageIds: readonly string[]): void;
  unlink(): void;
};

type PendingSend = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export function registerBridgeNamespace(options: BridgeLinkOptions): BridgeLink {
  let socket: Socket | null = null;
  let counter = 0;
  const pending = new Map<string, PendingSend>();

  const failAllPending = (reason: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(reason));
    }
  };

  options.namespace.use((incoming, next) => {
    if (options.token.length === 0) {
      next();
      return;
    }
    const header = incoming.handshake.headers[BRIDGE_AUTH_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (typeof provided === 'string' && tokensMatch(provided, options.token)) {
      next();
      return;
    }
    next(new Error('bridge authentication failed'));
  });

  options.namespace.on('connection', (incoming) => {
    // A restarting bridge reconnects; the newest socket wins.
    if (socket && socket.id !== incoming.id) socket.disconnect(true);
    socket = incoming;
    options.onConnectionChange(true);

    incoming.on('disconnect', () => {
      if (socket?.id !== incoming.id) return;
      socket = null;
      failAllPending('bridge disconnected');
      options.onConnectionChange(false);
    });

    incoming.on('wa:status', (payload: unknown) => {
      const state = readWhatsAppState(payload);
      if (!state) return;
      options.onStatus({
        state,
        ...optionalString(payload, 'detail'),
        ...optionalString(payload, 'qr', 'qr'),
      });
    });

    incoming.on('wa:incoming', (payload: unknown) => {
      const note = readIncoming(payload);
      if (note) options.onIncoming(note);
    });

    incoming.on('wa:sendResult', (payload: unknown) => {
      const requestId = readString(payload, 'requestId');
      if (requestId === null) return;

      const entry = pending.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(requestId);

      if (readField(payload, 'ok') === true) entry.resolve();
      else entry.reject(new Error(readString(payload, 'error') ?? 'send failed'));
    });
  });

  return {
    get connected(): boolean {
      return socket !== null;
    },

    async send(request: OutboundRequest): Promise<void> {
      const active = socket;
      if (!active) throw new Error('bridge is not connected');

      counter += 1;
      const requestId = createRequestId('send', counter);

      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          rejectPromise(new Error(`bridge did not acknowledge ${requestId}`));
        }, SEND_TIMEOUT_MS);
        timer.unref();

        pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timer });
        active.emit('wa:send', { requestId, index: request.index, path: request.path });
      });
    },

    sendContacts(contacts): void {
      socket?.emit('wa:contactsChanged', { contacts });
    },

    markRead(index, messageIds): void {
      if (messageIds.length === 0) return;
      socket?.emit('wa:markRead', { index, messageIds });
    },

    unlink(): void {
      socket?.emit('wa:unlink');
    },
  };
}

/* ---- payload validation: the bridge is trusted, but a version skew is not ---- */

const WHATSAPP_STATES: readonly WhatsAppConnectionState[] = [
  'connecting',
  'connected',
  'awaitingPairing',
  'loggedOut',
  'disconnected',
];

function readWhatsAppState(payload: unknown): WhatsAppConnectionState | null {
  const value = readField(payload, 'state');
  return WHATSAPP_STATES.find((state) => state === value) ?? null;
}

function readIncoming(payload: unknown): IncomingNote | null {
  const index = readButtonIndex(payload);
  if (index === null) return null;

  const messageId = readString(payload, 'messageId', 128);
  const path = readString(payload, 'path', 1024);
  if (messageId === null || path === null) return null;

  return {
    index,
    messageId,
    path,
    durationMs: readNumber(payload, 'durationMs'),
    receivedAt: readNumber(payload, 'receivedAt') ?? Date.now(),
  };
}
