import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceState, DeviceStatus } from '../core/deviceState.ts';
import {
  LED_TIMINGS,
  LedAnimator,
  SENT_FLASH_DURATION_MS,
  SILENT_TRANSITION_DURATION_MS,
  TICK_MS,
  type LedSink,
} from '../core/ledAnimator.ts';
import type { ButtonIndex } from '../config/schema.ts';

/**
 * The animator driving a recording sink over fake time — this is the "HAL interface test"
 * from PRODUCT.md §5, verifying the digital output patterns the real GPIO driver receives.
 */

type Write = { index: ButtonIndex; on: boolean; at: number };

/** Stands in for the HAL, recording every write with the time it happened. */
function recordingSink(): LedSink & { writes: Write[]; states: () => boolean[] } {
  const writes: Write[] = [];
  const states = [false, false, false];
  return {
    writes,
    states: () => [...states],
    setLed(index, on) {
      states[index] = on;
      writes.push({ index, on, at: Date.now() });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ticking', () => {
  it('drives the boot chase one LED at a time', () => {
    const state = new DeviceState();
    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());
    animator.start();

    expect(sink.states()).toEqual([true, false, false]);

    vi.advanceTimersByTime(LED_TIMINGS.bootStepMs);
    expect(sink.states()).toEqual([false, true, false]);

    vi.advanceTimersByTime(LED_TIMINGS.bootStepMs);
    expect(sink.states()).toEqual([false, false, true]);

    vi.advanceTimersByTime(LED_TIMINGS.bootStepMs);
    expect(sink.states()).toEqual([true, false, false]);

    animator.stop();
  });

  it('stops writing once stopped', () => {
    const state = new DeviceState();
    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());

    animator.start();
    animator.stop();
    const countAfterStop = sink.writes.length;

    vi.advanceTimersByTime(5000);
    expect(sink.writes).toHaveLength(countAfterStop);
  });

  it('writes only on change, not every tick', () => {
    const state = new DeviceState();
    state.setStatus(DeviceStatus.WifiError); // all three solid — a steady state
    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());

    animator.start();
    const afterFirstFrame = sink.writes.length;
    expect(afterFirstFrame).toBe(3); // one write per LED

    // 100 ticks of an unchanging pattern must produce no further syscalls.
    vi.advanceTimersByTime(TICK_MS * 100);
    expect(sink.writes).toHaveLength(afterFirstFrame);

    animator.stop();
  });

  it('blinks unread at 0.8s on, 0.8s off', () => {
    const state = new DeviceState();
    state.setStatus(DeviceStatus.Ready);
    state.addUnread(1, 1);

    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());
    animator.start();

    expect(sink.states()[1]).toBe(true);

    vi.advanceTimersByTime(LED_TIMINGS.unreadHalfPeriodMs);
    expect(sink.states()[1]).toBe(false);

    vi.advanceTimersByTime(LED_TIMINGS.unreadHalfPeriodMs);
    expect(sink.states()[1]).toBe(true);

    // The other two stay dark throughout.
    expect(sink.states()[0]).toBe(false);
    expect(sink.states()[2]).toBe(false);

    animator.stop();
  });
});

describe('one-shot overlays', () => {
  it('flashes three times then returns to the steady pattern', () => {
    const state = new DeviceState();
    state.setStatus(DeviceStatus.Ready);
    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());
    animator.start();

    // Baseline must be taken before flashSent(), which renders its first frame eagerly.
    const before = sink.writes.length;
    animator.flashSent(0);

    // Count on->off cycles for LED 0 over the overlay's lifetime.
    vi.advanceTimersByTime(SENT_FLASH_DURATION_MS);
    const flashWrites = sink.writes.slice(before).filter((w) => w.index === 0);
    const risingEdges = flashWrites.filter((w) => w.on).length;

    expect(risingEdges).toBe(LED_TIMINGS.sentFlashCount);

    // Overlay expired: back to all-off ready state.
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(sink.states()).toEqual([false, false, false]);

    animator.stop();
  });

  it('runs the silent transition as a single left-to-right pass', () => {
    const state = new DeviceState();
    state.setStatus(DeviceStatus.Ready);
    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());
    animator.start();

    animator.playSilentTransition();
    expect(sink.states()).toEqual([true, false, false]);

    vi.advanceTimersByTime(LED_TIMINGS.silentTransitionStepMs);
    expect(sink.states()).toEqual([false, true, false]);

    vi.advanceTimersByTime(LED_TIMINGS.silentTransitionStepMs);
    expect(sink.states()).toEqual([false, false, true]);

    // One pass only — it must not loop.
    vi.advanceTimersByTime(SILENT_TRANSITION_DURATION_MS);
    expect(sink.states()).toEqual([false, false, false]);

    animator.stop();
  });
});

describe('press feedback', () => {
  it('holds a pressed button solid regardless of the underlying pattern', () => {
    const state = new DeviceState();
    state.setStatus(DeviceStatus.Ready);
    state.addUnread(0, 1); // would otherwise blink
    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());
    animator.start();

    animator.setPressed(0, true);

    // Solid across a full blink period.
    expect(sink.states()[0]).toBe(true);
    vi.advanceTimersByTime(LED_TIMINGS.unreadHalfPeriodMs);
    expect(sink.states()[0]).toBe(true);
    vi.advanceTimersByTime(LED_TIMINGS.unreadHalfPeriodMs);
    expect(sink.states()[0]).toBe(true);

    animator.setPressed(0, false);
    animator.stop();
  });

  it('returns the LED to the state pattern on release', () => {
    const state = new DeviceState();
    state.setStatus(DeviceStatus.Ready);
    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());
    animator.start();

    animator.setPressed(2, true);
    expect(sink.states()[2]).toBe(true);

    animator.setPressed(2, false);
    expect(sink.states()[2]).toBe(false);

    animator.stop();
  });
});

describe('state updates', () => {
  it('re-renders immediately when the snapshot changes', () => {
    const state = new DeviceState();
    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());
    animator.start();

    state.setStatus(DeviceStatus.WifiError);
    animator.update(state.snapshot());

    expect(sink.states()).toEqual([true, true, true]);
    animator.stop();
  });

  it('blank() drives every LED off', () => {
    const state = new DeviceState();
    state.setStatus(DeviceStatus.WifiError);
    const sink = recordingSink();
    const animator = new LedAnimator(sink, state.snapshot());
    animator.start();
    expect(sink.states()).toEqual([true, true, true]);

    animator.stop();
    animator.blank();

    expect(sink.states()).toEqual([false, false, false]);
  });

  it('reports whether it is running', () => {
    const state = new DeviceState();
    const animator = new LedAnimator(recordingSink(), state.snapshot());

    expect(animator.running).toBe(false);
    animator.start();
    expect(animator.running).toBe(true);
    animator.stop();
    expect(animator.running).toBe(false);
  });
});
