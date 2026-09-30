import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonInterpreter, stuckPressMs, type CancelReason } from '../core/buttonInterpreter.ts';
import { DEFAULT_BUTTON_TIMINGS, type ButtonIndex, type ButtonTimings } from '../config/schema.ts';

/**
 * Button timing behaviour (PRODUCT.md §1, §5) and the tap-vs-cancel resolution recorded
 * in CLAUDE.md. Everything runs on fake timers — no sleeping, no flakes.
 */

type Recorded = { event: string; payload?: unknown };

const { debounceMs: DEBOUNCE_MS, recordThresholdMs: RECORD_THRESHOLD_MS } = DEFAULT_BUTTON_TIMINGS;
const SILENT_COMBO_MS = DEFAULT_BUTTON_TIMINGS.silentComboMs;
const RESUME_GRACE_MS = DEFAULT_BUTTON_TIMINGS.resumeGraceMs;
const MIN_RECORDING_MS = DEFAULT_BUTTON_TIMINGS.minRecordingMs;

/**
 * The tap/hold boundary: the microphone opens at the threshold, and what it catches has to
 * reach `minRecordingMs` for the press to be a message rather than a tap.
 */
const MESSAGE_MS = RECORD_THRESHOLD_MS + MIN_RECORDING_MS;

/** Comfortably inside the tap window: past debounce, short of the record threshold. */
const TAP_MS = Math.round((DEBOUNCE_MS + RECORD_THRESHOLD_MS) / 2);

/** A tap the child held too long: the bip played and the microphone opened, briefly. */
const LONG_TAP_MS = Math.round((RECORD_THRESHOLD_MS + MESSAGE_MS) / 2);

/** A deliberate hold: comfortably past the boundary, with room to spare. */
const HOLD_MS = MESSAGE_MS + 500;

/** How many times one event was emitted. */
const counts = (log: Recorded[], event: string): number =>
  log.filter((entry) => entry.event === event).length;

function setup(
  options: {
    unread?: ButtonIndex[];
    maxRecordingSeconds?: number;
    timings?: Partial<ButtonTimings>;
    readOnly?: boolean;
    listeningTo?: () => ButtonIndex | null;
  } = {},
) {
  const unread = new Set(options.unread ?? []);
  const interpreter = new ButtonInterpreter({
    timings: { ...DEFAULT_BUTTON_TIMINGS, ...options.timings },
    maxRecordingSeconds: options.maxRecordingSeconds ?? 30,
    hasUnread: (index) => unread.has(index),
    readOnly: options.readOnly ?? false,
    ...(options.listeningTo ? { listeningTo: options.listeningTo } : {}),
  });

  const log: Recorded[] = [];
  const track = [
    'captureConfirmed',
    'recordBlocked',
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
      debounceMs: 60,
      recordThresholdMs: 150,
      minRecordingMs: 1000,
      resumeGraceMs: 400,
      silentComboMs: 3000,
    });
    // The schema's own rule: without a gap here the bip could never precede a recording.
    expect(DEBOUNCE_MS).toBeLessThan(RECORD_THRESHOLD_MS);
    /*
     * And the tap window has to be wide enough for a small child to land in. It is no longer
     * bounded by the threshold — that only says when the bip plays — but by the threshold plus
     * `minRecordingMs`, which is where a press starts carrying a message.
     */
    expect(MESSAGE_MS - DEBOUNCE_MS).toBeGreaterThanOrEqual(500);
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

    // Too short even for the bip, so the microphone was never asked for.
    expect(names()).not.toContain('captureConfirmed');
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

    // Not even the bip: the microphone is never asked for below the threshold.
    expect(names()).not.toContain('captureConfirmed');
    expect(names()).toContain('cancelBeep');
  });
});

/**
 * The bip fires at 150 ms, long before anyone can tell a tap from a hold, so a press can open
 * the microphone and still turn out to be a tap. What decides is whether the microphone was
 * open long enough to hold a message — see `#isMessage`. Without this, lowering the threshold
 * would have made tap-to-play unreachable for any press over 150 ms.
 */
