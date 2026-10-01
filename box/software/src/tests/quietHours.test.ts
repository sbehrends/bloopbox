import { describe, expect, it } from 'vitest';
import {
  isWithinQuietHours,
  minutesOfDay,
  msUntilNextTransition,
  parseTimeOfDay,
} from '../core/quietHours.ts';
import type { QuietHoursConfig } from '../config/schema.ts';

/**
 * Builds a **UTC** instant for a given hour/minute. The date itself is irrelevant.
 *
 * UTC rather than the machine's local time, paired with `timezone: 'UTC'` on the fixtures
 * below, so the arithmetic these tests assert on does not change with the developer's clock.
 * The zone-aware cases further down are the ones that put a real offset in play.
 */
function at(hour: number, minute = 0, second = 0): Date {
  return new Date(Date.UTC(2026, 0, 15, hour, minute, second, 0));
}

const MINUTE = 60 * 1000;

const overnight: QuietHoursConfig = {
  enabled: true,
  startTime: '20:00',
  endTime: '07:00',
  timezone: 'UTC',
};
const daytime: QuietHoursConfig = {
  enabled: true,
  startTime: '13:00',
  endTime: '15:00',
  timezone: 'UTC',
};

describe('parseTimeOfDay', () => {
  it('converts HH:MM to minutes since midnight', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('07:00')).toBe(420);
    expect(parseTimeOfDay('20:30')).toBe(1230);
    expect(parseTimeOfDay('23:59')).toBe(1439);
  });

  it('rejects malformed and out-of-range times', () => {
    for (const bad of ['24:00', '7:00', '20:60', '', 'nope', '20:0']) {
      expect(() => parseTimeOfDay(bad)).toThrow(RangeError);
    }
  });
});

describe('isWithinQuietHours — window crossing midnight (the default)', () => {
  it('is quiet through the night', () => {
    expect(isWithinQuietHours(overnight, at(20, 0))).toBe(true); // inclusive start
    expect(isWithinQuietHours(overnight, at(22, 30))).toBe(true);
    expect(isWithinQuietHours(overnight, at(0, 0))).toBe(true); // across midnight
    expect(isWithinQuietHours(overnight, at(3, 15))).toBe(true);
    expect(isWithinQuietHours(overnight, at(6, 59))).toBe(true);
  });

  it('is audible during the day', () => {
    expect(isWithinQuietHours(overnight, at(7, 0))).toBe(false); // exclusive end
    expect(isWithinQuietHours(overnight, at(12, 0))).toBe(false);
    expect(isWithinQuietHours(overnight, at(19, 59))).toBe(false);
  });
});

describe('isWithinQuietHours — same-day window', () => {
  it('is quiet only inside the window', () => {
    expect(isWithinQuietHours(daytime, at(12, 59))).toBe(false);
    expect(isWithinQuietHours(daytime, at(13, 0))).toBe(true);
    expect(isWithinQuietHours(daytime, at(14, 30))).toBe(true);
    expect(isWithinQuietHours(daytime, at(15, 0))).toBe(false);
  });
});

describe('isWithinQuietHours — degenerate cases', () => {
  it('is never quiet when disabled, whatever the window says', () => {
    const disabled: QuietHoursConfig = { ...overnight, enabled: false };
    expect(isWithinQuietHours(disabled, at(23, 0))).toBe(false);
  });

  it('treats an empty window (start === end) as never quiet, not always', () => {
    const empty: QuietHoursConfig = { ...overnight, endTime: '20:00' };
    expect(isWithinQuietHours(empty, at(20, 0))).toBe(false);
    expect(isWithinQuietHours(empty, at(3, 0))).toBe(false);
  });
});

