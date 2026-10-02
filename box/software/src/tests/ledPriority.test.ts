import { describe, expect, it } from 'vitest';
import { DeviceStatus, type DeviceSnapshot } from '../core/deviceState.ts';
import { LED_TIMINGS, resolveLed, type LedOverlay } from '../core/ledAnimator.ts';
import type { ButtonIndex } from '../config/schema.ts';

/**
 * The LED priority ladder (`docs/architecture.md`, D-01), which resolves collisions PRODUCT.md §6 leaves
 * open. `resolveLed` is pure, so these assertions need no timers at all.
 */

function snapshot(overrides: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    status: DeviceStatus.Ready,
    silentMode: false,
    silentFromSchedule: false,
    recording: null,
    playing: null,
    unreadCounts: [0, 0, 0],
    ...overrides,
  };
}

/** Reads all three LEDs at one instant. */
function frame(
  state: DeviceSnapshot,
  elapsedMs: number,
  overlay: LedOverlay | null = null,
): [boolean, boolean, boolean] {
  const indices: ButtonIndex[] = [0, 1, 2];
  const [a, b, c] = indices.map((i) => resolveLed(i, state, elapsedMs, overlay));
  return [a!, b!, c!];
}

describe('ladder step 1 — recording beats everything [D-01]', () => {
  it('holds the recording button solid even during an error state with unread messages', () => {
    const state = snapshot({
      status: DeviceStatus.WifiError,
      recording: 1,
      silentMode: true,
      unreadCounts: [3, 3, 3],
    });

    // Sampled at two instants: solid means never off.
    expect(resolveLed(1, state, 0, null)).toBe(true);
    expect(resolveLed(1, state, 850, null)).toBe(true);
    expect(resolveLed(1, state, 1700, null)).toBe(true);
  });
});

