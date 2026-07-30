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
  /** Released before the recording threshold. */
  | 'tooShort'
  /** Swallowed because the silent-mode chord took over. */
  | 'combo';

export type ButtonInterpreterEvents = {
  /**
   * Begin capturing audio. Fires immediately on press so nothing the child says is lost,
   * before we know whether this will end up a recording or a tap.
   */
  captureStart: [{ index: ButtonIndex }];
  /**
   * The press has passed `recordThresholdMs` and is definitely a recording.
   * This is when the "pop" cue plays — see the note on cue timing below.
   */
  captureConfirmed: [{ index: ButtonIndex }];
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
};

type ActivePress = {
  readonly index: ButtonIndex;
  readonly startedAt: number;
  /** Fires at `recordThresholdMs` to confirm this is a recording. */
  confirmTimer: NodeJS.Timeout | null;
  /** Fires at maxRecordingSeconds to auto-commit. */
  maxTimer: NodeJS.Timeout | null;
  confirmed: boolean;
  /** Set when the chord claimed this press, so release does nothing. */
  swallowed: boolean;
};

/**
 * Cue timing note (a deliberate deviation from PRODUCT.md §1).
 *
 * The spec plays the "pop" the moment the button is held. But we also resolved that a tap
 * on a blinking button plays that contact's queue (see CLAUDE.md), and at press time we
 * cannot yet tell a tap from a hold. Popping immediately would mean every tap-to-play
 * started with a spurious recording chime.
 *
 * So the pop is deferred to `recordThresholdMs`, when the press is unambiguously a
 * recording. Visual feedback (LED solid) still fires immediately, so the child always
 * gets instant acknowledgement that the device noticed them.
 */
export class ButtonInterpreter extends EventEmitter<ButtonInterpreterEvents> {
  readonly #timings: ButtonTimings;
  readonly #maxRecordingMs: number;
  readonly #hasUnread: (index: ButtonIndex) => boolean;
  readonly #active = new Map<ButtonIndex, ActivePress>();
  #comboTimer: NodeJS.Timeout | null = null;

  constructor(options: ButtonInterpreterOptions) {
    super();
    this.#timings = options.timings;
    this.#maxRecordingMs = options.maxRecordingSeconds * 1000;
    this.#hasUnread = options.hasUnread;
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

  handleButtonDown(index: ButtonIndex): void {
    if (this.#active.has(index)) return; // Already down; ignore repeat edges.

    const press: ActivePress = {
      index,
      startedAt: Date.now(),
      confirmTimer: null,
      maxTimer: null,
      confirmed: false,
      swallowed: false,
    };
    this.#active.set(index, press);

    this.emit('pressVisualOn', { index });
    this.emit('captureStart', { index });

    const { recordThresholdMs } = this.#timings;
    press.confirmTimer = setTimeout(() => {
      press.confirmTimer = null;
      if (press.swallowed) return;
      press.confirmed = true;
      this.emit('captureConfirmed', { index });

      // Only arm the auto-commit once we know this is a real recording.
      press.maxTimer = setTimeout(
        () => {
          press.maxTimer = null;
          this.#finish(index, true);
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

    this.#finish(index, false);
  }

  /** Drops all in-flight presses without emitting intents — used on shutdown or reset. */
  reset(): void {
    for (const press of this.#active.values()) {
      this.#clearTimers(press);
      this.emit('pressVisualOff', { index: press.index });
    }
    this.#active.clear();
    this.#disarmCombo();
  }

  #finish(index: ButtonIndex, reachedMaxDuration: boolean): void {
    const press = this.#active.get(index);
    if (!press) return;

    const durationMs = Date.now() - press.startedAt;
    this.#clearPress(press);
    this.emit('pressVisualOff', { index });

    if (press.confirmed) {
      this.emit('captureCommit', { index, durationMs, reachedMaxDuration });
      return;
    }

    this.emit('captureCancel', { index, durationMs, reason: 'tooShort' });

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
