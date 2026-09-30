import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSettleMs, SettledLine } from '../hal/settledLine.ts';

/**
 * Contact chatter, settled in the HAL. The bursts below are shaped like the ones recorded on the
 * reference board on 2026-09-30: several edges inside a millisecond or two, sometimes opening with
 * the opposite edge to the one the press ends on.
 *
 * Levels are raw line values; the buttons are active-low, so `false` is pressed.
 */

const SETTLE_MS = 20;
const PRESSED = false;
const RELEASED = true;

let level: boolean;
let changes: boolean[];
let line: SettledLine;

beforeEach(() => {
  vi.useFakeTimers();
  level = RELEASED;
  changes = [];
  line = new SettledLine({
    initial: RELEASED,
    read: () => level,
    onChange: (next) => changes.push(next),
    settleMs: SETTLE_MS,
  });
});

afterEach(() => {
  line.stop();
  vi.useRealTimers();
});

/** Replays a burst: each entry is the level an edge reported, one per `gapMs`. */
function burst(edges: readonly boolean[], settlesAt: boolean, gapMs = 0): void {
  for (const [position, reported] of edges.entries()) {
    if (position > 0 && gapMs > 0) vi.advanceTimersByTime(gapMs);
    line.edge(reported);
  }
  level = settlesAt;
}

describe('SettledLine', () => {
  it('reports one press for a burst of bounces, once the line is quiet', () => {
    burst([PRESSED, RELEASED, PRESSED, PRESSED, RELEASED, PRESSED], PRESSED);
    expect(changes).toEqual([]);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(changes).toEqual([PRESSED]);
  });

  it('reads the level rather than trusting the order the edges came in', () => {
    // 17 of the bench bursts opened with the opposite edge. What counts is where the line ends up.
    burst([RELEASED, PRESSED, PRESSED, PRESSED, RELEASED, PRESSED], PRESSED);
    vi.advanceTimersByTime(SETTLE_MS);
    burst([PRESSED, RELEASED, RELEASED, PRESSED, RELEASED], RELEASED);
    vi.advanceTimersByTime(SETTLE_MS);

    expect(changes).toEqual([PRESSED, RELEASED]);
  });

  it('waits for the whole burst: each edge restarts the quiet period', () => {
    // Up to 15 ms of chatter on the bench; the settle window has to outlast it.
    burst([PRESSED, RELEASED, PRESSED, RELEASED, PRESSED, RELEASED, PRESSED], PRESSED, 2);
    expect(changes).toEqual([]);

    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([PRESSED]);
  });

  it('reports nothing for a glitch that ends where it started', () => {
    burst([PRESSED, RELEASED, PRESSED, RELEASED], RELEASED);
    vi.advanceTimersByTime(SETTLE_MS * 2);

    expect(changes).toEqual([]);
  });

  it('never reports the same level twice in a row', () => {
    burst([PRESSED], PRESSED);
    vi.advanceTimersByTime(SETTLE_MS);
    burst([PRESSED, PRESSED], PRESSED);
    vi.advanceTimersByTime(SETTLE_MS);

    expect(changes).toEqual([PRESSED]);
  });

  it('falls back to the last edge when the line cannot be read', () => {
    const unreadable = new SettledLine({
      initial: RELEASED,
      read: () => {
        throw new Error('Cannot get value from stopped watcher');
      },
      onChange: (next) => changes.push(next),
      settleMs: SETTLE_MS,
    });
    unreadable.edge(RELEASED);
    unreadable.edge(PRESSED);
    vi.advanceTimersByTime(SETTLE_MS);

    expect(changes).toEqual([PRESSED]);
    unreadable.stop();
  });

  it('reports nothing after stop()', () => {
    burst([PRESSED], PRESSED);
    line.stop();
    vi.advanceTimersByTime(SETTLE_MS * 2);

    expect(changes).toEqual([]);
  });
});

describe('BUTTON_SETTLE_MS', () => {
  it('defaults when unset or empty, and takes a whole number of milliseconds', () => {
    expect(parseSettleMs(undefined, 20)).toBe(20);
    expect(parseSettleMs('  ', 20)).toBe(20);
    expect(parseSettleMs('35', 20)).toBe(35);
    expect(parseSettleMs('0', 20)).toBe(0);
  });

  it('refuses anything else rather than guessing', () => {
    for (const raw of ['-1', '2.5', 'fast', '201']) {
      expect(() => parseSettleMs(raw, 20)).toThrow(/BUTTON_SETTLE_MS/);
    }
  });
});
