import type { QuietHoursConfig } from '../config/schema.ts';

/**
 * Scheduled quiet hours (PRODUCT.md §7).
 *
 * The default window is 20:00 -> 07:00, which **wraps past midnight**. That is the normal
 * case for a child's bedroom, not an edge case, so it is handled explicitly rather than
 * assuming start < end.
 */

export type MinutesOfDay = number;

/** Parses "HH:MM" into minutes since midnight. Assumes schema-validated input. */
export function parseTimeOfDay(time: string): MinutesOfDay {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) {
    throw new RangeError(`invalid time of day: "${time}" (expected HH:MM)`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

/** Minutes since midnight for a given instant, in local (device) time. */
export function minutesOfDay(at: Date): MinutesOfDay {
  return at.getHours() * 60 + at.getMinutes();
}

/**
 * Whether `at` falls inside the configured window.
 *
 * The window is half-open — `[start, end)` — so a 20:00–07:00 window is quiet at exactly
 * 20:00 and audible at exactly 07:00. Without that, a window whose start equals its end
 * would be ambiguous; here it means "never quiet".
 */
export function isWithinQuietHours(config: QuietHoursConfig, at: Date): boolean {
  if (!config.enabled) return false;

  const start = parseTimeOfDay(config.startTime);
  const end = parseTimeOfDay(config.endTime);
  const now = minutesOfDay(at);

  if (start === end) return false;

  if (start < end) {
    // Same-day window, e.g. 13:00 -> 15:00.
    return now >= start && now < end;
  }

  // Wraps midnight, e.g. 20:00 -> 07:00: quiet late tonight OR early tomorrow.
  return now >= start || now < end;
}

/**
 * Minutes until the window's state next flips, so a scheduler can sleep exactly that
 * long instead of polling every minute.
 */
export function minutesUntilNextTransition(config: QuietHoursConfig, at: Date): number | null {
  if (!config.enabled) return null;

  const start = parseTimeOfDay(config.startTime);
  const end = parseTimeOfDay(config.endTime);
  if (start === end) return null;

  const now = minutesOfDay(at);
  const target = isWithinQuietHours(config, at) ? end : start;

  const delta = target - now;
  // A non-positive delta means the boundary is tomorrow.
  return delta > 0 ? delta : delta + 24 * 60;
}
