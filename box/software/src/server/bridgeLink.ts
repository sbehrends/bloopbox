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

export type GroupSummary = { readonly id: string; readonly subject: string };

export type BridgeLink = {
  readonly connected: boolean;
  /** Ships a recording. Resolves when the bridge confirms delivery. */
  send(request: OutboundRequest): Promise<void>;
  /** Groups the linked account is in, for the admin panel's picker. [] if unavailable. */
  listGroups(): Promise<GroupSummary[]>;
  /** Starts phone-number pairing and returns the code to type into WhatsApp. */
  requestPairingCode(phone: string): Promise<{ code?: string; error?: string }>;
  sendContacts(contacts: readonly { index: ButtonIndex; jid: string }[]): void;
  markRead(index: ButtonIndex, messageIds: readonly string[]): void;
  unlink(): void;
  /** Opens the socket for a first-time link. A no-op unless the bridge is `notLinked`. */
  beginLinking(): void;
};

type PendingSend = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingGroups = {
  resolve: (groups: GroupSummary[]) => void;
  timer: NodeJS.Timeout;
};

type PendingPairing = {
  resolve: (result: { code?: string; error?: string }) => void;
  timer: NodeJS.Timeout;
};

/** WhatsApp usually answers a pairing request quickly; do not leave the panel hanging. */
const PAIRING_TIMEOUT_MS = 20_000;

/** Listing groups is a UI nicety, so give up quickly rather than blocking the admin panel. */
const GROUPS_TIMEOUT_MS = 10_000;

export function registerBridgeNamespace(options: BridgeLinkOptions): BridgeLink {
  let socket: Socket | null = null;
  let counter = 0;
  const pending = new Map<string, PendingSend>();
  const pendingGroups = new Map<string, PendingGroups>();
  const pendingPairing = new Map<string, PendingPairing>();

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
      // Group listing has no error path — an empty list means "not available".
      for (const [id, entry] of pendingGroups) {
        clearTimeout(entry.timer);
        pendingGroups.delete(id);
        entry.resolve([]);
      }
      for (const [id, entry] of pendingPairing) {
        clearTimeout(entry.timer);
        pendingPairing.delete(id);
        entry.resolve({ error: 'the WhatsApp bridge disconnected' });
      }
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

    incoming.on('wa:pairingCode', (payload: unknown) => {
      const requestId = readString(payload, 'requestId', 64);
      if (requestId === null) return;
      const entry = pendingPairing.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingPairing.delete(requestId);

      const code = readString(payload, 'code', 32);
      const error = readString(payload, 'error', 256);
      entry.resolve(code === null ? { error: error ?? 'pairing failed' } : { code });
    });

    incoming.on('wa:groups', (payload: unknown) => {
      const requestId = readString(payload, 'requestId', 64);
      if (requestId === null) return;
      const entry = pendingGroups.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingGroups.delete(requestId);
      entry.resolve(readGroups(payload));
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

    async requestPairingCode(phone: string): Promise<{ code?: string; error?: string }> {
      const active = socket;
      if (!active) return { error: 'the WhatsApp bridge is not running' };

      counter += 1;
      const requestId = createRequestId('pair', counter);

      return new Promise<{ code?: string; error?: string }>((resolvePromise) => {
        const timer = setTimeout(() => {
          pendingPairing.delete(requestId);
          resolvePromise({ error: 'WhatsApp did not answer in time' });
        }, PAIRING_TIMEOUT_MS);
        timer.unref();

        pendingPairing.set(requestId, { resolve: resolvePromise, timer });
        active.emit('wa:requestPairingCode', { requestId, phone });
      });
    },

    async listGroups(): Promise<GroupSummary[]> {
      const active = socket;
      if (!active) return [];

      counter += 1;
      const requestId = createRequestId('groups', counter);

      return new Promise<GroupSummary[]>((resolvePromise) => {
        const timer = setTimeout(() => {
          pendingGroups.delete(requestId);
          resolvePromise([]);
        }, GROUPS_TIMEOUT_MS);
        timer.unref();

        pendingGroups.set(requestId, { resolve: resolvePromise, timer });
        active.emit('wa:listGroups', { requestId });
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

    beginLinking(): void {
      socket?.emit('wa:beginLinking');
    },
  };
}

/* ---- payload validation: the bridge is trusted, but a version skew is not ---- */

const WHATSAPP_STATES: readonly WhatsAppConnectionState[] = [
  'notLinked',
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

function readGroups(payload: unknown): GroupSummary[] {
  const raw = readField(payload, 'groups');
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown): GroupSummary[] => {
    const id = readString(entry, 'id', 256);
    if (id === null) return [];
    return [{ id, subject: readString(entry, 'subject', 128) ?? id }];
  });
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
