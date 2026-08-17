import type { QuietHoursConfig } from '../config/schema.ts';

/**
 * Scheduled quiet hours (PRODUCT.md §7).
 *
 * The default window is 20:00 -> 07:00, which **wraps past midnight**. That is the normal
 * case for a child's bedroom, not an edge case, so it is handled explicitly rather than
 * assuming start < end.
 *
 * Times are read in `config.timezone`, never in the device's own clock — see `minutesOfDay`.
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

/**
 * Formatters are cached because the window is re-evaluated on a timer that can fire every
 * few hours for months, and building one is the expensive part of asking ICU the time.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  // `h23` rather than `hour12: false`: the latter renders midnight as "24" under some ICU
  // builds, which would put the start of the day 1440 minutes past it.
  const built = Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatters.set(timeZone, built);
  return built;
}

/**
 * Minutes since midnight for a given instant, in `timeZone`.
 *
 * Reading the wall clock through ICU rather than `Date#getHours` is what lets the device keep
 * whatever zone its OS picked — Raspberry Pi OS defaults to Europe/London, measured 2026-08-17
 * — while the window still means 8pm in the room the box is in. It also gets DST right for
 * free: the offset is looked up per instant, not assumed constant.
 */
export function minutesOfDay(at: Date, timeZone: string): MinutesOfDay {
  const parts = formatterFor(timeZone).formatToParts(at);
  let hours = 0;
  let minutes = 0;
  for (const part of parts) {
    if (part.type === 'hour') hours = Number(part.value);
    else if (part.type === 'minute') minutes = Number(part.value);
  }
  return hours * 60 + minutes;
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
  const now = minutesOfDay(at, config.timezone);

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
 *
 * Wall-clock minutes, so a DST jump inside the interval makes it an hour out. That is why
 * `DeviceController` caps the sleep and re-evaluates rather than trusting this once — twice a
 * year, an hour late, self-correcting, versus a timer per minute forever.
 */
export function minutesUntilNextTransition(config: QuietHoursConfig, at: Date): number | null {
  if (!config.enabled) return null;

  const start = parseTimeOfDay(config.startTime);
  const end = parseTimeOfDay(config.endTime);
  if (start === end) return null;

  const now = minutesOfDay(at, config.timezone);
  const target = isWithinQuietHours(config, at) ? end : start;

  const delta = target - now;
  // A non-positive delta means the boundary is tomorrow.
  return delta > 0 ? delta : delta + 24 * 60;
}
