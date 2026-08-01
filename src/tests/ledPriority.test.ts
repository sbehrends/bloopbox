import { describe, expect, it } from 'vitest';
import { DeviceStatus, type DeviceSnapshot } from '../core/deviceState.ts';
import { LED_TIMINGS, resolveLed, type LedOverlay } from '../core/ledAnimator.ts';
import type { ButtonIndex } from '../config/schema.ts';

/**
 * The LED priority ladder (CLAUDE.md), which resolves collisions PRODUCT.md §6 leaves
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

describe('ladder step 1 — recording beats everything', () => {
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

describe('ladder step 2 — overlays beat status and unread', () => {
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

describe('ladder step 3 — lifecycle status', () => {
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

describe('ladder step 4 — unread beats the silent heartbeat', () => {
  it('blinks the unread button instead of pulsing it, even in silent mode', () => {
    const state = snapshot({ silentMode: true, unreadCounts: [2, 0, 0] });
    const half = LED_TIMINGS.unreadHalfPeriodMs;

    // Full blink duty cycle, not a 100ms pulse every 4s.
    expect(resolveLed(0, state, 0, null)).toBe(true);
    expect(resolveLed(0, state, half - 1, null)).toBe(true);
    expect(resolveLed(0, state, half, null)).toBe(false);
    expect(resolveLed(0, state, half * 2, null)).toBe(true);
  });

  it('still pulses the other outer button for silent mode', () => {
    const state = snapshot({ silentMode: true, unreadCounts: [2, 0, 0] });
    // Button 3 has no unread, so it keeps the heartbeat.
    expect(resolveLed(2, state, 0, null)).toBe(true);
    expect(resolveLed(2, state, LED_TIMINGS.silentPulseOnMs, null)).toBe(false);
  });
});

describe('ladder step 5 — silent-mode idle heartbeat', () => {
  it('pulses the outer pair briefly and leaves the centre dark', () => {
    const state = snapshot({ silentMode: true });

    expect(frame(state, 0)).toEqual([true, false, true]);
    expect(frame(state, LED_TIMINGS.silentPulseOnMs - 1)).toEqual([true, false, true]);
    expect(frame(state, LED_TIMINGS.silentPulseOnMs)).toEqual([false, false, false]);
  });

  it('repeats once every 4 seconds', () => {
    const state = snapshot({ silentMode: true });
    const period = LED_TIMINGS.silentPulsePeriodMs;

    expect(resolveLed(0, state, period - 1, null)).toBe(false);
    expect(resolveLed(0, state, period, null)).toBe(true);
    expect(resolveLed(0, state, period * 2, null)).toBe(true);
  });

  it('stays dark in audible ready mode — the spec wants all lights off', () => {
    const state = snapshot({ silentMode: false });
    expect(frame(state, 0)).toEqual([false, false, false]);
    expect(frame(state, 2000)).toEqual([false, false, false]);
  });
});
