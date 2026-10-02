import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_AUTH_CACHE_MAX_ENTRIES,
  ADMIN_AUTH_CACHE_TTL_MS,
  ADMIN_AUTH_FAILURE_BURST,
  ADMIN_AUTH_FAILURE_REFILL_MS,
  AdminAuthenticator,
  hashAdminPassword,
  tokensMatch,
  verifyAdminPassword,
} from '../server/auth.ts';
import { startApi, netReading, type Harness } from './support/apiHarness.ts';

/**
 * The admin gate: who is allowed to rewrite the whitelist.
 *
 * `whitelist.test.ts` covers who may reach the child. This covers who may change that answer,
 * which is the same safety boundary one level up — and it is a boundary with a deliberate hole
 * in it, because first-boot onboarding has to be able to set the first password before any
 * password exists. Both halves of that rule are load-bearing and neither is observable in
 * development: a dev machine is unconfigured, so the guard is standing aside the whole time.
 */

let api: Harness | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

const PASSWORD = 'correct horse';

describe('tokensMatch', () => {
  it('accepts an identical token', () => {
    expect(tokensMatch('shared-secret', 'shared-secret')).toBe(true);
  });

  it('rejects a different token of the same length', () => {
    expect(tokensMatch('shared-secretA', 'shared-secretB')).toBe(false);
  });

  it('rejects a length mismatch instead of throwing', () => {
    // timingSafeEqual throws on unequal lengths; the length check in front of it exists so a
    // wrong-length token is a `false`, not a 500 that tells the caller it guessed the length.
    expect(tokensMatch('short', 'much-longer-token')).toBe(false);
    expect(tokensMatch('much-longer-token', 'short')).toBe(false);
  });

  it('rejects a prefix of the expected token', () => {
    expect(tokensMatch('shared', 'shared-secret')).toBe(false);
  });

  it('treats two empty tokens as equal, so an unset BRIDGE_TOKEN is not a bypass by itself', () => {
    // Documenting rather than endorsing: the default is '' on both sides, so this returns true
    // and the protection comes from the bridge only being reachable on localhost. If that
    // changes, this test is the one that should start failing.
    expect(tokensMatch('', '')).toBe(true);
  });
});

describe('password hashing', () => {
  it('refuses a password under six characters', async () => {
    await expect(hashAdminPassword('12345')).rejects.toThrow(/at least 6/);
  });

  it('accepts exactly six', async () => {
    await expect(hashAdminPassword('123456')).resolves.toMatch(/^\$2[aby]\$/);
  });

  it('verifies the password it hashed, and rejects a near miss', async () => {
    const stored = await hashAdminPassword(PASSWORD);
    expect(await verifyAdminPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyAdminPassword(`${PASSWORD} `, stored)).toBe(false);
    expect(await verifyAdminPassword(PASSWORD.toUpperCase(), stored)).toBe(false);
  });

  it('rejects everything when no hash is stored', async () => {
    // An empty hash must never verify: it is what an unconfigured device has, and bcrypt's
    // compare on an empty string is not a "no".
    expect(await verifyAdminPassword('', '')).toBe(false);
    expect(await verifyAdminPassword('anything', '')).toBe(false);
  });

  it('rejects rather than throws on a corrupt stored hash', async () => {
    // A hand-edited config.json should lock the panel, not crash the daemon.
    expect(await verifyAdminPassword(PASSWORD, 'not-a-bcrypt-hash')).toBe(false);
  });
});

