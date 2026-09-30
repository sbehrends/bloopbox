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

/**
 * How long a press may stay down before it is presumed to have lost its release edge.
 *
 * Only a button-up ends a press that opened no microphone — one refused (read-only), withheld
 * (notes waiting) or swallowed by the chord — and under the lockout that press also silences the
 * other two buttons. A single missed up edge would therefore freeze the whole box until somebody
 * happened to press the same button again. `gpioDriver.ts` is proven with only one of its buttons
 * so far and the debounce is in software, so a lost edge is not hypothetical.
 *
 * Past any real press: a recording ends at `maxRecordingSeconds` and a resumed one waits out one
 * more window, so a press still down after both is a switch that stopped reporting, not a child.
 * Derived rather than configured, because it follows from two values that already are.
 */
export function stuckPressMs(timings: ButtonTimings, maxRecordingSeconds: number): number {
  return maxRecordingSeconds * 1000 + timings.resumeGraceMs;
}

/** Why a hold was refused instead of opening a capture. */
export type BlockReason =
  /** `config.mode.readOnly`: this box never sends, so no hold ever does. */
  | 'readOnly'
  /**
   * Notes are waiting on this button, so listening is the only thing it does until they have
   * been heard (PRODUCT.md §1). No microphone ever opened, so nothing was recorded and there
   * is nothing to discard. The queue is not consumed here either — a *tap* asks for it.
   */
  | 'unread';

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
   * A hold that opened no microphone — see {@link BlockReason}. It is the whole answer to
   * the press: nothing else fires for it, in either direction.
   *
   * **When it fires differs by reason, because the two know different things.** `readOnly`
   * fires at `recordThresholdMs`, exactly where `captureConfirmed` would have: the box can
   * never send, so there is nothing left to learn and the moment the child expects the bip is
   * the moment an answer is worth most. `unread` fires at *release*, because until then a
   * press is not yet a hold — the boundary is `recordThresholdMs + minRecordingMs`, and
   * answering early would make a blinking button impossible to tap.
   *
   * Deliberately **not** followed by the queue playing, for either reason: answering "that
   * did not send" and then rewarding the same gesture with a message teaches that holding
   * plays, which is the one distinction the whole device rests on. A tap plays.
   */
  recordBlocked: [{ index: ButtonIndex; reason: BlockReason }];
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
  /**
   * Whether the contact on this button has messages waiting.
   *
   * Read at two moments: at `recordThresholdMs`, where waiting notes refuse the hold, and at
   * release, where a tap either plays them or gets the "oops".
   */
  readonly hasUnread: (index: ButtonIndex) => boolean;
  /**
   * Receive-only: refuse every hold rather than opening a capture (`config.mode.readOnly`).
   *
   * A plain boolean rather than a callback, because config is snapshot at boot and saving it
   * restarts the daemon — there is no state here that can change under a running press.
   */
  readonly readOnly?: boolean;
  /**
   * Which button's notes are playing right now, if any. While they play the other buttons are
   * locked out exactly as they are behind a held press: the child is listening, and a bip, an
   * "oops" or an open microphone beside the speaker would all talk across the message.
   *
   * Read at each down edge rather than pushed in, so it stays a query like `hasUnread`.
   */
  readonly listeningTo?: () => ButtonIndex | null;
};

