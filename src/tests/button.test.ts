import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ButtonInterpreter,
  DEBOUNCE_MS,
  RECORD_THRESHOLD_MS,
  SILENT_COMBO_MS,
  type CancelReason,
} from '../core/buttonInterpreter.ts';
import type { ButtonIndex } from '../config/schema.ts';

/**
 * Button timing behaviour (PRODUCT.md §1, §5) and the tap-vs-cancel resolution recorded
 * in CLAUDE.md. Everything runs on fake timers — no sleeping, no flakes.
 */

type Recorded = { event: string; payload?: unknown };

/** Comfortably inside the tap window: past debounce, short of the record threshold. */
const TAP_MS = Math.round((DEBOUNCE_MS + RECORD_THRESHOLD_MS) / 2);

function setup(options: { unread?: ButtonIndex[]; maxRecordingSeconds?: number } = {}) {
  const unread = new Set(options.unread ?? []);
  const interpreter = new ButtonInterpreter({
    maxRecordingSeconds: options.maxRecordingSeconds ?? 30,
    hasUnread: (index) => unread.has(index),
  });

  const log: Recorded[] = [];
  const track = [
    'captureStart',
    'captureConfirmed',
    'captureCommit',
    'captureCancel',
    'playQueue',
    'cancelBeep',
    'toggleSilent',
    'pressVisualOn',
    'pressVisualOff',
  ] as const;

  for (const event of track) {
    interpreter.on(event, (payload?: unknown) => {
      log.push(payload === undefined ? { event } : { event, payload });
    });
  }

  // Captured separately so the payload keeps its real type instead of needing a cast.
  const cancels: { index: ButtonIndex; durationMs: number; reason: CancelReason }[] = [];
  interpreter.on('captureCancel', (payload) => cancels.push(payload));

  const names = (): string[] => log.map((entry) => entry.event);
  const find = (event: string): Recorded | undefined => log.find((e) => e.event === event);

  return { interpreter, log, names, find, unread, cancels };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('timing constants', () => {
  it('pins the press windows, so changing them is deliberate', () => {
    // Tuned during manual testing: faster to respond than the spec's original figures.
    expect(DEBOUNCE_MS).toBe(150);
    expect(RECORD_THRESHOLD_MS).toBe(500);
    expect(SILENT_COMBO_MS).toBe(3000);
    // A tap window must exist between them or tap-to-play is unreachable.
    expect(DEBOUNCE_MS).toBeLessThan(RECORD_THRESHOLD_MS);
  });
});

describe('debounce — presses under the debounce window', () => {
  it('are dropped with no audible feedback at all', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(DEBOUNCE_MS - 50);
    interpreter.handleButtonUp(0);

    // Capture started (so nothing is ever lost) but was discarded silently.
    expect(names()).toContain('captureStart');
    expect(names()).toContain('captureCancel');
    expect(names()).not.toContain('cancelBeep');
    expect(names()).not.toContain('playQueue');
    expect(names()).not.toContain('captureCommit');
  });

  it('still give instant visual acknowledgement, then release the LED', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(1);
    expect(names()).toContain('pressVisualOn');

    vi.advanceTimersByTime(100);
    interpreter.handleButtonUp(1);
    expect(names()).toContain('pressVisualOff');
  });
});

describe('tap — between debounce and the record threshold', () => {
  it('plays the queue when that contact has unread messages', () => {
    const { interpreter, names } = setup({ unread: [2] });

    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(2);

    expect(names()).toContain('playQueue');
    expect(names()).not.toContain('cancelBeep');
    expect(names()).not.toContain('captureCommit');
  });

  it('gives the "oops" beep when there is nothing to play', () => {
    const { interpreter, names } = setup({ unread: [] });

    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(2);

    expect(names()).toContain('cancelBeep');
    expect(names()).not.toContain('playQueue');
    expect(names()).not.toContain('captureCommit');
  });

  it('discards the audio either way', () => {
    const { interpreter, find } = setup({ unread: [0] });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(0);

    expect(find('captureCancel')?.payload).toMatchObject({ reason: 'tooShort' });
  });

  it('treats one millisecond under the threshold as a tap, not a recording', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(RECORD_THRESHOLD_MS - 1);
    interpreter.handleButtonUp(0);

    expect(names()).not.toContain('captureConfirmed');
    expect(names()).toContain('cancelBeep');
  });
});