describe('while the device is unconfigured', () => {
  it('lets a mutating request through with no credentials at all', async () => {
    // The hole in the boundary, and it has to be here: the portal sets the first password
    // through this API, so requiring one first would make the device unconfigurable.
    api = await startApi({ configured: false });
    const response = await fetch(api.url('/api/config'), { method: 'GET' });
    expect(response.status).toBe(200);
  });

  it('stands aside even when a password hash somehow exists', async () => {
    // `configured` is the flag the guard trusts. A half-written state — hash present, flag
    // false — must still allow onboarding to finish rather than locking everyone out.
    api = await startApi({ configured: false, adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/config'), { method: 'GET' });
    expect(response.status).toBe(200);
  });
});

describe('once the device is configured', () => {
  it('rejects an unauthenticated request and asks for Basic auth', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/config'));
    expect(response.status).toBe(401);
    // Without the challenge header a browser never shows a password prompt, so the panel
    // would look broken rather than locked.
    expect(response.headers.get('www-authenticate')).toMatch(/^Basic realm="bloopbox"/);
  });

  it('rejects a wrong password', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/config'), {
      headers: { authorization: api.basic('wrong') },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid credentials' });
  });

  it('accepts the right password, whatever the username', async () => {
    // The daemon checks the password only; the admin panel and the portal send different
    // usernames and both must work.
    api = await startApi({ adminPassword: PASSWORD });
    for (const user of ['admin', 'parent', '']) {
      const header = `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString('base64')}`;
      const response = await fetch(api.url('/api/config'), { headers: { authorization: header } });
      expect([user, response.status]).toEqual([user, 200]);
    }
  });

  it('rejects a malformed Authorization header instead of failing open', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const headers = [
      'Bearer sometoken',
      'Basic',
      'Basic !!!not-base64!!!',
      // Base64 with no colon: no password can be extracted.
      `Basic ${Buffer.from('nocolon').toString('base64')}`,
      '',
    ];
    const results = await Promise.all(
      headers.map(async (authorization) => {
        const response = await fetch(api?.url('/api/config') ?? '', { headers: { authorization } });
        return [authorization, response.status];
      }),
    );
    expect(results).toEqual(headers.map((header) => [header, 401]));
  });

  it('accepts a password containing a colon', async () => {
    // Basic auth splits on the *first* colon; a password with one in it must survive.
    const password = 'has:a:colon';
    api = await startApi({ adminPassword: password });
    const response = await fetch(api.url('/api/config'), {
      headers: { authorization: api.basic(password) },
    });
    expect(response.status).toBe(200);
  });

  it('accepts a password outside ASCII when the header carries its UTF-8 bytes', async () => {
    /*
     * What the portal sends since it stopped using a bare `btoa`, which encodes Latin-1: an "ä"
     * then arrived as a lone 0xE4 byte and this guard read U+FFFD, so a German parent could
     * never pass it. The panel and the portal must both encode the way this decodes.
     */
    const password = 'Kätzchen€ü';
    api = await startApi({ adminPassword: password });
    const utf8 = `Basic ${Buffer.from(`admin:${password}`, 'utf8').toString('base64')}`;
    const latin1 = `Basic ${Buffer.from(`admin:${password}`, 'latin1').toString('base64')}`;

    const accepted = await fetch(api.url('/api/config'), { headers: { authorization: utf8 } });
    const refused = await fetch(api.url('/api/config'), { headers: { authorization: latin1 } });
    expect([accepted.status, refused.status]).toEqual([200, 401]);
  });

  it('stands aside when configured is true but no hash was ever written', async () => {
    /*
     * An open API, and a **deliberate** one. The guard reads an empty hash as "no password
     * exists yet", so a config in this half-written state is reachable by anyone on the LAN.
     * Getting there takes a hand-edited config.json: both write paths set the hash and the flag
     * in one update.
     *
     * Kept because the alternative is worse. The guard cannot tell "mid-onboarding" from
     * "corrupted", so refusing to serve turns a recoverable device into one that needs the SD
     * card pulled — in a house with no screen. `docs/architecture.md` has the reasoning; changing this
     * test means a recovery path exists.
     */
    api = await startApi({ configured: true });
    const response = await fetch(api.url('/api/config'));
    expect(response.status).toBe(200);
  });
});

/** `GET /api/status` — how a route is named in the tables below. */
const key = ({ method, path }: { method: string; path: string }): string => `${method} ${path}`;

describe('the endpoints that are open by design', () => {
  /*
   * The complete list of routes that answer without the settings password, each with its
   * reason. Every other route the router registers must refuse — the test below reads them off
   * the router itself, so a new route is gated by default and an exception has to be argued here.
   * A hand-written list of the gated ones used to stand in for that, and had already fallen two
   * routes behind (`/whatsapp/link`, `/audio/test`).
   */
  const OPEN: Readonly<Record<string, string>> = {
    // The simulator and the panel poll it before anyone signs in.
    'GET /api/status': 'device status',
    // The portal reads the link state before a password exists. Carries no pairing code.
    'GET /api/whatsapp': 'WhatsApp link state',
    // The portal and the simulator list the cue names.
    'GET /api/cues': 'cue names',
    // Sets the first password, so it cannot require one. 409 once one exists (below).
    'POST /api/onboard': 'first-boot onboarding',
    // Open while the hotspot is up or before onboarding; gated otherwise (its own describe).
    'GET /api/wifi/scan': 'the Wi-Fi picker',
  };

  it('names only routes that exist', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const registered = new Set(api.apiRoutes.map(key));
    expect(Object.keys(OPEN).filter((route) => !registered.has(route))).toEqual([]);
  });

  it('serves its read-only routes without credentials', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const open = ['/api/status', '/api/whatsapp', '/api/cues'];
    const results = await Promise.all(
      open.map(async (path) => {
        const response = await fetch(api?.url(path) ?? '');
        return [path, response.status];
      }),
    );
    expect(results).toEqual(open.map((path) => [path, 200]));
  });

  it('keeps every other route the router registers behind the gate', async () => {
    // Configured, with no hotspot up: the state a family's box spends its life in.
    api = await startApi({ adminPassword: PASSWORD });
    api.netState = netReading({ apActive: false });
    const guarded = api.apiRoutes.filter((route) => !(key(route) in OPEN));
    expect(guarded.length).toBeGreaterThan(15);

    const results = await Promise.all(
      guarded.map(async ({ path, method }) => {
        const init: RequestInit =
          method === 'GET'
            ? { method }
            : { method, headers: { 'content-type': 'application/json' }, body: '{}' };
        const response = await fetch(api?.url(path) ?? '', init);
        return [`${method} ${path}`, response.status];
      }),
    );
    expect(results).toEqual(guarded.map((route) => [key(route), 401]));
  });

  it('refuses onboarding on a device that already has a password', async () => {
    // Open, but not a reset: otherwise anyone on the LAN could take ownership of a live device.
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/onboard'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'new password' }),
    });
    expect(response.status).toBe(409);
    expect(api.restarts).toEqual([]);
  });
});