type ActivePress = {
  readonly index: ButtonIndex;
  /** When the *first* press of this take began. A resume carries it forward. */
  readonly startedAt: number;
  /** Fires at `recordThresholdMs` to confirm this is a recording. */
  confirmTimer: NodeJS.Timeout | null;
  /** Fires at maxRecordingSeconds to auto-commit. */
  maxTimer: NodeJS.Timeout | null;
  /** Fires at {@link stuckPressMs} and drops the press, in case its release never arrives. */
  stuckTimer: NodeJS.Timeout | null;
  confirmed: boolean;
  /** Set when the chord claimed this press, so release does nothing. */
  swallowed: boolean;
  /** Set when the press was refused at the threshold, so release does nothing either. */
  blocked: boolean;
  /**
   * Set when the microphone was withheld because notes are waiting on this button. Unlike
   * `blocked`, the answer is still owed: release decides between playing them and refusing.
   */
  withheld: boolean;
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
 *
 * One button at a time (the lockout).
 *
 * While a press is down, or its take is waiting out the resume window, every *other* button is
 * ignored — its down edge, its release, and everything in between, even if it is still held
 * after the first one lets go. A toddler clutching one button grabs at the others, and without
 * this each grab opened a second take or committed the first mid-sentence. The only exception
 * is the silent-mode chord: the partner outer button may still join, but only while the first
 * press is short of being a message (`recordThresholdMs + minRecordingMs`). A parent presses
 * the two together; a child who is already talking keeps their take. Playing notes lock the
 * other buttons out the same way, for as long as the queue plays (`listeningTo`).
 */
export class ButtonInterpreter extends EventEmitter<ButtonInterpreterEvents> {
  readonly #timings: ButtonTimings;
  readonly #maxRecordingMs: number;
  readonly #hasUnread: (index: ButtonIndex) => boolean;
  readonly #readOnly: boolean;
  readonly #listeningTo: () => ButtonIndex | null;
  readonly #active = new Map<ButtonIndex, ActivePress>();
  /** Confirmed recordings waiting out their resume window. */
  readonly #pending = new Map<ButtonIndex, PendingCommit>();
  /**
   * Buttons that went down while another one owned the box, ignored until they come up — or
   * until {@link stuckPressMs} after they went down, so a lost release costs one press at most
   * rather than every press on that button from then on. Keyed to when they went down.
   */
  readonly #ignored = new Map<ButtonIndex, number>();
  readonly #stuckPressMs: number;
  #comboTimer: NodeJS.Timeout | null = null;

  constructor(options: ButtonInterpreterOptions) {
    super();
    this.#timings = options.timings;
    this.#maxRecordingMs = options.maxRecordingSeconds * 1000;
    this.#hasUnread = options.hasUnread;
    this.#readOnly = options.readOnly ?? false;
    this.#listeningTo = options.listeningTo ?? (() => null);
    this.#stuckPressMs = stuckPressMs(options.timings, options.maxRecordingSeconds);
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
    // Already down, or already being ignored; either way a repeat edge changes nothing.
    if (this.#active.has(index)) return;
    const ignoredAt = this.#ignored.get(index);
    if (ignoredAt !== undefined) {
      if (Date.now() - ignoredAt < this.#stuckPressMs) return;
      // Its release was lost long ago; this is a new press.
      this.#ignored.delete(index);
    }

    if (this.#isLockedOut(index)) {
      this.#ignored.set(index, Date.now());
      return;
    }

    const resuming = this.#pending.get(index);
    if (resuming) {
      this.#resume(resuming);
      return;
    }

    const press: ActivePress = {
      index,
      startedAt: Date.now(),
      confirmTimer: null,
      maxTimer: null,
      stuckTimer: null,
      confirmed: false,
      swallowed: false,
      blocked: false,
      withheld: false,
    };
    this.#active.set(index, press);
    this.#armStuckTimer(press);

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
        this.emit('recordBlocked', { index, reason: 'readOnly' });
        return;
      }

      /*
       * Notes waiting on this button: withhold the microphone, but say nothing yet.
       *
       * Nothing is refused *here* because this instant cannot tell a tap from a hold — the
       * boundary is `recordThresholdMs + minRecordingMs` and is only knowable at release.
       * Answering now would turn every tap longer than 150 ms into "that did not send" and
       * make the blinking button unplayable, which is the one thing it must do.
       *
       * So the press simply carries on with no capture behind it, and `#finish` splits it:
       * a tap plays the queue, a hold gets the refusal. The child hears no bip either way,
       * which is a bonus rather than a compromise — the bip is an invitation to speak, and
       * this button is not taking a message yet.
       *
       * Checked once, at the threshold, and never re-checked: a note that lands mid-sentence
       * must not cancel a message the child is already speaking.
       */
      if (this.#hasUnread(index)) {
        press.withheld = true;
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
    // Ignored at press, so ignored at release — and it must not break a chord it never joined.
    if (this.#ignored.delete(index)) return;

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
    this.#ignored.clear();

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
    if (press.stuckTimer !== null) {
      clearTimeout(press.stuckTimer);
      press.stuckTimer = null;
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

    const press: ActivePress = {
      index,
      // Carried forward, so the take is measured from the first press.
      startedAt: pending.startedAt,
      confirmTimer: null,
      // The ceiling is not restarted: pumping the button must not extend a recording.
      maxTimer: pending.maxTimer,
      stuckTimer: null,
      confirmed: true,
      swallowed: false,
      blocked: false,
      // A resumed take had its microphone opened at the first press; nothing was withheld.
      withheld: false,
    };
    this.#active.set(index, press);
    this.#armStuckTimer(press);

    this.emit('pressVisualOn', { index });
    this.emit('captureResumed', { index, gapMs: Date.now() - pending.releasedAt });

    this.#maybeArmCombo();
  }

  /**
   * Whether another button owns the box, so a press on `index` must be ignored.
   *
   * An open window on *this* button is not a lock — it is the take coming back to be resumed.
   * An open window on another one is, because that take is a message by construction.
   *
   * Playback locks the others out too, the chord included: a parent waits for the note to end.
   * The playing button itself stays on its ordinary path, which is already inert while its
   * queue plays — a tap asks for what is playing, and a hold is refused with no sound.
   */
  #isLockedOut(index: ButtonIndex): boolean {
    const listening = this.#listeningTo();
    if (listening !== null && listening !== index) return true;
    for (const pending of this.#pending.values()) {
      if (pending.index !== index) return true;
    }
    for (const press of this.#active.values()) {
      if (!this.#canJoinChord(press, index)) return true;
    }
    return false;
  }

  /**
   * The one press allowed alongside another: the other outer button, while the first press is
   * still short of a message. A resumed take carries its first press's start, so it never is.
   */
  #canJoinChord(owner: ActivePress, index: ButtonIndex): boolean {
    return (
      owner.index !== index &&
      SILENT_COMBO_BUTTONS.includes(owner.index) &&
      SILENT_COMBO_BUTTONS.includes(index) &&
      !this.#isMessage(owner.startedAt)
    );
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
    const { blocked, withheld } = press;
    const wasHold = this.#isMessage(press.startedAt);
    this.#clearPress(press);
    this.emit('pressVisualOff', { index });

    /*
     * The threshold already answered this press with `recordBlocked`. Falling through to tap
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
    if (press.confirmed && (reachedMaxDuration || wasHold)) {
      this.emit('captureCommit', { index, durationMs, reachedMaxDuration });
      return;
    }

    /*
     * A hold on a button with notes waiting: the send gesture, on the one button that is not
     * taking one. Refused now that the length says it really was a hold — and refused
     * *instead* of playing the queue, because rewarding the gesture with a message would
     * teach that holding plays, which is the distinction the whole device rests on.
     */
    if (withheld && wasHold) {
      this.emit('recordBlocked', { index, reason: 'unread' });
      return;
    }

    /*
     * Either the bip never played, or it did and the child let go straight after: a tap.
     * Read-only opens no captures, and neither does a button with notes waiting, so there is
     * nothing to tear down and the event would be a claim about a microphone that never ran.
     */
    if (!this.#readOnly && !withheld) {
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
      // Not the stuck-press timer: a swallowed press is ended only by its release, which is
      // exactly the kind of press that needs one.
      this.#clearCaptureTimers(press);
      // A press with no microphone behind it has nothing for the chord to cancel.
      if (this.#readOnly || press.blocked || press.withheld) continue;
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

  /**
   * Drops a press whose release never came, silently.
   *
   * A recording never gets here — the ceiling ends it first and commits what was said. What does
   * is a press that opened no microphone, and for those silence is right: the child let go long
   * ago, and any answer now would arrive out of nowhere.
   */
  #armStuckTimer(press: ActivePress): void {
    press.stuckTimer = setTimeout(() => {
      press.stuckTimer = null;
      if (this.#active.get(press.index) !== press) return;
      this.#clearPress(press);
      this.emit('pressVisualOff', { index: press.index });
    }, this.#stuckPressMs);
  }

  #clearPress(press: ActivePress): void {
    this.#clearTimers(press);
    this.#active.delete(press.index);
  }

  #clearTimers(press: ActivePress): void {
    this.#clearCaptureTimers(press);
    if (press.stuckTimer !== null) {
      clearTimeout(press.stuckTimer);
      press.stuckTimer = null;
    }
  }

  /** The timers that belong to a capture: the threshold and the ceiling. */
  #clearCaptureTimers(press: ActivePress): void {
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