describe('ladder step 2 — overlays beat status and unread [D-01]', () => {
  it('flashes only the sending button, leaving the others on their steady pattern', () => {
    const state = snapshot({ unreadCounts: [0, 0, 5] });
    const overlay: LedOverlay = { kind: 'sentFlash', index: 0, elapsedMs: 0 };

    const [led0, led1, led2] = frame(state, 0, overlay);
    expect(led0).toBe(true); // flashing
    expect(led1).toBe(false); // nothing to show
    expect(led2).toBe(true); // still blinking for its unread message
  });

  it('runs the silent transition chase across all three, overriding unread blink', () => {
    const state = snapshot({ unreadCounts: [9, 9, 9], silentMode: true });
    const step = LED_TIMINGS.silentTransitionStepMs;

    expect(frame(state, 0, { kind: 'silentTransition', elapsedMs: 0 })).toEqual([
      true,
      false,
      false,
    ]);
    expect(frame(state, 0, { kind: 'silentTransition', elapsedMs: step })).toEqual([
      false,
      true,
      false,
    ]);
    expect(frame(state, 0, { kind: 'silentTransition', elapsedMs: step * 2 })).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe('ladder step 3 — lifecycle status [D-01]', () => {
  it('chases one LED at a time while booting', () => {
    const state = snapshot({ status: DeviceStatus.Booting });
    const step = LED_TIMINGS.bootStepMs;

    expect(frame(state, 0)).toEqual([true, false, false]);
    expect(frame(state, step)).toEqual([false, true, false]);
    expect(frame(state, step * 2)).toEqual([false, false, true]);
    expect(frame(state, step * 3)).toEqual([true, false, false]); // loops
  });

  it('blinks all three together while connecting', () => {
    const state = snapshot({ status: DeviceStatus.Connecting });
    const half = LED_TIMINGS.connectingHalfPeriodMs;

    expect(frame(state, 0)).toEqual([true, true, true]);
    expect(frame(state, half)).toEqual([false, false, false]);
    expect(frame(state, half * 2)).toEqual([true, true, true]);
  });

  it('holds all three solid on a Wi-Fi error', () => {
    const state = snapshot({ status: DeviceStatus.WifiError });
    expect(frame(state, 0)).toEqual([true, true, true]);
    expect(frame(state, 5000)).toEqual([true, true, true]);
  });

  it('double-pulses all three while the setup hotspot is up', () => {
    const state = snapshot({ status: DeviceStatus.SetupPortal });
    const { apPulseOnMs, apPulseGapMs, apPulsePeriodMs } = LED_TIMINGS;
    const secondPulse = apPulseOnMs + apPulseGapMs;

    expect(frame(state, 0)).toEqual([true, true, true]);
    expect(frame(state, apPulseOnMs - 1)).toEqual([true, true, true]);
    // The gap between the two pulses is what makes this a rhythm rather than a blink.
    expect(frame(state, apPulseOnMs)).toEqual([false, false, false]);
    expect(frame(state, secondPulse)).toEqual([true, true, true]);
    expect(frame(state, secondPulse + apPulseOnMs)).toEqual([false, false, false]);
    // Dark for the rest of the period, then the rhythm repeats.
    expect(frame(state, apPulsePeriodMs - 1)).toEqual([false, false, false]);
    expect(frame(state, apPulsePeriodMs)).toEqual([true, true, true]);
  });

  it('is never confusable with Connecting: they disagree within one period', () => {
    // Both light all three, so the patterns have to differ in time, not in which LED.
    const hotspot = snapshot({ status: DeviceStatus.SetupPortal });
    const connecting = snapshot({ status: DeviceStatus.Connecting });
    const differing = [];
    for (let t = 0; t < LED_TIMINGS.apPulsePeriodMs; t += 50) {
      if (resolveLed(0, hotspot, t, null) !== resolveLed(0, connecting, t, null)) differing.push(t);
    }
    expect(differing.length).toBeGreaterThan(0);
  });

  it('holds only LEDs 1 and 2 on a WhatsApp error', () => {
    const state = snapshot({ status: DeviceStatus.WhatsAppError });
    expect(frame(state, 0)).toEqual([true, true, false]);
    expect(frame(state, 5000)).toEqual([true, true, false]);
  });

  it('outranks unread — an offline device does not advertise old messages', () => {
    const state = snapshot({ status: DeviceStatus.WifiError, unreadCounts: [1, 0, 0] });
    // Solid, not blinking: still true at the point an unread blink would be off.
    expect(resolveLed(0, state, LED_TIMINGS.unreadHalfPeriodMs, null)).toBe(true);
  });
});

describe('ladder step 4 — unread [D-01]', () => {
  it('blinks the unread button identically in silent mode and in audible mode', () => {
    const silent = snapshot({ silentMode: true, unreadCounts: [2, 0, 0] });
    const audible = snapshot({ silentMode: false, unreadCounts: [2, 0, 0] });
    const half = LED_TIMINGS.unreadHalfPeriodMs;

    for (const state of [silent, audible]) {
      expect(resolveLed(0, state, 0, null)).toBe(true);
      expect(resolveLed(0, state, half - 1, null)).toBe(true);
      expect(resolveLed(0, state, half, null)).toBe(false);
      expect(resolveLed(0, state, half * 2, null)).toBe(true);
    }
  });

  it('leaves the buttons without unread dark, silent mode or not', () => {
    const state = snapshot({ silentMode: true, unreadCounts: [2, 0, 0] });
    // Silent mode used to pulse the outer pair here (PRODUCT.md §6). It no longer shows at all.
    expect(resolveLed(1, state, 0, null)).toBe(false);
    expect(resolveLed(2, state, 0, null)).toBe(false);
  });
});

describe('ladder step 5 — off, silent mode included [D-01]', () => {
  /**
   * Silent mode is deliberately invisible: the box on a bedside table at night must look
   * exactly like an audible one. Only the moment it flips is shown, by the `silentTransition`
   * overlay tested at step 2.
   */
  it('holds every lamp dark for a full sweep of a silent idle box', () => {
    const silent = snapshot({ silentMode: true });
    for (let t = 0; t <= 8000; t += 50) {
      expect(frame(silent, t)).toEqual([false, false, false]);
    }
  });

  it('is indistinguishable from audible ready at every instant', () => {
    const silent = snapshot({ silentMode: true });
    const audible = snapshot({ silentMode: false });
    for (let t = 0; t <= 8000; t += 50) {
      expect(frame(silent, t)).toEqual(frame(audible, t));
    }
  });

  it('shows nothing for scheduled quiet hours either', () => {
    const scheduled = snapshot({ silentMode: true, silentFromSchedule: true });
    expect(frame(scheduled, 0)).toEqual([false, false, false]);
    expect(frame(scheduled, 2000)).toEqual([false, false, false]);
  });
});