describe('the scan list, which is gated differently', () => {
  it('is readable while the hotspot is up on a configured device', async () => {
    // A configured box that lost its router raises the hotspot, and the parent has not typed
    // the settings password yet — the picker has to render before they can.
    api = await startApi({ adminPassword: PASSWORD });
    api.netState = netReading({ apActive: true, online: false });
    const response = await fetch(api.url('/api/wifi/scan'));
    expect(response.status).toBe(200);
  });

  it('is gated on a configured device with no hotspot up', async () => {
    // On a family LAN there is no reason to be asking, and the answer names their neighbours.
    api = await startApi({ adminPassword: PASSWORD });
    api.netState = netReading({ apActive: false });
    const response = await fetch(api.url('/api/wifi/scan'));
    expect(response.status).toBe(401);
  });

  it('is open on an unconfigured device, hotspot or not', async () => {
    api = await startApi({ configured: false });
    const response = await fetch(api.url('/api/wifi/scan'));
    expect(response.status).toBe(200);
  });

  it('is gated when there is no agent at all, rather than falling open', async () => {
    // `netState()` is null on a dev machine and on a device whose agent died. Neither is a
    // reason to publish the list.
    api = await startApi({ adminPassword: PASSWORD });
    api.netState = null;
    const response = await fetch(api.url('/api/wifi/scan'));
    expect(response.status).toBe(401);
  });
});

