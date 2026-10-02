import { describe, expect, it } from 'vitest';
import { describeRecentEvent, readRecentEvents } from '../../public/admin/recentEvents.ts';

/** The health card's "Recently" list, which is what a parent reads instead of the journal. */
describe('the recent events list', () => {
  it('says a device fault with its kind, the button counted from one, and the error', () => {
    expect(
      describeRecentEvent({
        atMs: 0,
        level: 'warn',
        message: 'device fault',
        fields: { fault: 'capture-start', index: 0, error: 'arecord: no such device', mod: 'x' },
      }),
    ).toBe('device fault: capture-start, button 1 — arecord: no such device');
  });

  it('says a bare message as it is', () => {
    expect(
      describeRecentEvent({ atMs: 0, level: 'error', message: 'send failed', fields: {} }),
    ).toBe('send failed');
  });

  it('keeps only well-formed entries, and reads anything else as no answer', () => {
    expect(
      readRecentEvents({
        events: [
          { atMs: 1, level: 'warn', message: 'ok', fields: {} },
          { atMs: 'soon', level: 'warn', message: 'bad time', fields: {} },
          { atMs: 2, level: 'info', message: 'too quiet', fields: {} },
        ],
      }),
    ).toEqual([{ atMs: 1, level: 'warn', message: 'ok', fields: {} }]);
    expect(readRecentEvents({ error: 'nope' })).toBeNull();
    expect(readRecentEvents(null)).toBeNull();
  });
});
