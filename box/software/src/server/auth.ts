import { compare, hash } from 'bcryptjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { ConfigManager } from '../config/configManager.ts';

/**
 * Admin authentication.
 *
 * The device sits on a home network with no screen, so the threat model is modest: stop a
 * guest on the Wi-Fi from reassigning contacts or raising the volume cap. HTTP Basic over
 * the LAN is proportionate, and the password is stored only as a bcrypt hash.
 */

/** bcrypt work factor — a Pi Zero 2 W takes roughly 300ms at 10, which is acceptable. */
export const BCRYPT_ROUNDS = 10;

export async function hashAdminPassword(password: string): Promise<string> {
  if (password.length < 6) {
    throw new Error('admin password must be at least 6 characters');
  }
  return hash(password, BCRYPT_ROUNDS);
}

export async function verifyAdminPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.length === 0) return false;
  try {
    return await compare(password, storedHash);
  } catch {
    return false;
  }
}

/** Constant-time comparison for the bridge's shared token. */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which itself leaks length — compare lengths first.
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

function parseBasicAuth(header: string | undefined): { user: string; password: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/**
 * How long a successful password check is remembered.
 *
 * bcrypt at 10 rounds is ~300 ms on a Zero 2 W, and it runs on the event loop that times the
 * child's button presses. The panel sends the browser's saved Basic credentials on every request
 * and opens several at once, so without this every page load stalled the buttons for a second or
 * more — the first suspect for "sluggish during pairing". A changed password changes the stored
 * hash, which is part of every key, so expiry is the only invalidation needed.
 */
export const ADMIN_AUTH_CACHE_TTL_MS = 5 * 60_000;
/** A household has a handful of browsers; the bound only stops a flood of distinct headers. */
export const ADMIN_AUTH_CACHE_MAX_ENTRIES = 32;
/** Wrong passwords allowed back to back before the guard starts answering 429. */
export const ADMIN_AUTH_FAILURE_BURST = 5;
/** One more attempt earned back every this many ms — five a minute, once the burst is spent. */
export const ADMIN_AUTH_FAILURE_REFILL_MS = 12_000;

export type AdminCheck =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'throttled'; readonly retryAfterMs: number };

export type AdminAuthenticatorOptions = {
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable for tests, so a suite can count checks without paying bcrypt for each. */
  readonly verify?: (password: string, storedHash: string) => Promise<boolean>;
};

/**
 * The expensive half of the admin guard: remembers good headers and rations bad ones.
 *
 * **The failure budget is global, not per client**, and deliberately: the LAN offers no identity
 * worth trusting, and a per-address table is a map an attacker fills. A spent budget costs a
 * parent at most one refill interval, and only if their browser is not already remembered — the
 * cache is consulted first, so a panel already open keeps working while somebody guesses.
 *
 * Every uncached attempt reserves a token *before* bcrypt runs and gets it back on success, so
 * a burst of parallel guesses cannot all slip past the check before the first one fails.
 * Identical headers in flight share one verification — the panel's first load fires several
 * requests carrying the same credentials, and each would otherwise cost a bcrypt and a token.
 */
export class AdminAuthenticator {
  readonly #now: () => number;
  readonly #verify: (password: string, storedHash: string) => Promise<boolean>;
  /** Key -> expiry. A Map iterates in insertion order, so the first key is the oldest. */
  readonly #verified = new Map<string, number>();
  readonly #inFlight = new Map<string, Promise<boolean>>();
  #tokens = ADMIN_AUTH_FAILURE_BURST;
  #refilledAt: number;

  constructor(options: AdminAuthenticatorOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#verify = options.verify ?? verifyAdminPassword;
    this.#refilledAt = this.#now();
  }

  async check(header: string, password: string, storedHash: string): Promise<AdminCheck> {
    // A NUL between the two, so no header can be crafted to collide with another header+hash.
    const key = createHash('sha256').update(`${header}\u0000${storedHash}`).digest('hex');
    const now = this.#now();

    const expiry = this.#verified.get(key);
    if (expiry !== undefined) {
      if (expiry > now) return { outcome: 'ok' };
      this.#verified.delete(key);
    }

    const pending = this.#inFlight.get(key);
    if (pending) return (await pending) ? { outcome: 'ok' } : { outcome: 'invalid' };

    this.#refill(now);
    if (this.#tokens < 1) {
      return {
        outcome: 'throttled',
        retryAfterMs: Math.ceil((1 - this.#tokens) * ADMIN_AUTH_FAILURE_REFILL_MS),
      };
    }
    this.#tokens -= 1;

    const verification = this.#verify(password, storedHash);
    this.#inFlight.set(key, verification);
    let valid: boolean;
    try {
      valid = await verification;
    } finally {
      this.#inFlight.delete(key);
    }

    if (!valid) return { outcome: 'invalid' };
    this.#tokens = Math.min(ADMIN_AUTH_FAILURE_BURST, this.#tokens + 1);
    this.#remember(key);
    return { outcome: 'ok' };
  }

  #refill(now: number): void {
    const elapsed = Math.max(0, now - this.#refilledAt);
    this.#tokens = Math.min(
      ADMIN_AUTH_FAILURE_BURST,
      this.#tokens + elapsed / ADMIN_AUTH_FAILURE_REFILL_MS,
    );
    this.#refilledAt = now;
  }

  #remember(key: string): void {
    this.#verified.delete(key);
    this.#verified.set(key, this.#now() + ADMIN_AUTH_CACHE_TTL_MS);
    while (this.#verified.size > ADMIN_AUTH_CACHE_MAX_ENTRIES) {
      const oldest = this.#verified.keys().next();
      if (oldest.done === true) break;
      this.#verified.delete(oldest.value);
    }
  }
}

/**
 * Guards mutating admin routes.
 *
 * Before onboarding completes there is no password to check, so the guard stands aside —
 * otherwise the captive portal could never set one. Once `configured` is true it is
 * enforced.
 */
export function requireAdmin(
  config: ConfigManager,
  authenticator: AdminAuthenticator = new AdminAuthenticator(),
): RequestHandler {
  // Express 5 awaits async middleware and forwards rejections to the error handler.
  return async (req, res, next) => {
    const { system } = config.current;

    // First-run onboarding: no credentials exist yet.
    if (!system.configured || system.adminPasswordHash.length === 0) {
      next();
      return;
    }

    const challenge = (message: string): void => {
      res.setHeader('WWW-Authenticate', 'Basic realm="bloopbox", charset="UTF-8"');
      res.status(401).json({ error: message });
    };

    const header = req.headers.authorization;
    const credentials = parseBasicAuth(header);
    if (header === undefined || !credentials) {
      challenge('authentication required');
      return;
    }

    const result = await authenticator.check(
      header,
      credentials.password,
      system.adminPasswordHash,
    );
    if (result.outcome === 'ok') {
      next();
      return;
    }
    if (result.outcome === 'throttled') {
      // No challenge header: a browser would raise the password prompt again, inviting another
      // guess into a budget that is already spent.
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json({ error: 'too many wrong passwords — wait a moment and try again' });
      return;
    }
    challenge('invalid credentials');
  };
}
