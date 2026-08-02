import { describe, expect, it } from 'vitest';
import Long from 'long';
import { messageAgeMs, shouldHandleUpsert } from '../whatsapp/client.ts';
import { RECOVERY_MAX_AGE_MS } from '../audio/recovery.ts';

/**
 * Messages WhatsApp held while the device was switched off.
 *
 * The box spends nights, journeys and power cuts off, so this is not an edge case — it is how
 * a large share of messages arrive. Baileys delivers them as `append` rather than `notify`
 * (`node.attrs.offline ? 'append' : 'notify'`), and dropping that type discarded every one of
 * them in silence. Found on 2026-08-01 by switching both daemons off, sending two notes, and
 * watching Baileys log "handled 2 offline messages" while the device stayed dark.
 */

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

/** Baileys stamps seconds, not milliseconds. */
function sentAgo(ms: number): { messageTimestamp: number } {
  return { messageTimestamp: (NOW - ms) / 1000 };
}

describe('deciding what to act on', () => {
  it('always takes a live message', () => {
    expect(shouldHandleUpsert('notify', 0)).toBe(true);
    // Age is irrelevant when we were connected to receive it.
    expect(shouldHandleUpsert('notify', 40 * HOUR)).toBe(true);
    expect(shouldHandleUpsert('notify', null)).toBe(true);
  });

  it('takes a message WhatsApp held while the box was off', () => {
    expect(shouldHandleUpsert('append', 2 * HOUR)).toBe(true);
  });

  it('leaves an old replay alone', () => {
    // A placeholder resend can carry something old; a child should not be handed yesterday.
    expect(shouldHandleUpsert('append', 9 * HOUR)).toBe(false);
  });

  it('takes one exactly at the window', () => {
    expect(shouldHandleUpsert('append', RECOVERY_MAX_AGE_MS)).toBe(true);
  });

  it('fails closed when the age is unknown', () => {
    // Cannot be shown to be recent, so it is not treated as recent.
    expect(shouldHandleUpsert('append', null)).toBe(false);
  });
});

describe('reading a message age', () => {
  it('converts seconds to an age in milliseconds', () => {
    expect(messageAgeMs(sentAgo(3 * HOUR), NOW)).toBe(3 * HOUR);
  });

  it('reports nothing for a message with no timestamp', () => {
    expect(messageAgeMs({ messageTimestamp: 0 }, NOW)).toBeNull();
    expect(messageAgeMs({}, NOW)).toBeNull();
  });

  it('treats a clock skewed into the future as brand new, not stale', () => {
    // The device has no RTC, so its clock can trail the sender's.
    expect(messageAgeMs({ messageTimestamp: (NOW + 5 * HOUR) / 1000 }, NOW)).toBe(0);
  });

  it('accepts the Long protobuf gives for a timestamp', () => {
    /*
     * messageTimestamp is `number | Long | null`, and Baileys really does hand over a Long.
     * This passes only because the age is read through Number() rather than assumed numeric —
     * arithmetic straight on a Long yields NaN, which would fail closed and drop every
     * offline message all over again.
     */
    const asLong = { messageTimestamp: Long.fromNumber((NOW - HOUR) / 1000) };

    expect(messageAgeMs(asLong, NOW)).toBe(HOUR);
  });
});
