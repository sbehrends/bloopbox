import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IoServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { serveSocketsOn } from '../server/socketListeners.ts';

/**
 * One Socket.io server on two listeners, as `hardware-server.ts` runs it on `:3000` and `:80`.
 *
 * Real sockets throughout: what is being tested is which HTTP server answers the handshake, and
 * that does not exist without one.
 */

const opened: { servers: HttpServer[]; clients: ClientSocket[]; io: IoServer | null } = {
  servers: [],
  clients: [],
  io: null,
};

afterEach(async () => {
  for (const client of opened.clients) client.disconnect();
  await opened.io?.close();
  await Promise.all(
    opened.servers.map(
      async (server) =>
        new Promise<void>((closed) => {
          server.close(() => closed());
        }),
    ),
  );
  opened.servers = [];
  opened.clients = [];
  opened.io = null;
});

async function listen(server: HttpServer): Promise<string> {
  opened.servers.push(server);
  await new Promise<void>((listening) => {
    server.listen(0, '127.0.0.1', listening);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function connect(url: string): Promise<ClientSocket> {
  return new Promise<ClientSocket>((resolve, reject) => {
    const client = ioClient(url, { transports: ['websocket'], reconnection: false });
    opened.clients.push(client);
    client.on('connect', () => resolve(client));
    client.on('connect_error', reject);
  });
}

describe('serveSocketsOn', () => {
  it('answers on the second listener, and one broadcast reaches clients on both', async () => {
    const primary = createServer();
    const portal = createServer();
    const io = new IoServer(primary);
    opened.io = io;
    serveSocketsOn(io, portal);
    const primaryUrl = await listen(primary);
    const portalUrl = await listen(portal);

    const onPrimary = await connect(primaryUrl);
    const onPortal = await connect(portalUrl);

    const heard = Promise.all(
      [onPrimary, onPortal].map(
        async (client) =>
          new Promise<unknown>((received) => {
            client.once('status', received);
          }),
      ),
    );
    io.emit('status', { state: 'READY' });
    expect(await heard).toEqual([{ state: 'READY' }, { state: 'READY' }]);
  });

  it('keeps namespaces shared, so the bridge namespace still has one set of sockets', async () => {
    const primary = createServer();
    const portal = createServer();
    const io = new IoServer(primary);
    opened.io = io;
    serveSocketsOn(io, portal);
    await listen(primary);
    const portalUrl = await listen(portal);

    const joined = new Promise<void>((resolve) => {
      io.of('/bridge').once('connection', () => resolve());
    });
    await connect(`${portalUrl}/bridge`);
    await joined;
    expect(io.of('/bridge').sockets.size).toBe(1);
  });
});
