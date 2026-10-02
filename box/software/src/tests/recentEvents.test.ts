import { describe, expect, it } from 'vitest';
import { RecentEvents } from '../system/recentEvents.ts';

/** pino's levels: 30 info, 40 warn, 50 error, 60 fatal. */
const INFO = 30;
const WARN = 40;
const ERROR = 50;

describe('RecentEvents', () => {
  it('keeps warnings and worse, newest first, and nothing quieter', () => {
    const events = new RecentEvents();
    events.record(INFO, ['booted'], {}, 1);
    events.record(WARN, [{ fault: 'cue', index: 1 }, 'device fault'], { proc: 'hardware' }, 2);
    events.record(ERROR, ['send failed'], {}, 3);

    expect(events.list()).toEqual([
      { atMs: 3, level: 'error', message: 'send failed', fields: {} },
      {
        atMs: 2,
        level: 'warn',
        message: 'device fault',
        fields: { proc: 'hardware', fault: 'cue', index: 1 },
      },
    ]);
  });

  it('forgets the oldest beyond its capacity', () => {
    const events = new RecentEvents(3);
    for (let i = 1; i <= 5; i++) events.record(WARN, [`w${String(i)}`], {}, i);
    expect(events.list().map(({ message }) => message)).toEqual(['w5', 'w4', 'w3']);
  });

  it('keeps only small primitive facts, and an error only as its message', () => {
    // A browser fetches this list: a stack, a buffer or a payload logged by accident stays out.
    const events = new RecentEvents();
    events.record(
      ERROR,
      [
        {
          err: new Error('ENOSPC: no space left on device'),
          path: 'x'.repeat(500),
          payload: { secret: 'creds' },
          bytes: Buffer.from('audio'),
          ok: false,
        },
        'could not write',
      ],
      {},
    );
    const [event] = events.list();
    expect(event?.fields).toEqual({
      error: 'ENOSPC: no space left on device',
      path: `${'x'.repeat(199)}…`,
      ok: false,
    });
    expect(JSON.stringify(event)).not.toContain('creds');
  });

  it('bounds the number of fields too', () => {
    const events = new RecentEvents();
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i)}`, i]));
    events.record(WARN, [many, 'noisy'], { proc: 'hardware' });
    expect(Object.keys(events.list()[0]?.fields ?? {})).toHaveLength(10);
  });
});
