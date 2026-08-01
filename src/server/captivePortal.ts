/**
 * What makes a phone show "Sign in to network" instead of silently connecting.
 *
 * Every mobile OS probes a URL of its own the moment it joins a network and reads the answer,
 * not the status code alone. Android wants an empty 204, Apple wants a page containing the
 * word Success, Windows wants the literal text `Microsoft NCSI`. Give them what they expect
 * and the OS decides the network is fine and shows nothing — which on a setup hotspot is the
 * failure mode: the parent joins, nothing happens, and there is no screen to tell them
 * otherwise. **Failing these probes on purpose is the entire mechanism.**
 *
 * Pure and I/O-free so the decision is testable: the wrong answer here is invisible in
 * development (a laptop's browser never probes) and only shows up as "the page never appeared"
 * on someone's phone.
 */

/** Where a redirected request is sent. NetworkManager's shared mode always uses this. */
export const PORTAL_ADDRESS = '10.42.0.1';

/** The portal's own path, served by the same Express app. */
export const PORTAL_PATH = '/portal/';

/**
 * Paths the app owns and must answer normally even while the hotspot is up.
 *
 * The portal needs its own assets and the API; the admin panel and simulator are here because
 * a parent who types the address directly should get the thing they asked for rather than a
 * redirect loop.
 */
const PASSTHROUGH_PREFIXES = [
  '/portal',
  '/api',
  '/admin',
  '/simulator',
  '/shared',
  '/assets',
  '/sounds',
  '/audio',
  '/socket.io',
  '/favicon.ico',
] as const;

/**
 * The probe URLs, for reference and for tests. Not used for matching: a probe is just a
 * request for a path we do not own, and matching a list would miss every vendor not on it.
 */
export const KNOWN_CAPTIVE_PROBES = [
  '/generate_204', // Android
  '/gen_204', // Android, older
  '/hotspot-detect.html', // iOS, macOS
  '/library/test/success.html', // iOS, older
  '/ncsi.txt', // Windows
  '/connecttest.txt', // Windows 10+
  '/success.txt', // Firefox
  '/canonical.html', // Ubuntu
] as const;

export type CaptiveRequest = {
  /** Request path, without the query string. */
  readonly path: string;
  readonly method: string;
};

/*
 * Deliberately not the Host header. A probe may use any host name — an IP, a vendor domain,
 * whatever the OS picked — so matching on it would mean maintaining a list of every value
 * every OS might send. The path is enough: while the hotspot is up, anything the app does
 * not own is a probe or a stray, and both want the portal.
 */

/**
 * Whether this request should be answered with a redirect to the portal.
 *
 * Only ever true while the hotspot is up — on a home network this must never fire, or the
 * device would hijack requests on someone's LAN.
 */
export function shouldRedirectToPortal(request: CaptiveRequest, apActive: boolean): boolean {
  if (!apActive) return false;

  // A probe is always a GET. Leaving POST alone keeps the API usable through any host name.
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  const path = request.path.toLowerCase();
  for (const prefix of PASSTHROUGH_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return false;
  }

  return true;
}

/** Where to send them. Absolute, because the probe asked a different host entirely. */
export function portalRedirectTarget(portalPort: number): string {
  const suffix = portalPort === 80 ? '' : `:${portalPort}`;
  return `http://${PORTAL_ADDRESS}${suffix}${PORTAL_PATH}`;
}
