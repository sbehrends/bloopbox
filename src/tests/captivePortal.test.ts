import { describe, expect, it } from 'vitest';
import {
  KNOWN_CAPTIVE_PROBES,
  portalRedirectTarget,
  shouldRedirectToPortal,
} from '../server/captivePortal.ts';

/**
 * The rule that decides whether a phone sees a setup page or nothing at all.
 *
 * Worth testing precisely because it cannot be observed where it is written: a laptop browser
 * never sends a captive-portal probe, so both failure modes — never redirecting, and
 * redirecting on someone's home LAN — look fine in development.
 */

const get = (path: string, host = 'example.com') => ({ path, host, method: 'GET' });

describe('while the hotspot is up', () => {
  it('redirects every captive-portal probe there is', () => {
    // Answering these *correctly* is what makes the OS stay quiet, which is the one outcome
    // this device cannot afford: there is no screen to explain the silence.
    // Compared as pairs rather than in a loop of bare booleans, so a failure names the probe.
    const results = KNOWN_CAPTIVE_PROBES.map((probe) => [
      probe,
      shouldRedirectToPortal(get(probe), true),
    ]);
    expect(results).toEqual(KNOWN_CAPTIVE_PROBES.map((probe) => [probe, true]));
  });

  it('redirects a probe from a vendor nobody has heard of', () => {
    // The rule is "a path we do not own", not a list — a list would silently miss every
    // future Android version.
    expect(shouldRedirectToPortal(get('/some-new-vendor-check'), true)).toBe(true);
  });

  it('serves the portal itself, or the redirect is a loop', () => {
    expect(shouldRedirectToPortal(get('/portal/'), true)).toBe(false);
    expect(shouldRedirectToPortal(get('/portal/main.js'), true)).toBe(false);
  });

  it('leaves the API alone, which is what the portal talks to', () => {
    expect(shouldRedirectToPortal(get('/api/status'), true)).toBe(false);
    expect(shouldRedirectToPortal(get('/api/wifi/scan'), true)).toBe(false);
  });

  it('leaves the assets and the other two UIs alone', () => {
    const paths = ['/shared/base.css', '/assets/index.js', '/admin/', '/simulator/'];
    const results = paths.map((path) => [path, shouldRedirectToPortal(get(path), true)]);
    expect(results).toEqual(paths.map((path) => [path, false]));
  });

  it('never redirects a POST', () => {
    // A redirected POST loses its body, and the join is a POST.
    expect(shouldRedirectToPortal({ path: '/anything', host: 'x', method: 'POST' }, true)).toBe(
      false,
    );
  });

  it('does not match a prefix that is only a prefix of the name', () => {
    // `/apifoo` is not `/api`, and `/portalish` is not the portal.
    expect(shouldRedirectToPortal(get('/apifoo'), true)).toBe(true);
    expect(shouldRedirectToPortal(get('/portalish'), true)).toBe(true);
  });

  it('is case-insensitive, because probes are not consistent about it', () => {
    expect(shouldRedirectToPortal(get('/API/status'), true)).toBe(false);
  });
});

describe('on a normal network', () => {
  it('redirects nothing at all', () => {
    // The device sits on a family's LAN. Hijacking requests there would be indefensible.
    const results = KNOWN_CAPTIVE_PROBES.map((probe) => [
      probe,
      shouldRedirectToPortal(get(probe), false),
    ]);
    expect(results).toEqual(KNOWN_CAPTIVE_PROBES.map((probe) => [probe, false]));
    expect(shouldRedirectToPortal(get('/'), false)).toBe(false);
    expect(shouldRedirectToPortal(get('/anything'), false)).toBe(false);
  });
});

describe('portalRedirectTarget', () => {
  it('is absolute, because the probe asked a different host entirely', () => {
    expect(portalRedirectTarget(80)).toBe('http://10.42.0.1/portal/');
  });

  it('carries the port when it is not 80', () => {
    // Development, or a device where CAP_NET_BIND_SERVICE was not granted.
    expect(portalRedirectTarget(3000)).toBe('http://10.42.0.1:3000/portal/');
  });
});
