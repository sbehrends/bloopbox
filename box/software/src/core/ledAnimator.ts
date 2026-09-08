import type { ButtonIndex } from '../config/schema.ts';
import { DeviceStatus, type DeviceSnapshot } from './deviceState.ts';

/**
 * Renders device state as LED output (PRODUCT.md §6).
 *
 * The animator only ever calls `setLed(index, on)` — it knows nothing about GPIO or the
 * browser. That keeps every pattern verifiable against a recording mock on fake timers.
 *
 * `PRODUCT.md` §6 describes each pattern in isolation, but they overlap in practice (a send
 * flash on LED 1 while LED 1 has an unread message). {@link resolveLed} is the single place
 * that arbitrates, using the priority ladder documented in CLAUDE.md.
 */

/** Timings, straight from the spec's signal matrix. Tests assert against these. */
export const LED_TIMINGS = {
  /** Boot chase: one step per LED. */
  bootStepMs: 200,
  /** Connecting: all three on, then all three off. */
  connectingHalfPeriodMs: 500,
  /** Unread: symmetric slow blink. */
  unreadHalfPeriodMs: 800,
  /** Message sent: three fast flashes. */
  sentFlashHalfPeriodMs: 100,
  sentFlashCount: 3,
  /** Silent-mode transition: one slow left-to-right pass. */
  silentTransitionStepMs: 500,
  /**
   * Setup hotspot: a double-pulse on all three, then quiet.
   *
   * A rhythm rather than another rate. Every other pattern here is a symmetric square wave
   * or a chase, and people tell rhythms apart across a room far more reliably than they tell
   * 0.5s blinking from 1.5s blinking — which is the distinction that would otherwise have to
   * carry "the setup network is up" against Connecting. Solid-on stays the language of error.
   */
  apPulseOnMs: 150,
  apPulseGapMs: 150,
  apPulsePeriodMs: 2000,
} as const;

/** Total lifetime of the 3-flash send confirmation. */
export const SENT_FLASH_DURATION_MS =
  LED_TIMINGS.sentFlashHalfPeriodMs * 2 * LED_TIMINGS.sentFlashCount;

/** Fixed at three buttons, positioned left / centre / right. */
export const LED_COUNT = 3;

/** Every LED index, for iteration. */
const LED_INDICES: readonly ButtonIndex[] = [0, 1, 2];

/** Total lifetime of the single chasing pass: one step per LED. */
export const SILENT_TRANSITION_DURATION_MS = LED_TIMINGS.silentTransitionStepMs * LED_COUNT;

/**
 * Tick period. 50ms divides every timing above exactly, so patterns land on precise
 * boundaries, and 20Hz is negligible load even on a Pi Zero 2 W.
 */
export const TICK_MS = 50;

/** A transient animation layered over the steady-state pattern. */
export type LedOverlay =
  | { readonly kind: 'sentFlash'; readonly index: ButtonIndex; readonly elapsedMs: number }
  | { readonly kind: 'silentTransition'; readonly elapsedMs: number };

/** Anything that can drive LEDs. The HAL satisfies this structurally. */
export type LedSink = {
  setLed(index: ButtonIndex, on: boolean): void;
};

/**
 * Decides whether one LED is lit. Pure: same inputs, same answer, no clock reads.
 *
 * Priority ladder, first match wins:
 *   1. recording on this button
 *   2. an active overlay (send flash, silent-mode transition)
 *   3. lifecycle status (boot chase, connecting blink, error patterns)
 *   4. unread on this button
 *   5. off
 *
 * Silent mode itself is **deliberately absent** from the ladder: while it is on the box looks
 * exactly like a normal idle box. Only the moment it flips is shown, by the `silentTransition`
 * overlay at step 2.
 */
export function resolveLed(
  index: ButtonIndex,
  snapshot: DeviceSnapshot,
  elapsedMs: number,
  overlay: LedOverlay | null,
): boolean {
  // 1. Recording wins outright: the child is holding this button right now.
  if (snapshot.recording === index) return true;

  // 2. Transient overlays.
  if (overlay) {
    if (overlay.kind === 'sentFlash') {
      // Only the button that sent flashes; the others fall through to steady state.
      if (overlay.index === index) {
        return isOnForSquareWave(overlay.elapsedMs, LED_TIMINGS.sentFlashHalfPeriodMs);
      }
    } else {
      const step = Math.floor(overlay.elapsedMs / LED_TIMINGS.silentTransitionStepMs);
      return step === index;
    }
  }

  // 3. Lifecycle status patterns cover all three LEDs.
  switch (snapshot.status) {
    case DeviceStatus.Booting: {
      const step = Math.floor(elapsedMs / LED_TIMINGS.bootStepMs) % LED_COUNT;
      return step === index;
    }
    case DeviceStatus.Connecting:
      return isOnForSquareWave(elapsedMs, LED_TIMINGS.connectingHalfPeriodMs);
    case DeviceStatus.WifiError:
      // Network gone: all three solid.
      return true;
    case DeviceStatus.SetupPortal:
      // Setup hotspot up: on, off, on, then dark for the rest of the period.
      return isOnForDoublePulse(elapsedMs);
    case DeviceStatus.WhatsAppError:
      // Wi-Fi fine, WhatsApp unlinked: outer-left pair solid.
      return index === 0 || index === 1;
    case DeviceStatus.Ready:
      break;
  }

  // 4. Unread messages waiting from this contact.
  if (snapshot.unreadCounts[index] > 0) {
    return isOnForSquareWave(elapsedMs, LED_TIMINGS.unreadHalfPeriodMs);
  }

  // 5. Ready and quiet — silent mode looks no different from audible.
  return false;
}

