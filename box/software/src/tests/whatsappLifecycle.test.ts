import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { DisconnectReason } from 'baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhatsAppConnectionState } from '../ipc/events.ts';
import {
  reconnectDelayMs,
  RECONNECT_BASE_MS,
  RECONNECT_JITTER,
  RECONNECT_MAX_MS,
  STABLE_CONNECTION_MS,
  VERSION_FETCH_TIMEOUT_MS,
  WhatsAppClient,
} from '../whatsapp/client.ts';
import { fakeBaileys } from './support/fakeWASocket.ts';

/**
 * The connection lifecycle, against a `FakeWASocket`: when the client reconnects, when it
 * refuses to, and that it never ends up with two sockets on one set of credentials.
 *
 * Only `setTimeout` is faked, so the reconnect ladder runs in virtual time while the one real
 * `mkdir` the client does still completes. Nothing here sleeps; `settle` polls.
 */

const silentLogger = pino({ level: 'silent' });

async function settle(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`settle timed out waiting for: ${label}`);
}

/** Lets every pending microtask and the client's real `mkdir` run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('WhatsAppClient lifecycle', () => {
  let authDirectory: string;
  let clock: number;

  beforeEach(async () => {
    authDirectory = await mkdtemp(join(tmpdir(), 'bloopbox-wa-life-'));
    clock = 1_000_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(authDirectory, { recursive: true, force: true });
  });

  function setup(options: { paired?: boolean; versionProvider?: () => Promise<undefined> } = {}): {
    baileys: ReturnType<typeof fakeBaileys>;
    client: WhatsAppClient;
    statuses: { state: WhatsAppConnectionState; detail?: string }[];
  } {
    const baileys = fakeBaileys({ paired: options.paired ?? false });
    const client = new WhatsAppClient({
      authDirectory,
      logger: silentLogger,
      socketFactory: baileys.socketFactory,
      authStateFactory: baileys.authStateFactory,
      versionProvider: options.versionProvider ?? baileys.versionProvider,
      now: () => clock,
      // No jitter, so a delay is the ladder's own number.
      random: () => 0.5,
    });
    const statuses: { state: WhatsAppConnectionState; detail?: string }[] = [];
    client.on('status', (status) => statuses.push(status));
    return { baileys, client, statuses };
  }

  describe('an unscanned QR', () => {
    it('settles in notLinked when the codes run out, instead of starting a new round', async () => {
      const { baileys, client } = setup();
      await client.start();
      await client.beginLinking();
      baileys.sockets[0]?.qr('code-1');
      expect(client.state).toBe('awaitingPairing');

      // What Baileys does once its QR refs are exhausted: `end(Boom(…, timedOut))`.
      baileys.sockets[0]?.close(DisconnectReason.timedOut);

      expect(client.state).toBe('notLinked');
      await vi.advanceTimersByTimeAsync(10 * RECONNECT_MAX_MS);
      expect(baileys.sockets).toHaveLength(1);
    });

    it('can be linked again afterwards', async () => {
      const { baileys, client } = setup();
      await client.start();
      await client.beginLinking();
      baileys.sockets[0]?.close(DisconnectReason.timedOut);

      await client.beginLinking();

      expect(baileys.sockets).toHaveLength(2);
      expect(client.state).toBe('connecting');
    });

    it('reconnects at once on restartRequired, which is how a successful scan finishes', async () => {
      const { baileys, client } = setup();
      await client.start();
      await client.beginLinking();

      baileys.sockets[0]?.close(DisconnectReason.restartRequired);
      expect(client.state).toBe('connecting');
      await vi.advanceTimersByTimeAsync(0);
      await settle(() => baileys.sockets.length === 2, 'the post-scan reconnect');
    });
  });

  describe('racing calls', () => {
    it('opens one socket for a double click on link', async () => {
      const { baileys, client } = setup();
      await client.start();

      await Promise.all([client.beginLinking(), client.beginLinking()]);

      expect(baileys.sockets).toHaveLength(1);
    });

    it('is connecting from the moment linking is asked for, not after the awaits', async () => {
      const { client } = setup();
      await client.start();

      const linking = client.beginLinking();
      expect(client.state).toBe('connecting');
      await linking;
    });

    it('opens nothing when unlinked while a connect is still waiting', async () => {
      let answer!: (version: undefined) => void;
      const { baileys, client } = setup({
        versionProvider: () =>
          new Promise<undefined>((resolve) => {
            answer = resolve;
          }),
      });
      await client.start();
      const linking = client.beginLinking();
      await drain();

      await client.unlink();
      answer(undefined);
      await linking;

      expect(baileys.sockets).toHaveLength(0);
      expect(client.state).toBe('notLinked');
    });

    it('opens nothing when stopped while a connect is still waiting', async () => {
      let answer!: (version: undefined) => void;
      const { baileys, client } = setup({
        versionProvider: () =>
          new Promise<undefined>((resolve) => {
            answer = resolve;
          }),
      });
      await client.start();
      const linking = client.beginLinking();
      await drain();

      await client.stop();
      answer(undefined);
      await linking;

      expect(baileys.sockets).toHaveLength(0);
    });

    it('cancels a pending reconnect on unlink', async () => {
      const { baileys, client } = setup({ paired: true });
      await client.start();
      baileys.sockets[0]?.open();
      baileys.sockets[0]?.close(DisconnectReason.connectionClosed);
      expect(client.state).toBe('disconnected');

      await client.unlink();
      await vi.advanceTimersByTimeAsync(10 * RECONNECT_MAX_MS);

      expect(baileys.sockets).toHaveLength(1);
      expect(client.state).toBe('notLinked');
    });

    it('ends the old socket before opening its replacement', async () => {
      const { baileys, client } = setup({ paired: true });
      await client.start();
      await client.start();

      expect(baileys.sockets).toHaveLength(2);
      expect(baileys.sockets[0]?.end).toHaveBeenCalledTimes(1);
      expect(baileys.sockets[1]?.end).not.toHaveBeenCalled();
    });

    it('ignores a superseded socket closing', async () => {
      const { baileys, client } = setup({ paired: true });
      await client.start();
      await client.start();
      baileys.sockets[1]?.open();

      baileys.sockets[0]?.close(DisconnectReason.connectionClosed);

      expect(client.state).toBe('connected');
    });

    it('lets no socket from before an unlink write credentials back', async () => {
      const { baileys, client } = setup({ paired: true });
      await client.start();
      const old = baileys.sockets[0];

      await client.unlink();
      old?.ev.emit('creds.update', {});

      expect(baileys.saveCreds).not.toHaveBeenCalled();
    });

    it('opens the socket with the bundled version when the version fetch hangs', async () => {
      const { baileys, client } = setup({
        paired: true,
        versionProvider: () => new Promise<undefined>(() => undefined),
      });
      const starting = client.start();
      await drain();
      expect(baileys.sockets).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(VERSION_FETCH_TIMEOUT_MS);
      await starting;

      expect(baileys.sockets).toHaveLength(1);
      expect(baileys.configs[0]).not.toHaveProperty('version');
    });
  });

  describe('the reconnect ladder', () => {
    it('waits the base delay after a first transient failure', async () => {
      const { baileys, client } = setup({ paired: true });
      await client.start();
      baileys.sockets[0]?.close(DisconnectReason.connectionLost);

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS - 1);
      expect(baileys.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await settle(() => baileys.sockets.length === 2, 'the first reconnect');
    });

    it('keeps backing off when each connection opens and is thrown off at once', async () => {
      const { baileys, client } = setup({ paired: true });
      await client.start();
      baileys.sockets[0]?.open();
      baileys.sockets[0]?.close(DisconnectReason.connectionClosed);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await settle(() => baileys.sockets.length === 2, 'the first reconnect');

      // Opened, then closed a second later: not a recovery, so no reset.
      baileys.sockets[1]?.open();
      clock += 1_000;
      baileys.sockets[1]?.close(DisconnectReason.connectionClosed);

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      expect(baileys.sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await settle(() => baileys.sockets.length === 3, 'the doubled reconnect');
    });

    it('forgets earlier failures once a connection has held for a minute', async () => {
      const { baileys, client } = setup({ paired: true });
      await client.start();
      baileys.sockets[0]?.close(DisconnectReason.connectionClosed);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await settle(() => baileys.sockets.length === 2, 'the first reconnect');

      baileys.sockets[1]?.open();
      clock += STABLE_CONNECTION_MS;
      baileys.sockets[1]?.close(DisconnectReason.connectionClosed);

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await settle(() => baileys.sockets.length === 3, 'a reconnect at the base delay again');
      expect(client.state).toBe('connecting');
    });

    it.each([
      ['connectionReplaced', DisconnectReason.connectionReplaced, /another device/],
      ['forbidden', DisconnectReason.forbidden, /refused/],
    ])('does not retry %s, and says why', async (_name, code, detail) => {
      const { baileys, client, statuses } = setup({ paired: true });
      await client.start();
      baileys.sockets[0]?.open();

      baileys.sockets[0]?.close(code);
      await vi.advanceTimersByTimeAsync(10 * RECONNECT_MAX_MS);

      expect(baileys.sockets).toHaveLength(1);
      expect(client.state).toBe('disconnected');
      expect(statuses.at(-1)?.detail).toMatch(detail);
    });

    it('still settles a paired device that is logged out in notLinked and drops its credentials', async () => {
      const { baileys, client } = setup({ paired: true });
      await client.start();
      baileys.sockets[0]?.open();

      baileys.sockets[0]?.close(DisconnectReason.loggedOut);
      await vi.advanceTimersByTimeAsync(10 * RECONNECT_MAX_MS);

      expect(client.state).toBe('notLinked');
      expect(baileys.sockets).toHaveLength(1);
    });
  });
});

describe('reconnectDelayMs', () => {
  it('doubles from the base and stops at the cap', () => {
    expect(reconnectDelayMs(0, 0.5)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelayMs(1, 0.5)).toBe(RECONNECT_BASE_MS * 2);
    expect(reconnectDelayMs(10, 0.5)).toBe(RECONNECT_MAX_MS);
  });

  it('jitters by at most the declared fraction either way', () => {
    const low = reconnectDelayMs(3, 0);
    const high = reconnectDelayMs(3, 0.999_999);
    const base = RECONNECT_BASE_MS * 8;

    expect(low).toBe(Math.round(base * (1 - RECONNECT_JITTER)));
    expect(high).toBeLessThanOrEqual(Math.round(base * (1 + RECONNECT_JITTER)));
    expect(high).toBeGreaterThan(base);
  });
});