describe('msUntilNextTransition', () => {
  it('counts down to the start of quiet hours while audible', () => {
    // 18:00 -> 20:00 is two hours away.
    expect(msUntilNextTransition(overnight, at(18, 0))).toBe(120 * MINUTE);
  });

  it('counts down to the end of quiet hours while quiet', () => {
    // 22:00 -> 07:00 next day is nine hours away.
    expect(msUntilNextTransition(overnight, at(22, 0))).toBe(540 * MINUTE);
    // 03:00 -> 07:00 same day is four hours away.
    expect(msUntilNextTransition(overnight, at(3, 0))).toBe(240 * MINUTE);
  });

  it('wraps to tomorrow rather than returning zero or negative', () => {
    // Exactly at the start: next flip is the 07:00 end, 11 hours out.
    expect(msUntilNextTransition(overnight, at(20, 0))).toBe(660 * MINUTE);
    // Just after the end: next flip is tonight's 20:00 start.
    expect(msUntilNextTransition(overnight, at(7, 0))).toBe(780 * MINUTE);
  });

  /*
   * Counting whole minutes from the current one used to land the timer up to 59 s late: at
   * 19:59:30 it said "one minute", and the box stayed audible until 20:00:30.
   */
  it('counts the part of the current minute already gone', () => {
    expect(msUntilNextTransition(overnight, at(19, 59, 30))).toBe(30 * 1000);
    expect(msUntilNextTransition(overnight, at(6, 59, 59))).toBe(1000);
    const almost = new Date(at(19, 59, 59).getTime() + 999);
    expect(msUntilNextTransition(overnight, almost)).toBe(1);
  });

  it('wraps to tomorrow from part-way through the boundary minute', () => {
    // 20:00:30 is inside the window; the next flip is 07:00, 30 s short of 11 hours.
    expect(msUntilNextTransition(overnight, at(20, 0, 30))).toBe(660 * MINUTE - 30 * 1000);
    // 07:00:30 is audible; tonight's 20:00 is 30 s short of 13 hours.
    expect(msUntilNextTransition(overnight, at(7, 0, 30))).toBe(780 * MINUTE - 30 * 1000);
  });

  it('returns null when there is no schedule to wait for', () => {
    expect(msUntilNextTransition({ ...overnight, enabled: false }, at(12))).toBeNull();
    expect(
      msUntilNextTransition({ ...overnight, startTime: '09:00', endTime: '09:00' }, at(12)),
    ).toBeNull();
  });
});

/*
 * The reason the field exists: a freshly flashed image runs on whatever zone Raspberry Pi OS
 * picked — Europe/London, measured 2026-08-17 — so without a zone of our own the window
 * silently slides by the family's offset from it. On a device with no screen that reads as
 * "it stopped chiming" and nothing else.
 */
describe('minutesOfDay — the wall clock, not the device clock', () => {
  it('reads the same instant differently in each zone', () => {
    const noonUtc = at(12, 0);
    expect(minutesOfDay(noonUtc, 'UTC')).toBe(720);
    // UTC+1 in January.
    expect(minutesOfDay(noonUtc, 'Europe/Berlin')).toBe(780);
    // UTC-3, and Argentina does not observe DST — this is the author's own zone.
    expect(minutesOfDay(noonUtc, 'America/Argentina/Buenos_Aires')).toBe(540);
  });

  it('renders midnight as 0, not 1440', () => {
    // `hour12: false` yields "24" under some ICU builds; `hourCycle: 'h23'` is why this holds.
    expect(minutesOfDay(at(0, 0), 'UTC')).toBe(0);
  });

  it('follows DST rather than assuming a fixed offset', () => {
    // 12:00 UTC is 13:00 in Berlin in January and 14:00 in July.
    expect(minutesOfDay(new Date(Date.UTC(2026, 0, 15, 12, 0)), 'Europe/Berlin')).toBe(780);
    expect(minutesOfDay(new Date(Date.UTC(2026, 6, 15, 12, 0)), 'Europe/Berlin')).toBe(840);
  });
});

describe('isWithinQuietHours — across timezones', () => {
  const berlin: QuietHoursConfig = { ...overnight, timezone: 'Europe/Berlin' };

  it('is quiet when it is 20:00 in the configured zone, not in UTC', () => {
    // 19:00 UTC in January is 20:00 in Berlin: quiet there, still audible on a UTC clock.
    const nineteenUtc = at(19, 0);
    expect(isWithinQuietHours(berlin, nineteenUtc)).toBe(true);
    expect(isWithinQuietHours(overnight, nineteenUtc)).toBe(false);
  });

  it('is audible again at 07:00 local, an hour before UTC would say so', () => {
    // 06:00 UTC is 07:00 Berlin — the half-open window's exclusive end.
    expect(isWithinQuietHours(berlin, at(6, 0))).toBe(false);
    expect(isWithinQuietHours(overnight, at(6, 0))).toBe(true);
  });

  it('counts down to the boundary in the configured zone', () => {
    // 17:00 UTC is 18:00 Berlin, two hours from a 20:00 start.
    expect(msUntilNextTransition(berlin, at(17, 0))).toBe(120 * MINUTE);
  });
});