/** On for the first half of each period, off for the second. */
function isOnForSquareWave(elapsedMs: number, halfPeriodMs: number): boolean {
  return Math.floor(elapsedMs / halfPeriodMs) % 2 === 0;
}

/** Two short pulses at the start of each period, then dark. */
function isOnForDoublePulse(elapsedMs: number): boolean {
  const { apPulseOnMs, apPulseGapMs, apPulsePeriodMs } = LED_TIMINGS;
  const phase = elapsedMs % apPulsePeriodMs;
  if (phase < apPulseOnMs) return true;
  const secondPulseStart = apPulseOnMs + apPulseGapMs;
  return phase >= secondPulseStart && phase < secondPulseStart + apPulseOnMs;
}

/**
 * Drives a {@link LedSink} from a {@link DeviceSnapshot} on a fixed tick.
 *
 * Only changed LEDs are written, so a steady state costs nothing beyond the comparison —
 * this matters for the GPIO driver, where every write is a syscall.
 */
export class LedAnimator {
  readonly #sink: LedSink;
  #snapshot: DeviceSnapshot;
  #timer: NodeJS.Timeout | null = null;
  #startedAt = 0;
  #overlay: { kind: LedOverlay['kind']; index: ButtonIndex; startedAt: number } | null = null;
  /** Last value written per LED; null means "not yet written". */
  readonly #lastWritten: (boolean | null)[] = [null, null, null];
  /** Buttons held down, forced solid regardless of state (instant press feedback). */
  readonly #pressed = new Set<ButtonIndex>();

  constructor(sink: LedSink, initial: DeviceSnapshot) {
    this.#sink = sink;
    this.#snapshot = initial;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#startedAt = Date.now();
    this.render();
    this.#timer = setInterval(() => {
      this.render();
    }, TICK_MS);
    // Never hold the event loop open just to blink an LED.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Turns every LED off and forgets what was written. */
  blank(): void {
    for (const index of LED_INDICES) {
      this.#sink.setLed(index, false);
      this.#lastWritten[index] = false;
    }
  }

  update(snapshot: DeviceSnapshot): void {
    this.#snapshot = snapshot;
    this.render();
  }

  /** Instant visual acknowledgement while a button is physically held. */
  setPressed(index: ButtonIndex, pressed: boolean): void {
    if (pressed) this.#pressed.add(index);
    else this.#pressed.delete(index);
    this.render();
  }

  /** Three fast flashes on the button that just sent. */
  flashSent(index: ButtonIndex): void {
    this.#overlay = { kind: 'sentFlash', index, startedAt: Date.now() };
    this.render();
  }

  /** One slow left-to-right pass, confirming a silent-mode change. */
  playSilentTransition(): void {
    this.#overlay = { kind: 'silentTransition', index: 0, startedAt: Date.now() };
    this.render();
  }

  /** Computes and applies the current frame. Safe to call at any time. */
  render(): void {
    const now = Date.now();
    const elapsed = now - this.#startedAt;
    const overlay = this.#currentOverlay(now);

    for (const index of LED_INDICES) {
      const on = this.#pressed.has(index) || resolveLed(index, this.#snapshot, elapsed, overlay);
      if (this.#lastWritten[index] === on) continue;
      this.#lastWritten[index] = on;
      this.#sink.setLed(index, on);
    }
  }

  /** Resolves the live overlay, expiring it once its duration has elapsed. */
  #currentOverlay(now: number): LedOverlay | null {
    const active = this.#overlay;
    if (!active) return null;

    const elapsedMs = now - active.startedAt;
    const duration =
      active.kind === 'sentFlash' ? SENT_FLASH_DURATION_MS : SILENT_TRANSITION_DURATION_MS;

    if (elapsedMs >= duration) {
      this.#overlay = null;
      return null;
    }

    return active.kind === 'sentFlash'
      ? { kind: 'sentFlash', index: active.index, elapsedMs }
      : { kind: 'silentTransition', elapsedMs };
  }
}
