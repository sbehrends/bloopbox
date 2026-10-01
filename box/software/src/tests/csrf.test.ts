import { afterEach, describe, expect, it } from 'vitest';
import { startApi, type Harness } from './support/apiHarness.ts';

/**
 * Forged requests from other websites, and framing by them.
 *
 * The browser attaches a parent's saved Basic credentials to any request for the box, whoever
 * made it — so a password is not a defence against a page elsewhere posting to
 * `/api/factory-reset`. These drive the real router with the headers a browser would send for
 * such a page, and check that nothing behind them runs.
 */

let api: Harness | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

const PASSWORD = 'correct horse';

/** The host:port the harness listens on, which is what the Host header will say. */
function hostOf(harness: Harness): string {
  return new URL(harness.url('/')).host;
}

describe('a state-changing request from another site', () => {
  it('is refused on Sec-Fetch-Site: cross-site, before the password is even looked at', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/factory-reset'), {
      method: 'POST',
      headers: {
        authorization: api.basic(PASSWORD),
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(api.restarts).toEqual([]);
  });

  it('is refused when the Origin names a different host', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/whatsapp/unlink'), {
      method: 'POST',
      headers: {
        authorization: api.basic(PASSWORD),
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(api.unlinks.count).toBe(0);
  });

  it('is refused on Origin: null, which a sandboxed frame or a file: page sends', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/stats/reset'), {
      method: 'POST',
      headers: {
        authorization: api.basic(PASSWORD),
        'content-type': 'application/json',
        origin: 'null',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('is refused as 415 when it is not labelled JSON, which is all an HTML form can send', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const forms = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
    const results = await Promise.all(
      forms.map(async (type) => {
        const response = await fetch(api?.url('/api/factory-reset') ?? '', {
          method: 'POST',
          headers: { authorization: api?.basic(PASSWORD) ?? '', 'content-type': type },
          body: 'x=1',
        });
        return [type, response.status];
      }),
    );
    expect(results).toEqual(forms.map((type) => [type, 415]));
    expect(api.restarts).toEqual([]);
  });

  it('is refused as 415 with no content type at all — the body-less POST a form makes', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/silent'), {
      method: 'POST',
      headers: { authorization: api.basic(PASSWORD) },
    });
    expect(response.status).toBe(415);
    expect(api.controller.state.silentMode).toBe(false);
  });

  it('guards the open onboarding route too, since it sets the first password', async () => {
    api = await startApi({ configured: false });
    const response = await fetch(api.url('/api/onboard'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ password: 'taken over' }),
    });
    expect(response.status).toBe(403);
    expect(api.restarts).toEqual([]);
  });
});

describe("a request from the box's own pages", () => {
  it('goes through with a matching Origin and same-origin fetch metadata', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/silent'), {
      method: 'POST',
      headers: {
        authorization: api.basic(PASSWORD),
        'content-type': 'application/json',
        origin: `http://${hostOf(api)}`,
        'sec-fetch-site': 'same-origin',
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(api.controller.state.silentMode).toBe(true);
  });

  it('goes through as same-site, which is :80 and :3000 on the one box', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/silent'), {
      method: 'POST',
      headers: {
        authorization: api.basic(PASSWORD),
        'content-type': 'application/json; charset=utf-8',
        'sec-fetch-site': 'same-site',
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
  });

  it('accepts a JSON label on an empty body, for the actions with nothing to say', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/whatsapp/link'), {
      method: 'POST',
      headers: { authorization: api.basic(PASSWORD), 'content-type': 'application/json' },
    });
    expect(response.status).toBe(200);
    expect(api.beginLinkings.count).toBe(1);
  });

  it('leaves reads alone, whatever site asks — a GET changes nothing', async () => {
    // The status poll and the scan list are read by pages that set no content type.
    api = await startApi({ adminPassword: PASSWORD });
    const response = await fetch(api.url('/api/status'), {
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://elsewhere.example' },
    });
    expect(response.status).toBe(200);
  });
});

describe('framing', () => {
  it('is forbidden on API responses, by both the old header and the new one', async () => {
    api = await startApi({ adminPassword: PASSWORD });
    for (const path of ['/api/status', '/api/config']) {
      const response = await fetch(api.url(path));
      expect([path, response.headers.get('x-frame-options')]).toEqual([path, 'DENY']);
      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    }
  });
});
