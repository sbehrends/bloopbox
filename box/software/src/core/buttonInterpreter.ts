import { EventEmitter } from 'node:events';
import type { ButtonIndex, ButtonTimings } from '../config/schema.ts';

/**
 * Turns raw button edges into user intents (PRODUCT.md §1, §5, §7).
 *
 * Pure and I/O-free: it consumes `buttonDown`/`buttonUp` plus a "does this contact have
 * unread messages" query, and emits intents. Everything is driven by timers, so the whole
 * behaviour is testable on fake timers with no hardware and no sleeping.
 */

/**
 * The two outer buttons form the silent-mode chord.
 *
 * Press *timings* are not constants here — they live in `config.buttons` so they can be tuned
 * from the admin panel. They are read once at construction: saving config restarts the daemon,
 * so there is no need to reapply them mid-flight. See `DEFAULT_BUTTON_TIMINGS` in
 * `src/config/schema.ts` for the shipped values.
 */
export const SILENT_COMBO_BUTTONS: readonly ButtonIndex[] = [0, 2];

export type CancelReason =
  /**
   * Not a message: released before the microphone opened, or holding too little audio to be
   * one. Either way the press falls through to tap handling below.
   */
  | 'tooShort'
  /** Swallowed because the silent-mode chord took over. */
  | 'combo';

export type ButtonInterpreterEvents = {
  /**
   * The press has passed `recordThresholdMs`: play the "pop" and open the microphone behind
   * it, in that order. The single "start capturing" signal — see the note on cue timing below
   * for why nothing is captured before this point.
   */
  captureConfirmed: [{ index: ButtonIndex }];
  /**
   * The press reached `recordThresholdMs` on a read-only box, so no microphone opened.
   *
   * Fires exactly where `captureConfirmed` would have, and is the whole answer to the press:
   * releasing afterwards does nothing at all. A hold is a send gesture, and on a box that
   * cannot send, saying so at the moment the child expects the bip is more use than staying
   * silent and letting them press harder.
   */
  recordBlocked: [{ index: ButtonIndex }];
  /**
   * The button came back down inside the resume window: the *same* take is carrying on,
   * not a new one. No capture is started and no cue plays — the microphone never stopped
   * and the LED never went out.
   */
  captureResumed: [{ index: ButtonIndex; gapMs: number }];
  /** Keep the audio and send it. */
  captureCommit: [{ index: ButtonIndex; durationMs: number; reachedMaxDuration: boolean }];
  /** Throw the audio away. */
  captureCancel: [{ index: ButtonIndex; durationMs: number; reason: CancelReason }];
  /** A tap on a contact with unread messages — play their queue. */
  playQueue: [{ index: ButtonIndex }];
  /** A tap with nothing to play — the "oops" double-beep. */
  cancelBeep: [{ index: ButtonIndex }];
  /** The outer chord completed. */
  toggleSilent: [];
  /** Input acknowledged: hold the LED solid while a press is active. */
  pressVisualOn: [{ index: ButtonIndex }];
  /** Press finished: release the LED back to whatever the state machine wants. */
  pressVisualOff: [{ index: ButtonIndex }];
};

export type ButtonInterpreterOptions = {
  /** Press windows, from `config.buttons`. */
  readonly timings: ButtonTimings;
  /** Auto-commits a recording that runs this long, bounding RAM-disk use. */
  readonly maxRecordingSeconds: number;
  /** Whether the contact on this button has messages waiting. */
  readonly hasUnread: (index: ButtonIndex) => boolean;
  /**
   * Receive-only: refuse every hold rather than opening a capture (`config.mode.readOnly`).
   *
   * A plain boolean rather than a callback, because config is snapshot at boot and saving it
   * restarts the daemon — there is no state here that can change under a running press.
   */
  readonly readOnly?: boolean;
};

type ActivePress = {
  readonly index: ButtonIndex;
  /** When the *first* press of this take began. A resume carries it forward. */
  readonly startedAt: number;
  /** Fires at `recordThresholdMs` to confirm this is a recording. */
  confirmTimer: NodeJS.Timeout | null;
  /** Fires at maxRecordingSeconds to auto-commit. */
  maxTimer: NodeJS.Timeout | null;
  confirmed: boolean;
  /** Set when the chord claimed this press, so release does nothing. */
  swallowed: boolean;
  /** Set when a read-only box refused this press, so release does nothing either. */
  blocked: boolean;
};

/**
 * A confirmed recording whose button is currently *up*, waiting out `resumeGraceMs`.
 *
 * The capture is still open the whole time — pressing the same button again resumes it.
 * Only when this window expires does the take commit.
 */
