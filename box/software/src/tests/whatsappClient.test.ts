import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BufferJSON, DisconnectReason, initAuthCreds } from 'baileys';
import {
  baileysLogLevel,
  extractStatusCode,
  isPaired,
  WhatsAppClient,
} from '../whatsapp/client.ts';
import { FakeWASocket } from './support/fakeWASocket.ts';
import { waitFor } from './support/waitFor.ts';

/**
 * The pure parts of the Baileys client, plus the two behaviours that keep it from talking to
 * WhatsApp before it should.
 *
 * Most of `WhatsAppClient` needs a live, paired WhatsApp account and is exercised by hand — see
 * `docs/hardware-bringup.md`. What is covered here, via an injected `FakeWASocket`, is: how the
 * device reacts to a disconnect (retry vs. "we have been unlinked, throw the credentials away");
 * that only one `requestPairingCode` call can be in flight at a time, since two together each
 * overwrite `creds.me`/`creds.pairingCode` on the same socket; and that `start()` does not open a
 * socket for an unregistered device at all — opening one is what makes Baileys start generating
 * a QR nobody asked for, so it waits in `notLinked` until `beginLinking()` says otherwise.
 */

/*
 * No `vi.mock('baileys')`: the client takes its socket factory as an option, and these pass a
 * `FakeWASocket` in. Auth state stays real where a test is about what lands on disk.
 */
/** A client over real auth state in `authDirectory`, opening fakes into `sockets`. */
function createClient(authDirectory: string, sockets: FakeWASocket[]): WhatsAppClient {
  return new WhatsAppClient({
    authDirectory,
    logger: silentLogger,
    socketFactory: () => {
      const socket = new FakeWASocket();
      sockets.push(socket);
      return socket;
    },
    versionProvider: () => Promise.resolve(undefined),
  });
}

// A real, silenced logger satisfies pino's full `Logger` type without an unsafe cast.
const silentLogger = pino({ level: 'silent' });

/** Writes credentials that look like a completed pairing, the way Baileys itself would. */
async function markRegistered(authDirectory: string): Promise<void> {
  const creds = initAuthCreds();
  creds.registered = true;
  await writeFile(join(authDirectory, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer));
}

/**
 * Credentials exactly as a **QR scan** leaves them: a complete, working session, and
 * `registered` still false.
 *
 * This is not a contrived shape — it is what `configureSuccessfulPairing` writes, and it was
 * read off a real device on 2026-08-10 after a scan, which is how the bug was found.
 */
function qrPairedCreds(): ReturnType<typeof initAuthCreds> {
  const creds = initAuthCreds();
  creds.me = {
    id: '15551234567:10@s.whatsapp.net',
    name: 'A Parent',
    lid: '46309042069587:10@lid',
  };
  creds.account = {
    details: new Uint8Array([1]),
    accountSignatureKey: new Uint8Array([2]),
    accountSignature: new Uint8Array([3]),
    deviceSignature: new Uint8Array([4]),
  };
  creds.platform = 'smbi';
  return creds;
}

async function markPairedByQrScan(authDirectory: string): Promise<void> {
  await writeFile(
    join(authDirectory, 'creds.json'),
    JSON.stringify(qrPairedCreds(), BufferJSON.replacer),
  );
}

/**
 * Returns `undefined` for a file caught mid-write rather than throwing.
 *
 * Not defensive padding: Baileys' `useMultiFileAuthState` saves with a plain `writeFile`,
 * which truncates before it writes, and polling this in a loop hits the empty window often
 * enough to fail the test outright. That the window is reachable at all is the point — see
 * `docs/architecture.md` (`creds.json` is written atomically).
 */
async function readRegisteredFlag(authDirectory: string): Promise<unknown> {
  const raw = await readFile(join(authDirectory, 'creds.json'), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('registered' in parsed)) return undefined;
  return parsed.registered;
}

