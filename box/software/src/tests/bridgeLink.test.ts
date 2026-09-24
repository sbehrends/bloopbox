import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IoServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import {
  BRIDGE_AUTH_HEADER,
  BRIDGE_NAMESPACE,
  createRequestId,
  REQUEST_ID_BOOT,
} from '../ipc/events.ts';
import {
  registerBridgeNamespace,
  type BridgeLink,
  type IncomingNote,
} from '../server/bridgeLink.ts';

/**
 * The hardware-server side of the link to the WhatsApp bridge.
 *
 * Two things make this worth driving over a real socket rather than calling functions: the
 * token gate is Socket.io middleware, so it only exists during a handshake, and the payload
 * validation guards a **version skew** between two independently restarting processes — the
 * case where a bridge from a different release sends a shape this one has never seen. A
 * malformed message must be dropped, never crash the daemon that owns the audio devices.
 *
 * Not covered here: the three timeout paths (send 60s, pairing 20s, groups 10s). They need
 * fake timers, which do not mix with real sockets. Reaching them means an unresponsive bridge,
 * and each one is four lines that resolve or reject a pending map entry.
 */

type Rig = {
  readonly link: BridgeLink;
  readonly statuses: { state: string; detail?: string; qr?: string }[];
  readonly incoming: IncomingNote[];
  readonly revoked: { index: number; messageId: string }[];
  readonly connectionChanges: boolean[];
  /** Opens a bridge client. Rejects with the handshake error when the token is refused. */
  connect: (token?: string) => Promise<ClientSocket>;
  close: () => Promise<void>;
};