type PendingCommit = {
  readonly index: ButtonIndex;
  readonly startedAt: number;
  /** When the button came up. The window itself is not held time, so it is not counted. */
  readonly releasedAt: number;
  graceTimer: NodeJS.Timeout | null;
  /** Inherited from the press: the max-duration ceiling keeps running across the window. */
  maxTimer: NodeJS.Timeout | null;
};

/**
 * Cue timing note (a deliberate deviation from PRODUCT.md §1).
 *
 * The "pop" is the *invitation to speak*, so it plays at `recordThresholdMs` (150 ms) and the
 * microphone opens **behind it**. Nothing before the bip is captured, which is the point: the
 * speaker sits next to the microphone, and opening first meant the bip landed inside every
 * message. Visual feedback (LED solid) still fires at press, so the child gets instant
 * acknowledgement that the device noticed them.
 *
 * The consequence is that this threshold can no longer be the tap/hold boundary — the bip has
 * to come long before we could know which a press is. So the boundary is
 * `recordThresholdMs + minRecordingMs` instead, and it is decided at *release* by
 * `#capturedMs()`: a press that never held the microphone open long enough to carry a message
 * falls through to tap handling and plays the waiting queue. A tap is therefore preceded by a
 * short bip, which is the accepted cost of a prompt one.
 *
 * The resume window (`timings.resumeGraceMs`).
 *
 * A confirmed recording does not commit the moment the button comes up. For a short window
 * it stays open, and pressing the same button again continues the same take: a toddler
 * whose grip slips mid-sentence can carry on rather than shipping half a message. Nothing
 * new has to be learned, because the existing signals already say it — the LED stays solid
 * (ladder rule 1 holds while `recording` is set) and the "whoosh" still marks the send.
 */
export class ButtonInterpreter extends EventEmitter<ButtonInterpreterEvents> {
  readonly #timings: ButtonTimings;
  readonly #maxRecordingMs: number;
  readonly #hasUnread: (index: ButtonIndex) => boolean;
  readonly #readOnly: boolean;
  readonly #active = new Map<ButtonIndex, ActivePress>();
  /** Confirmed recordings waiting out their resume window. */
  readonly #pending = new Map<ButtonIndex, PendingCommit>();
  #comboTimer: NodeJS.Timeout | null = null;

  constructor(options: ButtonInterpreterOptions) {
    super();
    this.#timings = options.timings;
    this.#maxRecordingMs = options.maxRecordingSeconds * 1000;
    this.#hasUnread = options.hasUnread;
    this.#readOnly = options.readOnly ?? false;
  }

  /** The active press windows. */
  get timings(): ButtonTimings {
    return this.#timings;
  }

  /** True while any button is being held. */
  get hasActivePress(): boolean {
    return this.#active.size > 0;
  }

  isPressed(index: ButtonIndex): boolean {
    return this.#active.has(index);
  }

  /** True while a released recording on this button is still open to being continued. */
  hasPendingCommit(index: ButtonIndex): boolean {
    return this.#pending.has(index);
  }