describe('the verification cache and the failure budget', () => {
  /**
   * A clock the test moves, and a verify that counts calls instead of paying bcrypt. `hold`
   * parks every verification until `release`, so a test can have several in flight at once.
   */
  function rig(): {
    auth: AdminAuthenticator;
    clock: { now: number };
    calls: { count: number };
    hold: () => void;
    release: () => void;
  } {
    const clock = { now: 1_000_000 };
    const calls = { count: 0 };
    let gate: Promise<void> = Promise.resolve();
    const opener: { open?: () => void } = {};
    const auth = new AdminAuthenticator({
      now: () => clock.now,
      verify: async (password) => {
        calls.count += 1;
        await gate;
        return password === PASSWORD;
      },
    });
    return {
      auth,
      clock,
      calls,
      hold: () => {
        gate = new Promise((resolveGate) => {
          opener.open = resolveGate;
        });
      },
      release: () => {
        opener.open?.();
      },
    };
  }

  it('runs bcrypt once for a header, until the TTL runs out', async () => {
    const { auth, clock, calls } = rig();
    expect(await auth.check('h', PASSWORD, 'hash')).toEqual({ outcome: 'ok' });
    clock.now += ADMIN_AUTH_CACHE_TTL_MS - 1;
    expect(await auth.check('h', PASSWORD, 'hash')).toEqual({ outcome: 'ok' });
    expect(calls.count).toBe(1);

    clock.now += 1;
    expect(await auth.check('h', PASSWORD, 'hash')).toEqual({ outcome: 'ok' });
    expect(calls.count).toBe(2);
  });

  it('forgets every remembered header when the stored hash changes', async () => {
    // A new password must not be bypassed by a browser still holding the old one.
    const { auth, calls } = rig();
    await auth.check('h', PASSWORD, 'old-hash');
    await auth.check('h', PASSWORD, 'new-hash');
    expect(calls.count).toBe(2);
  });

  it('never remembers a failure', async () => {
    const { auth, calls } = rig();
    await auth.check('h', 'wrong', 'hash');
    await auth.check('h', 'wrong', 'hash');
    expect(calls.count).toBe(2);
  });

  it('stays bounded, dropping the oldest header first', async () => {
    const { auth, calls } = rig();
    for (let n = 0; n <= ADMIN_AUTH_CACHE_MAX_ENTRIES; n++) {
      await auth.check(`h${String(n)}`, PASSWORD, 'hash');
    }
    const before = calls.count;
    // The newest is still remembered; the very first was evicted to make room.
    await auth.check(`h${String(ADMIN_AUTH_CACHE_MAX_ENTRIES)}`, PASSWORD, 'hash');
    expect(calls.count).toBe(before);
    await auth.check('h0', PASSWORD, 'hash');
    expect(calls.count).toBe(before + 1);
  });

  it('throttles after the burst without running bcrypt, and says how long to wait', async () => {
    const { auth, calls } = rig();
    for (let n = 0; n < ADMIN_AUTH_FAILURE_BURST; n++) {
      expect(await auth.check(`g${String(n)}`, 'wrong', 'hash')).toEqual({ outcome: 'invalid' });
    }
    expect(await auth.check('g-next', 'wrong', 'hash')).toEqual({
      outcome: 'throttled',
      retryAfterMs: ADMIN_AUTH_FAILURE_REFILL_MS,
    });
    // The budget protects the event loop, not just the hash.
    expect(calls.count).toBe(ADMIN_AUTH_FAILURE_BURST);
  });

  it('earns one attempt back per refill interval', async () => {
    const { auth, clock } = rig();
    for (let n = 0; n < ADMIN_AUTH_FAILURE_BURST; n++) await auth.check('g', 'wrong', 'hash');
    clock.now += ADMIN_AUTH_FAILURE_REFILL_MS / 2;
    expect(await auth.check('g', 'wrong', 'hash')).toEqual({
      outcome: 'throttled',
      retryAfterMs: ADMIN_AUTH_FAILURE_REFILL_MS / 2,
    });
    clock.now += ADMIN_AUTH_FAILURE_REFILL_MS / 2;
    expect(await auth.check('g', 'wrong', 'hash')).toEqual({ outcome: 'invalid' });
    expect((await auth.check('g', 'wrong', 'hash')).outcome).toBe('throttled');
  });

  it('lets a remembered browser straight through while the budget is spent', async () => {
    // The parent's open panel must keep working while somebody on the LAN guesses.
    const { auth } = rig();
    await auth.check('parent', PASSWORD, 'hash');
    for (let n = 0; n < ADMIN_AUTH_FAILURE_BURST; n++) await auth.check('guest', 'wrong', 'hash');
    expect((await auth.check('guest', 'wrong', 'hash')).outcome).toBe('throttled');
    expect(await auth.check('parent', PASSWORD, 'hash')).toEqual({ outcome: 'ok' });
  });

  it('does not charge a correct password against the budget', async () => {
    const { auth } = rig();
    for (let n = 0; n < ADMIN_AUTH_FAILURE_BURST * 3; n++) {
      expect(await auth.check(`p${String(n)}`, PASSWORD, 'hash')).toEqual({ outcome: 'ok' });
    }
  });

  it('shares one verification between identical headers in flight', async () => {
    // The panel's first load fires several requests with the same credentials at once; more of
    // them than the budget holds, which must not matter.
    const { auth, calls, hold, release } = rig();
    hold();
    const results = Promise.all(
      Array.from({ length: ADMIN_AUTH_FAILURE_BURST + 3 }, async () =>
        auth.check('h', PASSWORD, 'hash'),
      ),
    );
    release();
    expect((await results).map((result) => result.outcome)).toEqual(
      Array.from({ length: ADMIN_AUTH_FAILURE_BURST + 3 }, () => 'ok'),
    );
    expect(calls.count).toBe(1);
  });
});

describe('the guard under a guessing attack', () => {
  it('answers 429 with Retry-After once the budget is spent, and no password prompt', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    for (let n = 0; n < ADMIN_AUTH_FAILURE_BURST; n++) {
      const response = await fetch(api.url('/api/config'), {
        headers: { authorization: api.basic(`wrong-${String(n)}`) },
      });
      expect(response.status).toBe(401);
    }
    // Even the right password waits: it is not remembered yet, so it would cost a bcrypt.
    const throttled = await fetch(api.url('/api/config'), {
      headers: { authorization: api.basic(PASSWORD) },
    });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
    // A challenge would make the browser prompt again, inviting another guess.
    expect(throttled.headers.get('www-authenticate')).toBeNull();
  });
});