async function startRig(token = ''): Promise<Rig> {
  const httpServer: HttpServer = createServer();
  const server = new IoServer(httpServer);
  const statuses: { state: string; detail?: string; qr?: string }[] = [];
  const incoming: IncomingNote[] = [];
  const revoked: { index: number; messageId: string }[] = [];
  const connectionChanges: boolean[] = [];

  const link = registerBridgeNamespace({
    namespace: server.of(BRIDGE_NAMESPACE),
    token,
    onStatus: (payload) => statuses.push(payload),
    onIncoming: (note) => incoming.push(note),
    onRevoked: (note) => revoked.push(note),
    onConnectionChange: (connected) => connectionChanges.push(connected),
  });

  await new Promise<void>((listening) => {
    httpServer.listen(0, '127.0.0.1', listening);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${String(address.port)}${BRIDGE_NAMESPACE}`;

  const clients: ClientSocket[] = [];

  return {
    link,
    statuses,
    incoming,
    revoked,
    connectionChanges,
    connect: (provided) =>
      new Promise<ClientSocket>((resolve, reject) => {
        // Websocket with extraHeaders, exactly as whatsapp-bridge.ts connects. In Node the
        // header survives the upgrade; in a browser it would not, which is why the bridge is
        // a Node process and not a page.
        const client = ioClient(url, {
          transports: ['websocket'],
          extraHeaders: provided === undefined ? {} : { [BRIDGE_AUTH_HEADER]: provided },
          reconnection: false,
        });
        clients.push(client);
        client.on('connect', () => resolve(client));
        client.on('connect_error', (error: Error) => reject(error));
      }),
    close: async () => {
      for (const client of clients) client.disconnect();
      await server.close();
      await new Promise<void>((closed) => {
        httpServer.close(() => closed());
      });
    },
  };
}

/** Waits for a condition the far side has to deliver over the socket. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let rig: Rig | null = null;

afterEach(async () => {
  await rig?.close();
  rig = null;
});

describe('the token gate', () => {
  it('refuses a connection with no token when one is configured', async () => {
    rig = await startRig('shared-secret');
    await expect(rig.connect()).rejects.toThrow(/bridge authentication failed/);
    expect(rig.connectionChanges).toEqual([]);
  });

  it('refuses a wrong token', async () => {
    rig = await startRig('shared-secret');
    await expect(rig.connect('wrong-secret')).rejects.toThrow(/bridge authentication failed/);
  });

  it('accepts the right token', async () => {
    rig = await startRig('shared-secret');
    await rig.connect('shared-secret');
    await waitFor(() => rig?.link.connected === true, 'the link to report connected');
    expect(rig.connectionChanges).toEqual([true]);
  });

  it('lets everything in when no token is configured, which is the dev default', async () => {
    // Recorded rather than endorsed: BRIDGE_TOKEN defaults to '' and the check is skipped
    // entirely. What protects the socket then is that it only listens on localhost.
    rig = await startRig('');
    await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');
    expect(rig.connectionChanges).toEqual([true]);
  });
});

describe('one bridge at a time', () => {
  it('hands over to the newest connection, because that is what a restart looks like', async () => {
    rig = await startRig();
    const first = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'the first bridge');

    const second = await rig.connect();
    await waitFor(() => !first.connected, 'the first bridge to be dropped');

    // Still connected: the newest socket owns the link, and the old one's disconnect must not
    // clear it — that would leave a live bridge the daemon thinks is gone.
    expect(rig.link.connected).toBe(true);
    expect(second.connected).toBe(true);
  });
});

describe('send', () => {
  it('refuses when no bridge is connected', async () => {
    rig = await startRig();
    await expect(rig.link.send({ index: 0, path: '/tmp/a.ogg', durationMs: 900 })).rejects.toThrow(
      /bridge is not connected/,
    );
  });

  it('resolves when the bridge confirms', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.on('wa:send', (payload: { requestId: string; index: number; path: string }) => {
      expect(payload.index).toBe(1);
      expect(payload.path).toBe('/tmp/note.ogg');
      client.emit('wa:sendResult', { requestId: payload.requestId, ok: true });
    });

    await expect(
      rig.link.send({ index: 1, path: '/tmp/note.ogg', durationMs: 1200 }),
    ).resolves.toBeUndefined();
  });

  it('rejects with the reason the bridge gave', async () => {
    // The reason reaches the LED pattern and the logs; inventing a generic one here would
    // lose the only explanation of why a child's message did not arrive.
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.on('wa:send', (payload: { requestId: string }) => {
      client.emit('wa:sendResult', {
        requestId: payload.requestId,
        ok: false,
        error: 'not on whatsapp',
      });
    });

    await expect(rig.link.send({ index: 0, path: '/tmp/a.ogg', durationMs: 900 })).rejects.toThrow(
      /not on whatsapp/,
    );
  });

  it('ignores a result for a request it never made', async () => {
    // A stale acknowledgement from a bridge that reconnected mid-send. Must not throw inside
    // the socket handler, which would take the daemon down.
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.emit('wa:sendResult', { requestId: 'send-999', ok: true });
    client.emit('wa:sendResult', {});
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(rig.link.connected).toBe(true);
  });

  it('is not resolved by a result for the same counter from an earlier boot', async () => {
    /*
     * The bridge outlives the hardware server, which restarts on every config save and counts
     * from 1 again. A result for the previous boot's first send, still in flight across the
     * restart, carries the id this boot's first send would have had without the boot prefix.
     * If it resolved the new send, a note that failed would be reported delivered.
     */
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.on('wa:send', (payload: { requestId: string }) => {
      expect(payload.requestId).not.toBe('send-1');
      // Socket.io delivers in order, so the stale one arrives first and must be ignored.
      client.emit('wa:sendResult', { requestId: 'send-1', ok: true });
      client.emit('wa:sendResult', { requestId: 'send-0a1b2c3d-1', ok: true });
      client.emit('wa:sendResult', { requestId: payload.requestId, ok: false, error: 'real' });
    });

    await expect(rig.link.send({ index: 0, path: '/tmp/a.ogg', durationMs: 900 })).rejects.toThrow(
      /real/,
    );
  });

  it('fails every pending send when the bridge goes away', async () => {
    // Otherwise the controller waits 60s per message while the LED says nothing is wrong.
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    // Swallow the send so it stays pending, then drop the socket.
    client.on('wa:send', () => client.disconnect());
    await expect(rig.link.send({ index: 0, path: '/tmp/a.ogg', durationMs: 900 })).rejects.toThrow(
      /bridge disconnected/,
    );
    await waitFor(() => rig?.link.connected === false, 'the link to report disconnected');
    expect(rig.connectionChanges).toEqual([true, false]);
  });
});

describe('status from the bridge', () => {
  it('forwards a known state, with the detail and QR when present', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.emit('wa:status', { state: 'awaitingPairing', qr: '2@abc', detail: 'scan me' });
    await waitFor(() => (rig?.statuses.length ?? 0) > 0, 'a status');
    expect(rig.statuses[0]).toEqual({
      state: 'awaitingPairing',
      qr: '2@abc',
      detail: 'scan me',
    });
  });

  it('omits detail and QR rather than sending undefined', async () => {
    // exactOptionalPropertyTypes: an explicit undefined is not the same as absent, and the
    // process layer stores this straight into the status payload.
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.emit('wa:status', { state: 'connected' });
    await waitFor(() => (rig?.statuses.length ?? 0) > 0, 'a status');
    expect(Object.keys(rig.statuses[0] ?? {})).toEqual(['state']);
  });

  it('drops a state it does not recognise, which is what a version skew looks like', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    for (const state of ['reconnecting', '', 42, null, undefined]) {
      client.emit('wa:status', { state });
    }
    client.emit('wa:status', {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(rig.statuses).toEqual([]);
  });
});

describe('an incoming voice note', () => {
  it('is forwarded once it is complete', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.emit('wa:incoming', {
      index: 2,
      messageId: 'ABC123',
      path: '/run/bloopbox/in.ogg',
      durationMs: 1500,
      receivedAt: 1_700_000_000_000,
    });
    await waitFor(() => (rig?.incoming.length ?? 0) > 0, 'the note');
    expect(rig.incoming[0]).toEqual({
      index: 2,
      messageId: 'ABC123',
      path: '/run/bloopbox/in.ogg',
      durationMs: 1500,
      receivedAt: 1_700_000_000_000,
    });
  });

  it('defaults a missing timestamp to now rather than dropping the note', async () => {
    // The 48h purge and the unread queue both key off this; a note without one is still a
    // message a child should hear.
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    const before = Date.now();
    client.emit('wa:incoming', { index: 0, messageId: 'X', path: '/tmp/x.ogg' });
    await waitFor(() => (rig?.incoming.length ?? 0) > 0, 'the note');
    expect(rig.incoming[0]?.durationMs).toBeNull();
    expect(rig.incoming[0]?.receivedAt).toBeGreaterThanOrEqual(before);
  });

  it('drops a note missing anything it cannot do without', async () => {
    // A note with no path is a queue entry that can never play, and an out-of-range index
    // would be written past the ends of the LED and unread arrays.
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    const bad: unknown[] = [
      { messageId: 'X', path: '/tmp/x.ogg' },
      { index: 7, messageId: 'X', path: '/tmp/x.ogg' },
      { index: 0, path: '/tmp/x.ogg' },
      { index: 0, messageId: 'X' },
      { index: 0, messageId: 'X', path: '' },
      {},
      null,
    ];
    for (const payload of bad) client.emit('wa:incoming', payload);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(rig.incoming).toEqual([]);
    expect(rig.link.connected).toBe(true);
  });
});

describe('wa:revoked', () => {
  it('hands a well-formed revoke to the hardware side, and drops a malformed one', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    for (const payload of [{ messageId: 'X' }, { index: 5, messageId: 'X' }, null]) {
      client.emit('wa:revoked', payload);
    }
    client.emit('wa:revoked', { index: 1, messageId: 'ABC123' });
    await waitFor(() => (rig?.revoked.length ?? 0) > 0, 'the revoke');

    expect(rig.revoked).toEqual([{ index: 1, messageId: 'ABC123' }]);
  });
});

describe('listGroups', () => {
  it('is an empty list when the bridge is not running, not an error', async () => {
    // The admin panel degrades to "link WhatsApp first" on an empty list; an exception here
    // would blank the contacts form instead.
    rig = await startRig();
    await expect(rig.link.listGroups()).resolves.toEqual([]);
  });

  it('returns the groups the bridge reported', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.on('wa:listGroups', (payload: { requestId: string }) => {
      client.emit('wa:groups', {
        requestId: payload.requestId,
        groups: [
          { id: '111@g.us', subject: 'Familia' },
          // No subject: the JID is a worse label than a name but better than nothing.
          { id: '222@g.us' },
          // No id: not addressable, so not a target.
          { subject: 'Ghost' },
        ],
      });
    });

    await expect(rig.link.listGroups()).resolves.toEqual([
      { id: '111@g.us', subject: 'Familia' },
      { id: '222@g.us', subject: '222@g.us' },
    ]);
  });

  it('resolves empty when the bridge disconnects mid-request', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.on('wa:listGroups', () => client.disconnect());
    await expect(rig.link.listGroups()).resolves.toEqual([]);
  });
});

describe('requestPairingCode', () => {
  it('explains itself when the bridge is not running', async () => {
    rig = await startRig();
    await expect(rig.link.requestPairingCode('15551234567')).resolves.toEqual({
      error: 'the WhatsApp bridge is not running',
    });
  });

  it('returns the code', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.on('wa:requestPairingCode', (payload: { requestId: string; phone: string }) => {
      expect(payload.phone).toBe('15551234567');
      client.emit('wa:pairingCode', { requestId: payload.requestId, code: 'ABCD-EFGH' });
    });

    await expect(rig.link.requestPairingCode('15551234567')).resolves.toEqual({
      code: 'ABCD-EFGH',
    });
  });

  it('passes the failure through, and invents one only when there is none', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.on('wa:requestPairingCode', (payload: { requestId: string }) => {
      client.emit('wa:pairingCode', { requestId: payload.requestId, error: 'rate limited' });
    });
    await expect(rig.link.requestPairingCode('1')).resolves.toEqual({ error: 'rate limited' });
  });

  it('resolves with an error when the bridge disconnects mid-request', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    client.on('wa:requestPairingCode', () => client.disconnect());
    await expect(rig.link.requestPairingCode('1')).resolves.toEqual({
      error: 'the WhatsApp bridge disconnected',
    });
  });
});

describe('fire-and-forget messages to the bridge', () => {
  it('sends contacts, markRead, unlink and beginLinking', async () => {
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    const seen: string[] = [];
    client.on('wa:contactsChanged', () => seen.push('contacts'));
    client.on('wa:markRead', () => seen.push('markRead'));
    client.on('wa:unlink', () => seen.push('unlink'));
    client.on('wa:beginLinking', () => seen.push('beginLinking'));

    rig.link.sendContacts([{ index: 0, jid: '1@s.whatsapp.net' }]);
    rig.link.markRead(0, ['A']);
    rig.link.unlink();
    rig.link.beginLinking();

    await waitFor(() => seen.length === 4, 'all four messages');
    expect(seen).toEqual(['contacts', 'markRead', 'unlink', 'beginLinking']);
  });

  it('does not send an empty markRead', async () => {
    // Nothing to mark; the round trip would wake the bridge for no reason.
    rig = await startRig();
    const client = await rig.connect();
    await waitFor(() => rig?.link.connected === true, 'connected');

    let calls = 0;
    client.on('wa:markRead', () => {
      calls += 1;
    });
    rig.link.markRead(0, []);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(0);
  });

  it('is silent rather than throwing when no bridge is connected', async () => {
    rig = await startRig();
    rig.link.sendContacts([{ index: 0, jid: '1@s.whatsapp.net' }]);
    rig.link.markRead(0, ['A']);
    rig.link.unlink();
    expect(rig.link.connected).toBe(false);
  });
});

describe('request ids', () => {
  it('carry the boot they were issued in', () => {
    expect(createRequestId('send', 1)).toBe(`send-${REQUEST_ID_BOOT}-1`);
    expect(REQUEST_ID_BOOT).toMatch(/^[0-9a-f]{8}$/);
  });

  it('differ between two boots for the same counter', async () => {
    // A fresh module instance is what a restarted process is, as far as this constant goes.
    vi.resetModules();
    const again = await import('../ipc/events.ts');
    expect(again.REQUEST_ID_BOOT).not.toBe(REQUEST_ID_BOOT);
    expect(again.createRequestId('send', 1)).not.toBe(createRequestId('send', 1));
  });
});
