import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferJSON, DisconnectReason, initAuthCreds } from 'baileys';
import type * as Baileys from 'baileys';

/**
 * The pure parts of the Baileys client, plus the two behaviours that keep it from talking to
 * WhatsApp before it should.
 *
 * Most of `WhatsAppClient` needs a live, paired WhatsApp account and is exercised by hand — see
 * `docs/hardware-bringup.md`. What is covered here, via a mocked `makeWASocket`, is: how the
 * device reacts to a disconnect (retry vs. "we have been unlinked, throw the credentials away");
 * that only one `requestPairingCode` call can be in flight at a time, since two together each
 * overwrite `creds.me`/`creds.pairingCode` on the same socket; and that `start()` does not open a
 * socket for an unregistered device at all — opening one is what makes Baileys start generating
 * a QR nobody asked for, so it waits in `notLinked` until `beginLinking()` says otherwise.
 */

type FakeSocket = {
  ev: { on: ReturnType<typeof vi.fn<(event: string, cb: (payload: unknown) => void) => void>> };
  end: ReturnType<typeof vi.fn<() => undefined>>;
  requestPairingCode: ReturnType<typeof vi.fn<(phone: string) => Promise<string>>>;
};

const { makeWASocketMock, fetchLatestBaileysVersionMock } = vi.hoisted(() => ({
  makeWASocketMock: vi.fn<() => FakeSocket>(),
  fetchLatestBaileysVersionMock: vi.fn<() => Promise<{ version: undefined }>>(() =>
    Promise.resolve({ version: undefined }),
  ),
}));

vi.mock('baileys', async (importOriginal) => {
  const original = await importOriginal<typeof Baileys>();
  return {
    ...original,
    makeWASocket: makeWASocketMock,
    fetchLatestBaileysVersion: fetchLatestBaileysVersionMock,
  };
});

const { extractStatusCode, WhatsAppClient } = await import('../whatsapp/client.ts');

function createFakeSocket(): FakeSocket {
  return {
    ev: { on: vi.fn<(event: string, cb: (payload: unknown) => void) => void>() },
    end: vi.fn<() => undefined>(),
    requestPairingCode: vi.fn<(phone: string) => Promise<string>>(),
  };
}

// A real, silenced logger satisfies pino's full `Logger` type without an unsafe cast.
const silentLogger = pino({ level: 'silent' });

/** Writes credentials that look like a completed pairing, the way Baileys itself would. */
async function markRegistered(authDirectory: string): Promise<void> {
  const creds = initAuthCreds();
  creds.registered = true;
  await writeFile(join(authDirectory, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer));
}

describe('extractStatusCode', () => {
  it('reads the code out of a Boom-shaped error, which is how Baileys reports why', () => {
    const boom = Object.assign(new Error('Connection Closed'), {
      output: { statusCode: DisconnectReason.connectionClosed },
    });

    expect(extractStatusCode(boom)).toBe(428);
  });

  it('identifies a logout, the one case where credentials must be deleted', () => {
    const boom = Object.assign(new Error('Logged Out'), {
      output: { statusCode: DisconnectReason.loggedOut },
    });

    expect(extractStatusCode(boom)).toBe(DisconnectReason.loggedOut);
    expect(extractStatusCode(boom)).toBe(401);
  });

  it('returns undefined for anything not shaped like a Boom error', () => {
    // Treated as a transient failure, which is the safe default: retry rather than
    // discarding a pairing over an error we did not recognise.
    for (const value of [
      undefined,
      null,
      'a string',
      new Error('plain'),
      { output: null },
      { output: {} },
      { output: { statusCode: 'not a number' } },
    ]) {
      expect(extractStatusCode(value)).toBeUndefined();
    }
  });

  it('covers every reason Baileys can report', () => {
    // A guard against the enum changing shape under us in a future release candidate.
    for (const [name, code] of Object.entries(DisconnectReason)) {
      if (typeof code !== 'number') continue;
      const boom = Object.assign(new Error(name), { output: { statusCode: code } });
      expect(extractStatusCode(boom)).toBe(code);
    }
  });
});

