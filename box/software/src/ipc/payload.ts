import type { ButtonIndex } from '../config/schema.ts';

/**
 * Helpers for reading untrusted transport payloads.
 *
 * Everything arriving over Socket.io — from a browser tab or from the bridge across a
 * version skew — is `unknown` until proven otherwise. These narrow without type assertions,
 * so a malformed message becomes `null` rather than a wrong-shaped object.
 */

/**
 * Reads one property from an unknown value.
 *
 * `Reflect.get` is used rather than indexing because indexing a non-literal key would need a
 * cast. The guard is `Object.hasOwn` rather than `in`: `in` walks the prototype chain, so
 * `readField({}, 'toString')` answered with `Object.prototype.toString` — a function, from a
 * payload that did not contain the key at all. Every caller today type-checks what it gets
 * back, so nothing was exposed, but this is the function whose job is to make that unnecessary.
 */
export function readField(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  if (!Object.hasOwn(payload, key)) return undefined;
  return Reflect.get(payload, key);
}

/** A non-empty string, optionally length-capped to bound memory. */
export function readString(payload: unknown, key: string, maxLength = 512): string | null {
  const value = readField(payload, key);
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > maxLength) return null;
  return value;
}

export function readBoolean(payload: unknown, key: string): boolean | null {
  const value = readField(payload, key);
  return typeof value === 'boolean' ? value : null;
}

export function readNumber(payload: unknown, key: string): number | null {
  const value = readField(payload, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Only 0, 1 and 2 are valid buttons; anything else is a tampered or stale client. */
export function readButtonIndex(payload: unknown, key = 'index'): ButtonIndex | null {
  const value = readField(payload, key);
  return value === 0 || value === 1 || value === 2 ? value : null;
}

/**
 * Builds a single-key object only when the value is present.
 *
 * Needed because `exactOptionalPropertyTypes` distinguishes an absent property from one
 * explicitly set to `undefined`.
 */
export function optionalString(
  payload: unknown,
  key: string,
  as: string = key,
): Record<string, string> {
  const value = readString(payload, key);
  return value === null ? {} : { [as]: value };
}

/**
 * A `wa:revoked` payload: which button's note the sender deleted for everyone.
 *
 * The id is only length-capped here, not shape-checked — it is matched against ids already in a
 * queue, never turned into a path, so an id no queue holds simply finds nothing.
 */
export function readRevoked(payload: unknown): { index: ButtonIndex; messageId: string } | null {
  const index = readButtonIndex(payload);
  const messageId = readString(payload, 'messageId', 128);
  return index === null || messageId === null ? null : { index, messageId };
}
