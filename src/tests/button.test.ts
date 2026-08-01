import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonInterpreter, type CancelReason } from '../core/buttonInterpreter.ts';
import { DEFAULT_BUTTON_TIMINGS, type ButtonIndex, type ButtonTimings } from '../config/schema.ts';

/**
 * Button timing behaviour (PRODUCT.md §1, §5) and the tap-vs-cancel resolution recorded
 * in CLAUDE.md. Everything runs on fake timers — no sleeping, no flakes.
 */

type Recorded = { event: string; payload?: unknown };

const { debounceMs: DEBOUNCE_MS, recordThresholdMs: RECORD_THRESHOLD_MS } = DEFAULT_BUTTON_TIMINGS;
const SILENT_COMBO_MS = DEFAULT_BUTTON_TIMINGS.silentComboMs;
const RESUME_GRACE_MS = DEFAULT_BUTTON_TIMINGS.resumeGraceMs;

/** Comfortably inside the tap window: past debounce, short of the record threshold. */
const TAP_MS = Math.round((DEBOUNCE_MS + RECORD_THRESHOLD_MS) / 2);

/** How many times one event was emitted. */
const counts = (log: Recorded[], event: string): number =>
  log.filter((entry) => entry.event === event).length;

function setup(
  options: {
    unread?: ButtonIndex[];
    maxRecordingSeconds?: number;
    timings?: Partial<ButtonTimings>;
  } = {},
) {
  const unread = new Set(options.unread ?? []);
  const interpreter = new ButtonInterpreter({
    timings: { ...DEFAULT_BUTTON_TIMINGS, ...options.timings },
    maxRecordingSeconds: options.maxRecordingSeconds ?? 30,
    hasUnread: (index) => unread.has(index),
  });

  const log: Recorded[] = [];
  const track = [
    'captureStart',
    'captureConfirmed',
    'captureResumed',
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

describe('configurable timings', () => {
  it('ships the tuned defaults', () => {
    // Retuned during manual testing; adjustable per-device from the admin panel.
    expect(DEFAULT_BUTTON_TIMINGS).toEqual({
      debounceMs: 150,
      recordThresholdMs: 500,
      minRecordingMs: 500,
      resumeGraceMs: 400,
      silentComboMs: 3000,
    });
    // A tap window must exist between them or tap-to-play is unreachable.
    expect(DEBOUNCE_MS).toBeLessThan(RECORD_THRESHOLD_MS);
  });

  it('honours a custom record threshold', () => {
    const { interpreter, names } = setup({ timings: { recordThresholdMs: 1200 } });

    interpreter.handleButtonDown(0);
    // Would already be a recording under the default 500ms threshold.
    vi.advanceTimersByTime(700);
    expect(names()).not.toContain('captureConfirmed');

    vi.advanceTimersByTime(600);
    expect(names()).toContain('captureConfirmed');
  });

  it('honours a custom debounce window', () => {
    const { interpreter, names } = setup({ timings: { debounceMs: 400 } });

    interpreter.handleButtonDown(0);
    // Inside the widened debounce window, so it stays silent.
    vi.advanceTimersByTime(300);
    interpreter.handleButtonUp(0);

    expect(names()).not.toContain('cancelBeep');
  });

  it('honours a custom silent-mode chord duration', () => {
    const { interpreter, names } = setup({ timings: { silentComboMs: 1000 } });

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(1000);

    expect(names()).toContain('toggleSilent');
  });

  it('reports the timings it was built with', () => {
    // Fixed for the process lifetime: saving config restarts the daemon rather than
    // reapplying values live, so there is no setter to get out of step with.
    const { interpreter } = setup({ timings: { recordThresholdMs: 1200 } });
    expect(interpreter.timings.recordThresholdMs).toBe(1200);
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
    // Committing waits out the resume window; see the block below.
    vi.advanceTimersByTime(RESUME_GRACE_MS);

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
    vi.advanceTimersByTime(RESUME_GRACE_MS);

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

describe('the resume window — letting go by accident', () => {
  it('does not commit the instant the button comes up', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1500);
    interpreter.handleButtonUp(0);

    expect(names()).not.toContain('captureCommit');
    expect(interpreter.hasPendingCommit(0)).toBe(true);
  });

  it('commits once the window expires with nothing more', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1500);
    interpreter.handleButtonUp(0);

    vi.advanceTimersByTime(RESUME_GRACE_MS - 1);
    expect(names()).not.toContain('captureCommit');

    vi.advanceTimersByTime(1);
    expect(names()).toContain('captureCommit');
    expect(interpreter.hasPendingCommit(0)).toBe(false);
  });

  it('continues the same take when the button comes back in time', () => {
    const { interpreter, log, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1500);
    interpreter.handleButtonUp(0);

    vi.advanceTimersByTime(RESUME_GRACE_MS - 100);
    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1000);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    expect(names()).toContain('captureResumed');
    // One take: the capture never restarted, so no second start and no second pop.
    expect(counts(log, 'captureStart')).toBe(1);
    expect(counts(log, 'captureConfirmed')).toBe(1);
    expect(counts(log, 'captureCommit')).toBe(1);
    expect(names()).not.toContain('captureCancel');
  });

  it('measures the take from the first press, without counting the window', () => {
    const { interpreter, find } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1500);
    interpreter.handleButtonUp(0);

    vi.advanceTimersByTime(200);
    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1000);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    // 1500 held + 200 gap + 1000 held. The trailing window is not speech, so it is not counted.
    expect(find('captureCommit')?.payload).toMatchObject({ index: 0, durationMs: 2700 });
  });

  it('reports how long the gap was, for the log', () => {
    const { interpreter, find } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1500);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(250);
    interpreter.handleButtonDown(0);

    expect(find('captureResumed')?.payload).toMatchObject({ index: 0, gapMs: 250 });
  });

  it('commits on release when the window is disabled', () => {
    const { interpreter, names } = setup({ timings: { resumeGraceMs: 0 } });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1500);
    interpreter.handleButtonUp(0);

    expect(names()).toContain('captureCommit');
    expect(interpreter.hasPendingCommit(0)).toBe(false);
  });

  it('never opens a window for a tap', () => {
    const { interpreter, log, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(0);
    expect(interpreter.hasPendingCommit(0)).toBe(false);

    // A second tap is its own press, not a continuation of the first.
    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(0);

    expect(names()).not.toContain('captureResumed');
    expect(counts(log, 'captureStart')).toBe(2);
    expect(names()).not.toContain('captureCommit');
  });

  it('still hits the recording ceiling while the window is open', () => {
    const { interpreter, find } = setup({
      maxRecordingSeconds: 5,
      timings: { resumeGraceMs: 2000 },
    });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(4000);
    interpreter.handleButtonUp(0);

    // The ceiling lands at 5s, inside the 2s window this release opened.
    vi.advanceTimersByTime(1000);
    expect(find('captureCommit')?.payload).toMatchObject({ reachedMaxDuration: true });
  });

  it('cannot be pumped past the recording ceiling', () => {
    const { interpreter, log, find } = setup({ maxRecordingSeconds: 3 });

    // Three grips with gaps between them. If a resume restarted the ceiling, the last one
    // would push the commit out to well past 3s.
    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(600);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(200);
    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(600);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(200);
    interpreter.handleButtonDown(0);

    vi.advanceTimersByTime(1399);
    expect(counts(log, 'captureCommit')).toBe(0);

    // 3s after the very first press, exactly.
    vi.advanceTimersByTime(1);
    expect(counts(log, 'captureCommit')).toBe(1);
    expect(find('captureCommit')?.payload).toMatchObject({ reachedMaxDuration: true });

    vi.advanceTimersByTime(5000);
    expect(counts(log, 'captureCommit')).toBe(1);
  });

  it('commits the waiting take when a different button is pressed', () => {
    const { interpreter, log, find } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1500);
    interpreter.handleButtonUp(0);

    // The child has moved on to another contact: do not leave two takes open at once.
    vi.advanceTimersByTime(100);
    interpreter.handleButtonDown(1);

    expect(find('captureCommit')?.payload).toMatchObject({ index: 0 });
    expect(interpreter.hasPendingCommit(0)).toBe(false);
    expect(counts(log, 'captureStart')).toBe(2);
  });

  it('reset() drops an open window without sending', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1500);
    interpreter.handleButtonUp(0);
    interpreter.reset();
    vi.advanceTimersByTime(10_000);

    expect(names()).not.toContain('captureCommit');
    expect(interpreter.hasPendingCommit(0)).toBe(false);
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