describe('WhatsAppClient#requestPairingCode', () => {
  let authDirectory: string;
  let sockets: FakeSocket[];

  beforeEach(async () => {
    authDirectory = await mkdtemp(join(tmpdir(), 'bloopbox-wa-test-'));
    sockets = [];
    makeWASocketMock.mockReset();
    makeWASocketMock.mockImplementation(() => {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    });
  });

  afterEach(async () => {
    await rm(authDirectory, { recursive: true, force: true });
  });

  it('normalises the phone number before handing it to Baileys', async () => {
    const client = new WhatsAppClient({ authDirectory, logger: silentLogger });
    await client.start();
    await client.beginLinking();

    sockets[0]?.requestPairingCode.mockResolvedValueOnce('CODE0001');
    // "0049…" is the international-dialling spelling of "+49…" — both must reduce to the same
    // bare digits, or a parent who types either gets a code for no one and a generic failure
    // from WhatsApp with nothing pointing back at the actual mistake.
    await client.requestPairingCode('0049 151 23456789');

    expect(sockets[0]?.requestPairingCode).toHaveBeenCalledWith('4915123456789');
  });

  it('rejects a phone number with a surviving leading 0 rather than guessing a country code', async () => {
    const client = new WhatsAppClient({ authDirectory, logger: silentLogger });
    await client.start();
    await client.beginLinking();

    await expect(client.requestPairingCode('015123456789')).rejects.toThrow(/no leading 0/);
    expect(sockets[0]?.requestPairingCode).not.toHaveBeenCalled();
  });

  it('rejects a second request while the first is still waiting on WhatsApp', async () => {
    const client = new WhatsAppClient({ authDirectory, logger: silentLogger });
    await client.start();
    await client.beginLinking();

    let resolveFirst!: (code: string) => void;
    sockets[0]?.requestPairingCode.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveFirst = resolve;
      }),
    );

    const first = client.requestPairingCode('15551234567');
    await expect(client.requestPairingCode('15551234567')).rejects.toThrow(/already requesting/);

    resolveFirst('ABCD1234');
    await expect(first).resolves.toBe('ABCD1234');

    // The lock clears once the in-flight request settles, so a later one is not stuck forever.
    sockets[0]?.requestPairingCode.mockResolvedValueOnce('WXYZ5678');
    await expect(client.requestPairingCode('15551234567')).resolves.toBe('WXYZ5678');
  });

  it('clears a stuck lock on reconnect, so a hung request cannot block pairing forever', async () => {
    const client = new WhatsAppClient({ authDirectory, logger: silentLogger });
    await client.start();
    await client.beginLinking();

    // Never settles — stands in for a request WhatsApp's servers never answered.
    sockets[0]?.requestPairingCode.mockReturnValueOnce(new Promise<string>(() => undefined));
    void client.requestPairingCode('15551234567').catch(() => undefined);

    await client.stop();
    await client.start();
    await client.beginLinking();

    sockets[1]?.requestPairingCode.mockResolvedValueOnce('NEWCODE1');
    await expect(client.requestPairingCode('15551234567')).resolves.toBe('NEWCODE1');
  });
});

describe('WhatsAppClient#start and #beginLinking', () => {
  let authDirectory: string;
  let sockets: FakeSocket[];

  beforeEach(async () => {
    authDirectory = await mkdtemp(join(tmpdir(), 'bloopbox-wa-test-'));
    sockets = [];
    makeWASocketMock.mockReset();
    makeWASocketMock.mockImplementation(() => {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    });
  });

  afterEach(async () => {
    await rm(authDirectory, { recursive: true, force: true });
  });

  it('does not open a socket for an unregistered device — it waits in notLinked', async () => {
    const client = new WhatsAppClient({ authDirectory, logger: silentLogger });
    await client.start();

    expect(makeWASocketMock).not.toHaveBeenCalled();
    expect(client.state).toBe('notLinked');
  });

  it('opens the socket only once beginLinking is called', async () => {
    const client = new WhatsAppClient({ authDirectory, logger: silentLogger });
    await client.start();
    await client.beginLinking();

    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('connecting');
  });

  it('beginLinking is a no-op once a socket is already open', async () => {
    const client = new WhatsAppClient({ authDirectory, logger: silentLogger });
    await client.start();
    await client.beginLinking();
    await client.beginLinking();

    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('connects immediately on start when credentials are already registered', async () => {
    await markRegistered(authDirectory);
    const client = new WhatsAppClient({ authDirectory, logger: silentLogger });
    await client.start();

    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('connecting');
  });
});