  handleButtonDown(index: ButtonIndex): void {
    if (this.#active.has(index)) return; // Already down; ignore repeat edges.

    const resuming = this.#pending.get(index);

    /*
     * A *different* button starting a press means the child has moved on: commit whatever
     * is waiting out its window rather than leaving two takes open at once. This also keeps
     * the silent-mode chord out of the resume path entirely — by the time both outer
     * buttons are down, no window is left open behind them.
     */
    this.#closeWindowsExcept(index);

    if (resuming) {
      this.#resume(resuming);
      return;
    }

    const press: ActivePress = {
      index,
      startedAt: Date.now(),
      confirmTimer: null,
      maxTimer: null,
      confirmed: false,
      swallowed: false,
      blocked: false,
    };
    this.#active.set(index, press);

    this.emit('pressVisualOn', { index });

    const { recordThresholdMs } = this.#timings;
    press.confirmTimer = setTimeout(() => {
      press.confirmTimer = null;
      if (press.swallowed) return;

      /*
       * Read-only: refuse here rather than at release. This is the moment the child is
       * waiting for the bip, so it is the moment the answer means something — and nothing
       * downstream ever learns of a capture that was never opened.
       */
      if (this.#readOnly) {
        press.blocked = true;
        this.emit('recordBlocked', { index });
        return;
      }

      press.confirmed = true;
      this.emit('captureConfirmed', { index });

      // Only arm the auto-commit once we know this is a real recording.
      press.maxTimer = setTimeout(
        () => {
          this.#maxDurationReached(index);
        },
        // Already recordThresholdMs into the press, so only the remainder is left.
        Math.max(0, this.#maxRecordingMs - recordThresholdMs),
      );
    }, recordThresholdMs);

    this.#maybeArmCombo();
  }

  handleButtonUp(index: ButtonIndex): void {
    const press = this.#active.get(index);
    if (!press) return; // Release without a matching press; nothing to do.

    // Any release breaks the chord.
    this.#disarmCombo();

    if (press.swallowed) {
      this.#clearPress(press);
      this.emit('pressVisualOff', { index });
      return;
    }

    /*
     * Only a take that already carries a message waits to be continued. Holding the window
     * open for a tap would delay the queue it is asking for by `resumeGraceMs` — and there is
     * nothing to carry on, since the microphone caught nothing worth keeping.
     */
    const { resumeGraceMs } = this.#timings;
    if (press.confirmed && resumeGraceMs > 0 && this.#isMessage(press.startedAt)) {
      this.#openWindow(press, resumeGraceMs);
      return;
    }

    this.#finish(index, false);
  }

  /**
   * Drops all in-flight presses and open windows without emitting intents — used on
   * shutdown or reset. Any capture still open is the caller's to tear down, exactly as it
   * has always been for a press that was mid-flight.
   */
  reset(): void {
    for (const press of this.#active.values()) {
      this.#clearTimers(press);
      this.emit('pressVisualOff', { index: press.index });
    }
    this.#active.clear();

    for (const pending of this.#pending.values()) {
      this.#clearPendingTimers(pending);
    }
    this.#pending.clear();

    this.#disarmCombo();
  }

  /* ---- the resume window ---- */

  /**
   * Holds a confirmed recording open after release, in case the button comes back down.
   *
   * `pressVisualOff` still fires — the press really is over — but the LED stays lit anyway,
   * because the capture is still running and the recording rule outranks it. That is the
   * whole signal: solid means "still listening".
   */
  #openWindow(press: ActivePress, resumeGraceMs: number): void {
    const { index } = press;

    if (press.confirmTimer !== null) {
      clearTimeout(press.confirmTimer);
      press.confirmTimer = null;
    }
    this.#active.delete(index);
    this.emit('pressVisualOff', { index });

    const pending: PendingCommit = {
      index,
      startedAt: press.startedAt,
      releasedAt: Date.now(),
      graceTimer: null,
      maxTimer: press.maxTimer,
    };
    pending.graceTimer = setTimeout(() => {
      pending.graceTimer = null;
      this.#commitPending(pending, false);
    }, resumeGraceMs);

    this.#pending.set(index, pending);
  }

  /** Takes an open window back over as a live press. Same take, so no new capture. */
  #resume(pending: PendingCommit): void {
    const { index } = pending;
    this.#pending.delete(index);
    if (pending.graceTimer !== null) {
      clearTimeout(pending.graceTimer);
      pending.graceTimer = null;
    }

    this.#active.set(index, {
      index,
      // Carried forward, so the take is measured from the first press.
      startedAt: pending.startedAt,
      confirmTimer: null,
      // The ceiling is not restarted: pumping the button must not extend a recording.
      maxTimer: pending.maxTimer,
      confirmed: true,
      swallowed: false,
      blocked: false,
    });

    this.emit('pressVisualOn', { index });
    this.emit('captureResumed', { index, gapMs: Date.now() - pending.releasedAt });

    this.#maybeArmCombo();
  }

  /** Commits every open window except the one this button might be about to resume. */
  #closeWindowsExcept(index: ButtonIndex): void {
    // Deleting from a Map mid-iteration is well defined: the iterator skips removed entries.
    for (const pending of this.#pending.values()) {
      if (pending.index === index) continue;
      this.#commitPending(pending, false);
    }
  }

  #commitPending(pending: PendingCommit, reachedMaxDuration: boolean): void {
    // Guard against a timer that fired after the window was already taken over or closed.
    if (this.#pending.get(pending.index) !== pending) return;

    this.#pending.delete(pending.index);
    this.#clearPendingTimers(pending);

    this.emit('captureCommit', {
      index: pending.index,
      // Time actually held, first press to final release — the window itself is not speech.
      durationMs: pending.releasedAt - pending.startedAt,
      reachedMaxDuration,
    });
  }

  /**
   * The recording ceiling fired. It bounds RAM-disk use, so it applies whether the button
   * is currently held or the take is waiting out its resume window.
   */
  #maxDurationReached(index: ButtonIndex): void {
    const press = this.#active.get(index);
    if (press) {
      press.maxTimer = null;
      this.#finish(index, true);
      return;
    }

    const pending = this.#pending.get(index);
    if (pending) {
      pending.maxTimer = null;
      this.#commitPending(pending, true);
    }
  }

  #clearPendingTimers(pending: PendingCommit): void {
    if (pending.graceTimer !== null) {
      clearTimeout(pending.graceTimer);
      pending.graceTimer = null;
    }
    if (pending.maxTimer !== null) {
      clearTimeout(pending.maxTimer);
      pending.maxTimer = null;
    }
  }

  #finish(index: ButtonIndex, reachedMaxDuration: boolean): void {
    const press = this.#active.get(index);
    if (!press) return;

    const durationMs = Date.now() - press.startedAt;
    const { blocked } = press;
    this.#clearPress(press);
    this.emit('pressVisualOff', { index });

    /*
     * Read-only already answered this press with `recordBlocked`. Falling through to tap
     * handling would play the waiting queue on top of the refusal — two sounds telling a
     * child two different things about one gesture, one of them rewarding the gesture that
     * was just refused.
     */
    if (blocked) return;

    /*
     * A confirmed press only sends if the microphone was open long enough to hold a message.
     * The ceiling firing is by definition long enough, and asking again on a fake-timer
     * boundary would be a needless way to lose a full-length recording.
     */
    if (press.confirmed && (reachedMaxDuration || this.#isMessage(press.startedAt))) {
      this.emit('captureCommit', { index, durationMs, reachedMaxDuration });
      return;
    }

    /*
     * Either the bip never played, or it did and the child let go straight after: a tap.
     * Read-only opens no captures, so there is nothing to tear down and the event would be
     * a claim about a microphone that never ran — none of the capture events fire there.
     */
    if (!this.#readOnly) {
      this.emit('captureCancel', { index, durationMs, reason: 'tooShort' });
    }

    if (durationMs < this.#timings.debounceMs) {
      // Bounce or brush: no sound at all.
      return;
    }

    // A deliberate tap: play what's waiting, otherwise tell them nothing was sent.
    if (this.#hasUnread(index)) {
      this.emit('playQueue', { index });
    } else {
      this.emit('cancelBeep', { index });
    }
  }

  /**
   * Arms the silent-mode chord once both outer buttons are down.
   *
   * Both presses are swallowed immediately: a child mashing the outer buttons should
   * never accidentally send two voice notes. If the chord is released early, nothing
   * happens at all — no send, no cancel beep.
   */
  #maybeArmCombo(): void {
    if (this.#comboTimer !== null) return;

    const allDown = SILENT_COMBO_BUTTONS.every((index) => this.#active.has(index));
    if (!allDown) return;

    for (const index of SILENT_COMBO_BUTTONS) {
      const press = this.#active.get(index);
      if (!press || press.swallowed) continue;
      press.swallowed = true;
      this.#clearTimers(press);
      // Read-only opens no captures, so there is never one for the chord to cancel.
      if (this.#readOnly) continue;
      const durationMs = Date.now() - press.startedAt;
      this.emit('captureCancel', { index, durationMs, reason: 'combo' });
    }

    this.#comboTimer = setTimeout(() => {
      this.#comboTimer = null;
      this.emit('toggleSilent');
    }, this.#timings.silentComboMs);
  }

  #disarmCombo(): void {
    if (this.#comboTimer === null) return;
    clearTimeout(this.#comboTimer);
    this.#comboTimer = null;
  }

  /**
   * Whether a take that started at `startedAt` and is ending now carries a message.
   *
   * The microphone opens at `recordThresholdMs`, so everything before that is the wait for the
   * bip and not speech. What is left has to reach `minRecordingMs` to be worth sending —
   * anything less is a tap the child held a moment too long, and treating it as one is what
   * keeps tap-to-play reachable now that the bip fires at 150 ms.
   *
   * Held time rather than file length on purpose: this is a pure module, and the answer has to
   * be the same before the HAL has finalised anything. `deviceController` still checks the
   * finished file, which catches the case this cannot see — a long hold whose microphone
   * delivered nothing.
   */
  #isMessage(startedAt: number): boolean {
    const capturedMs = Date.now() - startedAt - this.#timings.recordThresholdMs;
    return capturedMs >= this.#timings.minRecordingMs;
  }

  #clearPress(press: ActivePress): void {
    this.#clearTimers(press);
    this.#active.delete(press.index);
  }

  #clearTimers(press: ActivePress): void {
    if (press.confirmTimer !== null) {
      clearTimeout(press.confirmTimer);
      press.confirmTimer = null;
    }
    if (press.maxTimer !== null) {
      clearTimeout(press.maxTimer);
      press.maxTimer = null;
    }
  }
}