describe('hold — at or beyond the record threshold', () => {
  it('confirms the recording at the threshold and commits on release', () => {
    const { interpreter, names, find } = setup();

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(RECORD_THRESHOLD_MS);
    expect(names()).toContain('captureConfirmed');

    vi.advanceTimersByTime(2000);
    interpreter.handleButtonUp(1);

    expect(names()).toContain('captureCommit');
    expect(names()).not.toContain('captureCancel');
    expect(find('captureCommit')?.payload).toMatchObject({
      index: 1,
      reachedMaxDuration: false,
    });
  });

  it('records even when that contact has unread messages waiting', () => {
    // Holding always means "send", never "play" — unread state must not change this.
    const { interpreter, names } = setup({ unread: [1] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(1500);
    interpreter.handleButtonUp(1);

    expect(names()).toContain('captureCommit');
    expect(names()).not.toContain('playQueue');
  });

  it('auto-commits at maxRecordingSeconds so a stuck button cannot fill the disk', () => {
    const { interpreter, names, find } = setup({ maxRecordingSeconds: 5 });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(5000);

    expect(names()).toContain('captureCommit');
    expect(find('captureCommit')?.payload).toMatchObject({ reachedMaxDuration: true });
  });

  it('does not commit twice when the button is released after an auto-commit', () => {
    const { interpreter, log } = setup({ maxRecordingSeconds: 5 });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(6000);
    interpreter.handleButtonUp(0);

    expect(log.filter((e) => e.event === 'captureCommit')).toHaveLength(1);
  });
});

describe('silent-mode chord — Button 1 + Button 3', () => {
  it('toggles silent mode after a 3 second hold', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(SILENT_COMBO_MS);

    expect(names()).toContain('toggleSilent');
  });

  it('sends nothing, even though both buttons were held past the record threshold', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(SILENT_COMBO_MS);
    interpreter.handleButtonUp(0);
    interpreter.handleButtonUp(2);

    expect(names()).toContain('toggleSilent');
    expect(names()).not.toContain('captureCommit');
    expect(names()).not.toContain('captureConfirmed');
  });

  it('swallows both presses immediately so a child mashing them sends nothing', () => {
    const { interpreter, cancels } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(2);

    expect(cancels).toHaveLength(2);
    expect(cancels.every((c) => c.reason === 'combo')).toBe(true);
    expect(cancels.map((c) => c.index).toSorted((a, b) => a - b)).toEqual([0, 2]);
  });

  it('does nothing at all when the chord is released early', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(SILENT_COMBO_MS - 500);
    interpreter.handleButtonUp(0);
    interpreter.handleButtonUp(2);
    vi.advanceTimersByTime(5000);

    expect(names()).not.toContain('toggleSilent');
    expect(names()).not.toContain('captureCommit');
    expect(names()).not.toContain('cancelBeep');
  });

  it('leaves the middle button alone — it is not part of the chord', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(SILENT_COMBO_MS);

    expect(names()).not.toContain('toggleSilent');
  });
});

describe('robustness', () => {
  it('ignores repeated down edges from a bouncing switch', () => {
    const { interpreter, log } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(0);

    expect(log.filter((e) => e.event === 'captureStart')).toHaveLength(1);
  });

  it('ignores a release with no matching press', () => {
    const { interpreter, log } = setup();
    interpreter.handleButtonUp(1);
    expect(log).toHaveLength(0);
  });

  it('reset() drops in-flight presses without sending anything', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(2000);
    interpreter.reset();
    vi.advanceTimersByTime(10_000);

    expect(names()).not.toContain('captureCommit');
    expect(interpreter.hasActivePress).toBe(false);
  });

  it('tracks per-button press state independently', () => {
    const { interpreter } = setup();

    interpreter.handleButtonDown(1);
    expect(interpreter.isPressed(1)).toBe(true);
    expect(interpreter.isPressed(0)).toBe(false);

    interpreter.handleButtonUp(1);
    expect(interpreter.isPressed(1)).toBe(false);
  });
});
