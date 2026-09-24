import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SHUTDOWN_TIMEOUT_MS, Shutdown, type ProcessEvents } from '../processes/shutdown.ts';

/**
 * The way out of both daemons.
 *
 * What it replaced failed in two ways that matter on a device in a child's room: one step that
 * threw skipped the rest (lamps left lit, the last presses never counted), and one that hung
 * held the process until systemd killed it. Fake timers throughout, and `exit` is a spy, so
 * nothing here ends the test run.
 */

type LogSpy = (details: object, message: string) => void;

function rig(): {
  shutdown: Shutdown;
  exits: number[];
  log: Record<'info' | 'error' | 'fatal', Mock<LogSpy>>;
} {
  const exits: number[] = [];
  const log = { info: vi.fn<LogSpy>(), error: vi.fn<LogSpy>(), fatal: vi.fn<LogSpy>() };
  const shutdown = new Shutdown({ log, exit: (code) => exits.push(code) });
  return { shutdown, exits, log };
}

function emitter(): EventEmitter & ProcessEvents {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- EventEmitter's `on` is wider than ProcessEvents'
  return new EventEmitter() as EventEmitter & ProcessEvents;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Shutdown', () => {
  it('runs every step in order, then exits 0', async () => {
    const { shutdown, exits } = rig();
    const ran: string[] = [];
    shutdown.setSteps([
      { name: 'a', run: () => ran.push('a') },
      { name: 'b', run: async () => Promise.resolve(ran.push('b')) },
      { name: 'c', run: () => ran.push('c') },
    ]);
    shutdown.begin('SIGTERM');
    await vi.runAllTimersAsync();
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(exits[0]).toBe(0);
  });

  it('carries on past a step that throws or rejects, and logs which one', async () => {
    const { shutdown, exits, log } = rig();
    const ran: string[] = [];
    shutdown.setSteps([
      {
        name: 'throws',
        run: () => {
          throw new Error('boom');
        },
      },
      { name: 'rejects', run: async () => Promise.reject(new Error('nope')) },
      // The one that must never be skipped: it turns the lamps off.
      { name: 'hal', run: () => ran.push('hal') },
    ]);
    shutdown.begin('SIGTERM');
    await vi.runAllTimersAsync();
    expect(ran).toEqual(['hal']);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(exits[0]).toBe(0);
  });

  it('exits anyway when a step never settles, within the budget', async () => {
    const { shutdown, exits } = rig();
    shutdown.setSteps([{ name: 'hangs', run: async () => new Promise(() => undefined) }]);
    shutdown.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([0]);
  });

  it('arms the budget before the first step runs, so a step that blocks cannot skip it', () => {
    const { shutdown } = rig();
    let timersWhenStepRan = -1;
    shutdown.setSteps([{ name: 'first', run: () => (timersWhenStepRan = vi.getTimerCount()) }]);
    shutdown.begin('SIGTERM');
    expect(timersWhenStepRan).toBe(1);
  });

  it('tears down once, however many times it is asked', async () => {
    const { shutdown } = rig();
    const run = vi.fn<() => void>();
    shutdown.setSteps([{ name: 'once', run }]);
    shutdown.begin('SIGTERM');
    shutdown.begin('SIGINT');
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports a crash during a clean restart as a crash', async () => {
    const { shutdown, exits } = rig();
    shutdown.setSteps([{ name: 'slow', run: async () => new Promise((r) => setTimeout(r, 100)) }]);
    shutdown.begin('restart: config saved', 0);
    shutdown.begin('uncaughtException', 1);
    await vi.runAllTimersAsync();
    expect(exits[0]).toBe(1);
  });

  it('exits straight away when nothing has been registered yet', async () => {
    // A signal during startup: there is nothing to tear down, and nothing to wait for.
    const { shutdown, exits } = rig();
    shutdown.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([0]);
  });
});

describe('installHandlers', () => {
  it('shuts down cleanly on SIGTERM and SIGINT', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const { shutdown, exits } = rig();
      const target = emitter();
      shutdown.installHandlers(target);
      target.emit(signal);
      await vi.runAllTimersAsync();
      expect([signal, exits]).toEqual([signal, [0]]);
    }
  });

  it('turns an unhandled rejection or an uncaught exception into an orderly exit 1', async () => {
    for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
      const { shutdown, exits, log } = rig();
      const target = emitter();
      const run = vi.fn<() => void>();
      shutdown.setSteps([{ name: 'hal', run }]);
      shutdown.installHandlers(target);
      target.emit(event, new Error('bug'));
      await vi.runAllTimersAsync();
      expect([event, exits]).toEqual([event, [1]]);
      expect(run).toHaveBeenCalledTimes(1);
      expect(log.fatal).toHaveBeenCalledTimes(1);
    }
  });
});
