import { compare, hash } from 'bcryptjs';
import { timingSafeEqual } from 'node:crypto';
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
 * Guards mutating admin routes.
 *
 * Before onboarding completes there is no password to check, so the guard stands aside —
 * otherwise the captive portal could never set one. Once `configured` is true it is
 * enforced.
 */
export function requireAdmin(config: ConfigManager): RequestHandler {
  // Express 5 awaits async middleware and forwards rejections to the error handler.
  return async (req, res, next) => {
    const { system } = config.current;

    // First-run onboarding: no credentials exist yet.
    if (!system.configured || system.adminPasswordHash.length === 0) {
      next();
      return;
    }

    const challenge = (message: string): void => {
      res.setHeader('WWW-Authenticate', 'Basic realm="Kids Messenger", charset="UTF-8"');
      res.status(401).json({ error: message });
    };

    const credentials = parseBasicAuth(req.headers.authorization);
    if (!credentials) {
      challenge('authentication required');
      return;
    }

    if (await verifyAdminPassword(credentials.password, system.adminPasswordHash)) {
      next();
      return;
    }
    challenge('invalid credentials');
  };
}
