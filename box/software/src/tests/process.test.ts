import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `runProcess` (src/audio/process.ts): every ffmpeg and amixer call goes through it.
 *
 * The property that matters most is that a call **ends**. One ffmpeg wedged on a malformed note
 * used to stop every later `prepare()` behind it, because the decodes run one at a time and none
 * had a deadline.
 */

type FakeChild = EventEmitter & {
  stderr: EventEmitter;
  pid: number;
  kills: string[];
};

/** `exits` closes on SIGTERM like ffmpeg; `stubborn` ignores everything, even SIGKILL. */
const behaviour = { onKill: 'exits' as 'exits' | 'stubborn', throwOnSpawn: false };
const spawned: { command: string; args: readonly string[]; child: FakeChild }[] = [];

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    if (behaviour.throwOnSpawn) throw new TypeError('bad arguments');
    const mode = behaviour.onKill;
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      pid: 4242,
      kills: [] as string[],
    });
    Object.assign(child, {
      kill: (signal: string) => {
        child.kills.push(signal);
        if (mode === 'exits') queueMicrotask(() => child.emit('close', null, signal));
        return true;
      },
    });
    spawned.push({ command, args, child });
    return child;
  },
}));

const { runProcess, ProcessError, PROCESS_KILL_GRACE_MS } = await import('../audio/process.ts');

/** The ProcessError a run rejected with; fails the test if it resolved or threw anything else. */
async function failureOf(run: Promise<void>): Promise<InstanceType<typeof ProcessError>> {
  const outcome: unknown = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(outcome instanceof ProcessError))
    throw new Error(`expected a ProcessError, got ${String(outcome)}`);
  return outcome;
}

function lastChild(): FakeChild {
  const entry = spawned.at(-1);
  if (!entry) throw new Error('nothing was spawned');
  return entry.child;
}

beforeEach(() => {
  spawned.length = 0;
  behaviour.onKill = 'exits';
  behaviour.throwOnSpawn = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runProcess', () => {
  it('resolves when the child exits 0', async () => {
    const run = runProcess({ command: 'ffmpeg', args: ['-y'], timeoutMs: 1000 });
    lastChild().emit('close', 0, null);

    await expect(run).resolves.toBeUndefined();
    expect(spawned[0]?.args).toEqual(['-y']);
  });

  it('rejects a non-zero exit with the tail of stderr, where the reason is', async () => {
    const run = runProcess({ command: 'amixer', args: [], timeoutMs: 1000, stderrTailBytes: 16 });
    const child = lastChild();
    child.stderr.emit('data', Buffer.from('banner banner banner banner\n'));
    child.stderr.emit('data', Buffer.from('no such control'));
    child.emit('close', 1, null);

    const failure = await failureOf(run);
    expect(failure.exitCode).toBe(1);
    expect(failure.timedOut).toBe(false);
    // Bounded, and the end kept rather than the start.
    expect(failure.stderr).toBe('no such control');
    expect(failure.message).toMatch(/amixer exited with code 1: no such control/);
  });

  it('turns a failure to start into a rejection, not an unhandled error event', async () => {
    const run = runProcess({ command: 'ffmpeg', args: [], timeoutMs: 1000 });
    lastChild().emit('error', new Error('spawn ffmpeg ENOENT'));
    // Node can follow 'error' with 'close'; it must not settle twice.
    lastChild().emit('close', -2, null);

    await expect(run).rejects.toThrow(/failed to start ffmpeg: spawn ffmpeg ENOENT/);
  });

  it('rejects a synchronous spawn failure too', async () => {
    behaviour.throwOnSpawn = true;
    await expect(runProcess({ command: 'ffmpeg', args: [], timeoutMs: 1000 })).rejects.toThrow(
      /failed to start ffmpeg: bad arguments/,
    );
  });

  it('SIGTERMs a child that overruns its deadline and reports the timeout', async () => {
    const settled = failureOf(runProcess({ command: 'ffmpeg', args: [], timeoutMs: 1000 }));

    await vi.advanceTimersByTimeAsync(1000);

    const failure = await settled;
    expect(lastChild().kills).toEqual(['SIGTERM']);
    expect(failure.timedOut).toBe(true);
    expect(failure.message).toMatch(/timed out after 1000 ms/);
  });

  it('escalates to SIGKILL, and settles even if the child never closes', async () => {
    behaviour.onKill = 'stubborn';
    const settled = failureOf(runProcess({ command: 'ffmpeg', args: [], timeoutMs: 1000 }));

    await vi.advanceTimersByTimeAsync(1000);
    expect(lastChild().kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(PROCESS_KILL_GRACE_MS);

    expect(lastChild().kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect((await settled).timedOut).toBe(true);
  });

  it('does not kill a child that finished in time', async () => {
    const run = runProcess({ command: 'ffmpeg', args: [], timeoutMs: 1000 });
    lastChild().emit('close', 0, null);
    await run;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(lastChild().kills).toEqual([]);
  });

  it('hands the live child to onSpawn', async () => {
    const seen: number[] = [];
    const run = runProcess({
      command: 'ffmpeg',
      args: [],
      timeoutMs: 1000,
      onSpawn: (child) => {
        if (child.pid !== undefined) seen.push(child.pid);
      },
    });
    lastChild().emit('close', 0, null);
    await run;

    expect(seen).toEqual([4242]);
  });
});
