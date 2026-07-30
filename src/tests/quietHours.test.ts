import { describe, expect, it } from 'vitest';
import {
  isWithinQuietHours,
  minutesUntilNextTransition,
  parseTimeOfDay,
} from '../core/quietHours.ts';
import type { QuietHoursConfig } from '../config/schema.ts';

/** Builds a local-time Date for a given hour/minute. The date itself is irrelevant. */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 0, 15, hour, minute, 0, 0);
}

const overnight: QuietHoursConfig = { enabled: true, startTime: '20:00', endTime: '07:00' };
const daytime: QuietHoursConfig = { enabled: true, startTime: '13:00', endTime: '15:00' };

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
    const empty: QuietHoursConfig = { enabled: true, startTime: '20:00', endTime: '20:00' };
    expect(isWithinQuietHours(empty, at(20, 0))).toBe(false);
    expect(isWithinQuietHours(empty, at(3, 0))).toBe(false);
  });
});

describe('minutesUntilNextTransition', () => {
  it('counts down to the start of quiet hours while audible', () => {
    // 18:00 -> 20:00 is two hours away.
    expect(minutesUntilNextTransition(overnight, at(18, 0))).toBe(120);
  });

  it('counts down to the end of quiet hours while quiet', () => {
    // 22:00 -> 07:00 next day is nine hours away.
    expect(minutesUntilNextTransition(overnight, at(22, 0))).toBe(540);
    // 03:00 -> 07:00 same day is four hours away.
    expect(minutesUntilNextTransition(overnight, at(3, 0))).toBe(240);
  });

  it('wraps to tomorrow rather than returning zero or negative', () => {
    // Exactly at the start: next flip is the 07:00 end, 11 hours out.
    expect(minutesUntilNextTransition(overnight, at(20, 0))).toBe(660);
    // Just after the end: next flip is tonight's 20:00 start.
    expect(minutesUntilNextTransition(overnight, at(7, 0))).toBe(780);
  });

  it('returns null when there is no schedule to wait for', () => {
    expect(minutesUntilNextTransition({ ...overnight, enabled: false }, at(12))).toBeNull();
    expect(
      minutesUntilNextTransition({ enabled: true, startTime: '09:00', endTime: '09:00' }, at(12)),
    ).toBeNull();
  });
});
