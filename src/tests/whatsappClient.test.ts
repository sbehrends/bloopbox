import { describe, expect, it } from 'vitest';
import { DisconnectReason } from 'baileys';
import { extractStatusCode } from '../whatsapp/client.ts';

/**
 * The pure parts of the Baileys client.
 *
 * The socket itself needs a paired WhatsApp account, so what is covered here is the logic that
 * decides *how the device reacts* to a disconnect — specifically the difference between "retry"
 * and "we have been unlinked, throw the credentials away". Getting that wrong either loops
 * forever on a dead session or discards a working one.
 */

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
