import { afterEach, describe, expect, it } from 'vitest';
import { hashAdminPassword, tokensMatch, verifyAdminPassword } from '../server/auth.ts';
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

  it('stands aside when configured is true but no hash was ever written', async () => {
    /*
     * An open API, and a **deliberate** one. The guard reads an empty hash as "no password
     * exists yet", so a config in this half-written state is reachable by anyone on the LAN.
     * Getting there takes a hand-edited config.json: both write paths set the hash and the flag
     * in one update.
     *
     * Kept because the alternative is worse. The guard cannot tell "mid-onboarding" from
     * "corrupted", so refusing to serve turns a recoverable device into one that needs the SD
     * card pulled — in a house with no screen. See the watch item in PENDING.md; changing this
     * test means a recovery path exists.
     */
    api = await startApi({ configured: true });
    const response = await fetch(api.url('/api/config'));
    expect(response.status).toBe(200);
  });
});

describe('the endpoints that are open by design', () => {
  it('serves exactly the four that need no credentials', async () => {
    // Each one has a reason: the simulator and the panel poll status before anyone signs in,
    // the portal reads WhatsApp state and the cue list, and onboarding cannot require a
    // password it is about to set. Anything else appearing here is a leak.
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

  it('keeps every other route behind the gate', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const guarded = [
      { path: '/api/config', method: 'GET' },
      { path: '/api/config', method: 'PUT' },
      { path: '/api/silent', method: 'POST' },
      { path: '/api/contacts', method: 'GET' },
      { path: '/api/whatsapp/qr.svg', method: 'GET' },
      { path: '/api/whatsapp/pair', method: 'POST' },
      { path: '/api/whatsapp/groups', method: 'GET' },
      { path: '/api/whatsapp/unlink', method: 'POST' },
      { path: '/api/factory-reset', method: 'POST' },
      { path: '/api/wifi/join', method: 'POST' },
      /*
       * The activity totals name the family's contacts, and the health reading names the
       * network this box sits on and can power the device off. Neither belongs to anything
       * that can merely reach port 3000.
       */
      { path: '/api/stats', method: 'GET' },
      { path: '/api/stats/reset', method: 'POST' },
      { path: '/api/system', method: 'GET' },
      { path: '/api/system/power', method: 'POST' },
      // A password for the whole machine.
      { path: '/api/system/ssh', method: 'GET' },
    ];
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
    expect(results).toEqual(guarded.map(({ path, method }) => [`${method} ${path}`, 401]));
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
