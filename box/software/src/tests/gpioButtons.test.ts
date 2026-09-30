import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUTTON_SETTLE_MS } from '../hal/settledLine.ts';

/**
 * The GPIO driver's buttons, end to end from a watched line to `buttonDown` / `buttonUp`.
 *
 * `opengpio` is replaced by a fake board whose watches are EventEmitters with a live `value`, the
 * way the real addon's getter is a fresh `get_value()`. The bursts are shaped like the bench
 * recordings of 2026-09-30: several edges inside a millisecond, sometimes opening with the wrong one.
 */

/** A watched line: tests set `level` and emit edges; the driver reads `value` when it settles. */
class FakeWatch extends EventEmitter {
  level = true; // pulled up: released
  stopped = false;
  get value(): boolean {
    if (this.stopped) throw new Error('Cannot get value from stopped watcher');
    return this.level;
  }
  stop(): void {
    this.stopped = true;
  }
}

const watches: FakeWatch[] = [];

vi.mock('opengpio', () => {
  const board = Object.assign(function RaspberryPi_Zero2W() {}, {
    output: () => ({ value: false, stop: () => undefined }),
    watch: () => {
      const watch = new FakeWatch();
      watches.push(watch);
      return watch;
    },
  });
  return { Edge: { Both: 'both' }, RaspberryPi_Zero2W: board };
});

// amixer at init: exits at once, successfully.
vi.mock('node:child_process', () => ({
  execFile: () => undefined,
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
      kill: () => true,
      exitCode: null,
      signalCode: null,
    });
    setImmediate(() => child.emit('close', 0, null));
    return child;
  },
}));

vi.mock('../logger.ts', () => ({ childLogger: () => ({ warn: () => undefined }) }));

const { GpioHal } = await import('../hal/gpioDriver.ts');

let directory: string;
let hal: InstanceType<typeof GpioHal>;
let events: string[];

beforeEach(async () => {
  watches.length = 0;
  directory = await mkdtemp(join(tmpdir(), 'bloopbox-buttons-'));
  hal = new GpioHal({ recordingDirectory: directory, volumePercent: 50, micGainPercent: 70 });
  await hal.init();
  events = [];
  hal.on('buttonDown', ({ index }) => events.push(`down ${String(index)}`));
  hal.on('buttonUp', ({ index }) => events.push(`up ${String(index)}`));
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await hal.dispose();
  await rm(directory, { recursive: true, force: true });
});

/** Emits a burst of edges on one button and leaves its line at `settlesAt` (false = pressed). */
function burst(index: number, edges: readonly boolean[], settlesAt: boolean): void {
  const watch = watches[index];
  if (!watch) throw new Error(`no watch for button ${String(index)}`);
  for (const reported of edges) watch.emit('change', reported);
  watch.level = settlesAt;
}

describe('GPIO buttons', () => {
  it('watches all three buttons', () => {
    expect(watches).toHaveLength(3);
  });

  it('turns a bouncing press and release into exactly one down and one up', () => {
    burst(0, [false, true, false, false, true, false], false);
    vi.advanceTimersByTime(BUTTON_SETTLE_MS);
    burst(0, [true, false, true, true, false, true], true);
    vi.advanceTimersByTime(BUTTON_SETTLE_MS);

    expect(events).toEqual(['down 0', 'up 0']);
  });

  it('follows the level, not a burst that opens with the wrong edge', () => {
    // 17 bench bursts began with an `up`. The press still reads as a press.
    burst(2, [true, false, false, false, true, false], false);
    vi.advanceTimersByTime(BUTTON_SETTLE_MS);

    expect(events).toEqual(['down 2']);
  });

  it('reports nothing until the line has been quiet', () => {
    burst(1, [false, true, false], false);
    vi.advanceTimersByTime(BUTTON_SETTLE_MS - 1);
    expect(events).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(events).toEqual(['down 1']);
  });

  it('keeps each button to its own line', () => {
    burst(0, [false, true, false], false);
    burst(1, [false], false);
    vi.advanceTimersByTime(BUTTON_SETTLE_MS);

    expect(events.toSorted()).toEqual(['down 0', 'down 1']);
  });

  it('reports nothing that settles after dispose', async () => {
    burst(0, [false, true, false], false);
    vi.useRealTimers();
    await hal.dispose();
    vi.useFakeTimers();
    vi.advanceTimersByTime(BUTTON_SETTLE_MS * 2);

    expect(events).toEqual([]);
    // afterEach disposes again; a second dispose must be harmless.
  });
});