describe('isPaired', () => {
  it('accepts the flag Baileys sets on the phone-number pairing path', () => {
    const creds = initAuthCreds();
    creds.registered = true;

    expect(isPaired(creds)).toBe(true);
  });

  it('accepts a QR-scanned session, which Baileys leaves with registered false', () => {
    // The regression this exists for: on 2026-08-10 a real device held 1544 session files, a
    // valid `me` and `account` — and reported itself as never linked after a restart, because
    // `configureSuccessfulPairing` never touches `registered`.
    const creds = qrPairedCreds();

    expect(creds.registered).toBe(false);
    expect(isPaired(creds)).toBe(true);
  });

  it('rejects a genuinely fresh credentials file', () => {
    expect(isPaired(initAuthCreds())).toBe(false);
  });

  it('rejects a half-written pairing rather than guessing', () => {
    // `me` without `account` is what `requestPairingCode` leaves behind before the code is
    // ever typed in — it sets `me` from the phone number and `registered` to false. Treating
    // that as paired would skip the QR and connect with credentials WhatsApp never accepted.
    const withoutAccount = initAuthCreds();
    withoutAccount.me = { id: '15551234567@s.whatsapp.net', name: '~' };

    expect(isPaired(withoutAccount)).toBe(false);
  });
});

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
  let sockets: FakeWASocket[];

  beforeEach(async () => {
    authDirectory = await mkdtemp(join(tmpdir(), 'bloopbox-wa-test-'));
    sockets = [];
  });

  afterEach(async () => {
    await rm(authDirectory, { recursive: true, force: true });
  });

  it('normalises the phone number before handing it to Baileys', async () => {
    const client = createClient(authDirectory, sockets);
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
    const client = createClient(authDirectory, sockets);
    await client.start();
    await client.beginLinking();

    await expect(client.requestPairingCode('015123456789')).rejects.toThrow(/no leading 0/);
    expect(sockets[0]?.requestPairingCode).not.toHaveBeenCalled();
  });

  it('rejects a second request while the first is still waiting on WhatsApp', async () => {
    const client = createClient(authDirectory, sockets);
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
    const client = createClient(authDirectory, sockets);
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
  let sockets: FakeWASocket[];

  beforeEach(async () => {
    authDirectory = await mkdtemp(join(tmpdir(), 'bloopbox-wa-test-'));
    sockets = [];
  });

  afterEach(async () => {
    await rm(authDirectory, { recursive: true, force: true });
  });

  it('does not open a socket for an unregistered device — it waits in notLinked', async () => {
    const client = createClient(authDirectory, sockets);
    await client.start();

    expect(sockets).toHaveLength(0);
    expect(client.state).toBe('notLinked');
  });

  it('opens the socket only once beginLinking is called', async () => {
    const client = createClient(authDirectory, sockets);
    await client.start();
    await client.beginLinking();

    expect(sockets).toHaveLength(1);
    expect(client.state).toBe('connecting');
  });

  it('beginLinking is a no-op once a socket is already open', async () => {
    const client = createClient(authDirectory, sockets);
    await client.start();
    await client.beginLinking();
    await client.beginLinking();

    expect(sockets).toHaveLength(1);
  });

  it('connects immediately on start when credentials are already registered', async () => {
    await markRegistered(authDirectory);
    const client = createClient(authDirectory, sockets);
    await client.start();

    expect(sockets).toHaveLength(1);
    expect(client.state).toBe('connecting');
  });

  it('reconnects a QR-scanned device instead of asking a parent to link it again', async () => {
    // The device this was found on had been linked for two minutes and was working. A crash
    // restarted the daemon, `registered` was false because the pairing came from a scan, and
    // the box offered a QR for the account it was already connected to — where scanning it
    // would have replaced the session that was sitting there intact.
    await markPairedByQrScan(authDirectory);
    const client = createClient(authDirectory, sockets);
    await client.start();

    expect(sockets).toHaveLength(1);
    expect(client.state).toBe('connecting');
  });

  it('writes the flag down once WhatsApp accepts the credentials', async () => {
    await markPairedByQrScan(authDirectory);
    const client = createClient(authDirectory, sockets);
    await client.start();

    expect(await readRegisteredFlag(authDirectory)).toBe(false);

    // Reaching `open` is WhatsApp accepting these credentials — the only proof that counts.
    sockets[0]?.open();

    await waitFor(
      async () => (await readRegisteredFlag(authDirectory)) === true,
      'the registered flag to be persisted',
    );
    expect(client.state).toBe('connected');
  });
});

describe('Baileys log level', () => {
  it('is warn unless raised on purpose, whatever LOG_LEVEL says', () => {
    // Below warn, Baileys logs full WhatsApp addresses, which no masking can reach.
    expect(baileysLogLevel(undefined)).toBe('warn');
    expect(baileysLogLevel('debug')).toBe('debug');
  });

  it('falls back on a value pino would refuse, rather than stopping the bridge', () => {
    expect(baileysLogLevel('verbose')).toBe('warn');
    expect(baileysLogLevel('')).toBe('warn');
  });
});