describe('tap — past the record threshold but short of a message', () => {
  it('plays the queue rather than sending an empty take', () => {
    const { interpreter, names } = setup({ unread: [1] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(LONG_TAP_MS);
    interpreter.handleButtonUp(1);

    /*
     * And with no bip at all: notes are waiting, so the microphone was withheld at the
     * threshold. The "a tap is preceded by a short bip" cost is paid only on a button with
     * nothing to play — exactly where the press might still turn out to be a message.
     */
    expect(names()).not.toContain('captureConfirmed');
    expect(names()).toContain('playQueue');
    expect(names()).not.toContain('captureCommit');
  });

  it('gives the "oops" beep when there is nothing waiting', () => {
    const { interpreter, names, find } = setup({ unread: [] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(LONG_TAP_MS);
    interpreter.handleButtonUp(1);

    expect(names()).toContain('cancelBeep');
    expect(find('captureCancel')?.payload).toMatchObject({ reason: 'tooShort' });
  });

  it('does not hold the queue behind a resume window', () => {
    // The child is asking for a message, not carrying on a take there is no audio for.
    // Waiting `resumeGraceMs` here would be latency for its own sake.
    const { interpreter, names } = setup({ unread: [1] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(LONG_TAP_MS);
    interpreter.handleButtonUp(1);

    expect(interpreter.hasPendingCommit(1)).toBe(false);
    expect(names()).toContain('playQueue');
  });

  it('sends the moment the take clears minRecordingMs', () => {
    // Nothing waiting on this button, so a hold is a send: see the unread block below.
    const { interpreter, names } = setup({ unread: [] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(MESSAGE_MS);
    interpreter.handleButtonUp(1);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    expect(names()).toContain('captureCommit');
    expect(names()).not.toContain('playQueue');
  });
});

describe('hold — at or beyond the record threshold', () => {
  it('confirms the recording at the threshold and commits on release', () => {
    const { interpreter, names, find } = setup();

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(RECORD_THRESHOLD_MS);
    expect(names()).toContain('captureConfirmed');

    vi.advanceTimersByTime(HOLD_MS - RECORD_THRESHOLD_MS);
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

/**
 * Notes waiting on a button make it a listening button until they have been heard
 * (PRODUCT.md §1). Nothing here consumes the queue — the interpreter only ever asks whether
 * one is waiting, and it is the *tap* that plays it.
 */
describe('hold — on a button with notes waiting', () => {
  it('refuses the send instead of recording', () => {
    const { interpreter, names, find } = setup({ unread: [1] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(1);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    expect(names()).toContain('recordBlocked');
    expect(find('recordBlocked')?.payload).toMatchObject({ index: 1, reason: 'unread' });
    expect(names()).not.toContain('captureCommit');
  });

  it('never opens a microphone, so there is nothing to discard', () => {
    const { interpreter, names } = setup({ unread: [1] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(1);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    // No bip, no capture, no cancel: none of these would be true of a capture that ran.
    expect(names()).not.toContain('captureConfirmed');
    expect(names()).not.toContain('captureCancel');
    expect(interpreter.hasPendingCommit(1)).toBe(false);
  });

  it('does not play the queue as well — a hold is not a listen', () => {
    // The whole reason the refusal is not "play it anyway": rewarding the send gesture with a
    // message is what would teach a child that holding plays.
    const { interpreter, names } = setup({ unread: [1] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(1);

    expect(names()).not.toContain('playQueue');
    expect(names()).not.toContain('cancelBeep');
  });

  it('still plays on a tap, at either length', () => {
    const { interpreter, names, log } = setup({ unread: [2] });

    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(2);

    // And again past the threshold, where a press used to be recording already.
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(LONG_TAP_MS);
    interpreter.handleButtonUp(2);

    expect(counts(log, 'playQueue')).toBe(2);
    expect(names()).not.toContain('recordBlocked');
  });

  it('leaves the other buttons free to send', () => {
    // Per contact, not per box: a note from mama does not stop a message to papa.
    const { interpreter, names } = setup({ unread: [1] });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    expect(names()).toContain('captureCommit');
    expect(names()).not.toContain('recordBlocked');
  });

  it('sends again once the queue has been heard', () => {
    const { interpreter, names, unread } = setup({ unread: [1] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(1);
    expect(names()).toContain('recordBlocked');

    // What `queueDrained` does on the device: the light goes out, and so does the block.
    unread.delete(1);

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(1);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    expect(names()).toContain('captureCommit');
  });

  it('is decided at the threshold, so a note arriving mid-sentence cannot cancel a take', () => {
    const { interpreter, names, unread } = setup({ unread: [] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(RECORD_THRESHOLD_MS);
    expect(names()).toContain('captureConfirmed');

    // Mama answers while the child is still talking. The microphone is already open.
    unread.add(1);
    vi.advanceTimersByTime(HOLD_MS - RECORD_THRESHOLD_MS);
    interpreter.handleButtonUp(1);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    expect(names()).toContain('captureCommit');
    expect(names()).not.toContain('recordBlocked');
  });

  it('does not swallow the silent-mode chord', () => {
    const { interpreter, names } = setup({ unread: [0, 2] });

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(SILENT_COMBO_MS);

    // The chord swallows both presses at button-down, before either could reach the
    // threshold, so the block never comes into it: no refusal, and releasing plays nothing.
    expect(names()).toContain('toggleSilent');
    expect(names()).not.toContain('recordBlocked');

    interpreter.handleButtonUp(0);
    interpreter.handleButtonUp(2);
    expect(names()).not.toContain('playQueue');
  });
});

describe('the resume window — letting go by accident', () => {
  it('does not commit the instant the button comes up', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(0);

    expect(names()).not.toContain('captureCommit');
    expect(interpreter.hasPendingCommit(0)).toBe(true);
  });

  it('commits once the window expires with nothing more', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
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
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(0);

    vi.advanceTimersByTime(RESUME_GRACE_MS - 100);
    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1000);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    expect(names()).toContain('captureResumed');
    // One take: the capture never restarted, so no second bip and no second microphone.
    expect(counts(log, 'captureConfirmed')).toBe(1);
    expect(counts(log, 'captureCommit')).toBe(1);
    expect(names()).not.toContain('captureCancel');
  });

  it('measures the take from the first press, without counting the window', () => {
    const { interpreter, find } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(0);

    vi.advanceTimersByTime(200);
    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(1000);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    // Both grips plus the gap between them. The trailing window is not speech, so it is not
    // counted — and neither is the resume window that closed the take.
    expect(find('captureCommit')?.payload).toMatchObject({
      index: 0,
      durationMs: HOLD_MS + 200 + 1000,
    });
  });

  it('reports how long the gap was, for the log', () => {
    const { interpreter, find } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(250);
    interpreter.handleButtonDown(0);

    expect(find('captureResumed')?.payload).toMatchObject({ index: 0, gapMs: 250 });
  });

  it('commits on release when the window is disabled', () => {
    const { interpreter, names } = setup({ timings: { resumeGraceMs: 0 } });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
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
    expect(counts(log, 'pressVisualOn')).toBe(2);
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
    const ceilingMs = 10_000;
    const { interpreter, log, find } = setup({ maxRecordingSeconds: ceilingMs / 1000 });

    // Three grips with gaps between them, each long enough to carry a message so each release
    // opens a window. If a resume restarted the ceiling, the last one would push the commit
    // out to well past the ceiling.
    const gapMs = 200;
    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(gapMs);
    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(gapMs);
    interpreter.handleButtonDown(0);

    const elapsed = HOLD_MS * 2 + gapMs * 2;
    vi.advanceTimersByTime(ceilingMs - elapsed - 1);
    expect(counts(log, 'captureCommit')).toBe(0);

    // 10s after the very first press, exactly.
    vi.advanceTimersByTime(1);
    expect(counts(log, 'captureCommit')).toBe(1);
    expect(find('captureCommit')?.payload).toMatchObject({ reachedMaxDuration: true });

    vi.advanceTimersByTime(5000);
    expect(counts(log, 'captureCommit')).toBe(1);
  });

  it('ignores a different button while the window is open, then commits on schedule', () => {
    const { interpreter, log, find } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(0);

    // The take is still open, so it still owns the box: the grab at another button is nothing.
    vi.advanceTimersByTime(100);
    interpreter.handleButtonDown(1);
    expect(interpreter.isPressed(1)).toBe(false);
    expect(interpreter.hasPendingCommit(0)).toBe(true);
    expect(counts(log, 'captureCommit')).toBe(0);

    vi.advanceTimersByTime(RESUME_GRACE_MS - 100);
    expect(find('captureCommit')?.payload).toMatchObject({ index: 0 });

    // Still held after the window closed, and still ignored: it began under the lock.
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(1);
    expect(counts(log, 'pressVisualOn')).toBe(1);
    expect(counts(log, 'captureConfirmed')).toBe(1);
    expect(counts(log, 'captureCommit')).toBe(1);
  });

  it('still resumes on the same button while another is being ignored', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(0);
    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(100);
    interpreter.handleButtonDown(0);

    expect(names()).toContain('captureResumed');
    expect(names()).not.toContain('captureCommit');
  });

  it('reset() drops an open window without sending', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(HOLD_MS);
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

  it('still forms when the second outer button comes down just short of a message', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(MESSAGE_MS - 1);
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(SILENT_COMBO_MS);

    expect(names()).toContain('toggleSilent');
  });

  it('cannot interrupt a child who is already sending a message', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(MESSAGE_MS);
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(SILENT_COMBO_MS);

    expect(names()).not.toContain('toggleSilent');
    expect(names()).not.toContain('captureCancel');

    interpreter.handleButtonUp(2);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(RESUME_GRACE_MS);
    expect(names()).toContain('captureCommit');
  });

  it('ignores the middle button once the chord has formed', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(2);
    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(SILENT_COMBO_MS);

    expect(interpreter.isPressed(1)).toBe(false);
    expect(names()).toContain('toggleSilent');
  });
});

/**
 * One button at a time. A toddler holding one button grabs at the others; without the lockout
 * each grab opened a second take beside the first, or answered with a beep mid-sentence.
 */
describe('lockout — one button owns the box', () => {
  it('ignores a second button while the first is being held', () => {
    const { interpreter, log, find } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(RECORD_THRESHOLD_MS);
    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(1);
    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(1);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    // Only button 0 ever did anything, and its take arrived whole.
    expect(log.filter((entry) => entry.event !== 'captureCommit')).toEqual([
      { event: 'pressVisualOn', payload: { index: 0 } },
      { event: 'captureConfirmed', payload: { index: 0 } },
      { event: 'pressVisualOff', payload: { index: 0 } },
    ]);
    expect(find('captureCommit')?.payload).toMatchObject({ index: 0 });
  });

  it('ignores the others during a tap, too', () => {
    const { interpreter, names } = setup({ unread: [2] });

    interpreter.handleButtonDown(1);
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(2);
    interpreter.handleButtonUp(1);

    // Button 1's "oops" is the whole answer; button 2's queue was not asked for.
    expect(names()).toContain('cancelBeep');
    expect(names()).not.toContain('playQueue');
  });

  it('keeps ignoring a button held across the first one letting go', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonDown(2);
    interpreter.handleButtonUp(1);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(2);

    expect(names()).not.toContain('captureConfirmed');
    expect(names().filter((name) => name === 'pressVisualOn')).toHaveLength(1);
  });

  it('frees every button once the owner is done', () => {
    const { interpreter, find } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(1);
    interpreter.handleButtonUp(0);

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(1);
    vi.advanceTimersByTime(RESUME_GRACE_MS);

    expect(find('captureCommit')?.payload).toMatchObject({ index: 1 });
  });

  it('does not let an ignored release break the chord', () => {
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(2);
    interpreter.handleButtonDown(1);
    interpreter.handleButtonUp(1);
    vi.advanceTimersByTime(SILENT_COMBO_MS);

    expect(names()).toContain('toggleSilent');
  });

  it('ignores the other buttons while a queue is playing', () => {
    let listening: ButtonIndex | null = 0;
    // Through setup(), so the assertion below sees every event the interpreter can emit, not a
    // hand-picked four: a stray recordBlocked or playQueue would slip past a partial list.
    const { interpreter, names } = setup({ listeningTo: () => listening });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(1);
    // Not even the chord: a parent waits for the note to end.
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(SILENT_COMBO_MS);
    // Playback ends while button 2 is still down; it began under the lock, so stays ignored.
    listening = null;
    vi.advanceTimersByTime(HOLD_MS);
    interpreter.handleButtonUp(2);
    expect(names()).toEqual([]);

    // Once it is over, every button is free again.
    interpreter.handleButtonDown(1);
    expect(interpreter.isPressed(1)).toBe(true);
  });

  it('leaves the playing button on its ordinary path', () => {
    const { interpreter } = setup({ unread: [0], listeningTo: () => 0 });

    interpreter.handleButtonDown(0);
    expect(interpreter.isPressed(0)).toBe(true);
  });

  it('reset() forgets ignored buttons', () => {
    const { interpreter } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(1);
    interpreter.reset();
    interpreter.handleButtonDown(1);

    expect(interpreter.isPressed(1)).toBe(true);
  });
});

describe('robustness', () => {
  it('ignores repeated down edges from a bouncing switch', () => {
    const { interpreter, log } = setup();

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(0);

    expect(log.filter((e) => e.event === 'pressVisualOn')).toHaveLength(1);
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

  /*
   * A lost release edge. Only a button-up ends a press that opened no microphone, and under the
   * lockout that press silences the other two buttons — so one missed edge, on a GPIO driver proven
   * with only one button, would freeze the whole box. The watchdog drops such a press once
   * it has been down longer than any real press can be.
   */
  describe('a press whose release never arrives', () => {
    const STUCK_MS = stuckPressMs(DEFAULT_BUTTON_TIMINGS, 30);

    it('is dropped silently, and the other buttons work again', () => {
      // Notes waiting on button 0: its hold withholds the microphone and has no ceiling.
      const { interpreter, names, log } = setup({ unread: [0] });
      interpreter.handleButtonDown(0);
      vi.advanceTimersByTime(HOLD_MS);

      interpreter.handleButtonDown(1);
      expect(interpreter.isPressed(1)).toBe(false); // locked out, as it should be

      vi.advanceTimersByTime(STUCK_MS);
      expect(interpreter.isPressed(0)).toBe(false);
      // No answer out of nowhere: the child let go long ago.
      expect(names()).not.toContain('recordBlocked');
      expect(names()).not.toContain('playQueue');
      expect(log.at(-1)).toEqual({ event: 'pressVisualOff', payload: { index: 0 } });

      interpreter.handleButtonUp(1);
      interpreter.handleButtonDown(1);
      expect(interpreter.isPressed(1)).toBe(true);
    });

    it('frees a press refused in read-only mode', () => {
      const { interpreter } = setup({ readOnly: true });
      interpreter.handleButtonDown(0);
      vi.advanceTimersByTime(STUCK_MS);

      interpreter.handleButtonDown(1);
      expect(interpreter.isPressed(1)).toBe(true);
    });

    it('frees a chord whose releases were lost', () => {
      const { interpreter, names } = setup();
      interpreter.handleButtonDown(0);
      interpreter.handleButtonDown(2);
      vi.advanceTimersByTime(STUCK_MS);

      expect(names()).toContain('toggleSilent'); // the chord itself still worked
      expect(interpreter.hasActivePress).toBe(false);
      interpreter.handleButtonDown(1);
      expect(interpreter.isPressed(1)).toBe(true);
    });

    it('lets an ignored button press again after its release was lost', () => {
      const { interpreter } = setup({ unread: [0] });
      interpreter.handleButtonDown(0);
      interpreter.handleButtonDown(1); // ignored behind button 0; its up edge never comes
      interpreter.handleButtonUp(0);
      vi.advanceTimersByTime(STUCK_MS);

      interpreter.handleButtonDown(1);
      expect(interpreter.isPressed(1)).toBe(true);
    });

    it('never cuts a recording short: the ceiling ends it first and sends it', () => {
      const { interpreter, find, names } = setup();
      interpreter.handleButtonDown(1);
      vi.advanceTimersByTime(STUCK_MS);

      expect(find('captureCommit')?.payload).toMatchObject({ index: 1, reachedMaxDuration: true });
      expect(names().filter((name) => name === 'captureCommit')).toHaveLength(1);
      expect(names()).not.toContain('captureCancel');
    });
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

/**
 * Read-only mode (PRODUCT.md §1, "Read-only mode").
 *
 * The claim under test is a pair: nothing a child does can open the microphone, and the half
 * of the device that still works is untouched. Everything here is written from the second
 * half as much as the first — a read-only box that also stopped playing would be broken, not
 * read-only.
 */
describe('read-only mode', () => {
  it('refuses the hold at the record threshold instead of opening a capture', () => {
    const { interpreter, names } = setup({ readOnly: true });

    interpreter.handleButtonDown(0);
    // Just short of the threshold: the box has said nothing yet either way.
    vi.advanceTimersByTime(RECORD_THRESHOLD_MS - 1);
    expect(names()).not.toContain('recordBlocked');

    // The moment the bip would have played is the moment the refusal lands.
    vi.advanceTimersByTime(1);
    expect(names()).toContain('recordBlocked');
    expect(names()).not.toContain('captureConfirmed');
  });

  it('refuses once and stays quiet through the release', () => {
    const { interpreter, names, log } = setup({ readOnly: true });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(MESSAGE_MS * 2);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(RESUME_GRACE_MS * 2);

    expect(counts(log, 'recordBlocked')).toBe(1);
    // No capture was ever opened, so there is nothing to commit and nothing to cancel.
    expect(names()).not.toContain('captureCommit');
    expect(names()).not.toContain('captureCancel');
    // And the refusal is the whole answer: releasing does not also play or beep.
    expect(names()).not.toContain('playQueue');
    expect(names()).not.toContain('cancelBeep');
  });

  it('does not play the queue when a refused hold is released', () => {
    // The case the fall-through would have got wrong: a hold on a button with notes waiting
    // would answer "did not send" and then reward the gesture by playing them anyway.
    const { interpreter, names } = setup({ readOnly: true, unread: [1] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(MESSAGE_MS * 2);
    interpreter.handleButtonUp(1);

    expect(names()).toContain('recordBlocked');
    expect(names()).not.toContain('playQueue');
  });

  it('still plays a waiting queue on a tap', () => {
    const { interpreter, names } = setup({ readOnly: true, unread: [1] });

    interpreter.handleButtonDown(1);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(1);

    expect(names()).toContain('playQueue');
    expect(names()).not.toContain('recordBlocked');
  });

  it('still beeps at a tap with nothing waiting', () => {
    const { interpreter, names } = setup({ readOnly: true });

    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(TAP_MS);
    interpreter.handleButtonUp(2);

    expect(names()).toContain('cancelBeep');
  });

  it('still ignores a brush shorter than the debounce window', () => {
    const { interpreter, names } = setup({ readOnly: true });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    interpreter.handleButtonUp(0);

    // Only the lamp acknowledging the touch. No sound of any kind, refusal included.
    expect(names()).toEqual(['pressVisualOn', 'pressVisualOff']);
  });

  it('still toggles silent mode on the outer chord, cancelling no capture', () => {
    const { interpreter, names } = setup({ readOnly: true });

    interpreter.handleButtonDown(0);
    interpreter.handleButtonDown(2);
    vi.advanceTimersByTime(SILENT_COMBO_MS);

    expect(names()).toContain('toggleSilent');
    // The chord swallows both presses, but in read-only there was never a capture to cancel.
    expect(names()).not.toContain('captureCancel');
    expect(names()).not.toContain('recordBlocked');
  });

  it('never opens a carry-on window', () => {
    const { interpreter, names } = setup({ readOnly: true });

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(MESSAGE_MS * 2);
    interpreter.handleButtonUp(0);

    // Nothing is waiting to be continued, because nothing was ever being recorded.
    expect(interpreter.hasPendingCommit(0)).toBe(false);

    // Pressing again is a fresh press, not a resume.
    interpreter.handleButtonDown(0);
    expect(names()).not.toContain('captureResumed');
  });

  it('never reaches the max-recording ceiling', () => {
    const { interpreter, names } = setup({ readOnly: true, maxRecordingSeconds: 1 });

    interpreter.handleButtonDown(0);
    // Far past the ceiling: the auto-commit timer is only armed by a real capture.
    vi.advanceTimersByTime(10_000);

    expect(names()).not.toContain('captureCommit');
  });

  it('leaves a two-way box alone', () => {
    // The same hold, with the flag off — the guard is the flag, not a change of behaviour.
    const { interpreter, names } = setup();

    interpreter.handleButtonDown(0);
    vi.advanceTimersByTime(MESSAGE_MS * 2);
    interpreter.handleButtonUp(0);
    vi.advanceTimersByTime(RESUME_GRACE_MS * 2);

    expect(names()).toContain('captureConfirmed');
    expect(names()).toContain('captureCommit');
    expect(names()).not.toContain('recordBlocked');
  });
});
