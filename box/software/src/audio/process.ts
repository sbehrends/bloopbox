import { spawn, type ChildProcess } from 'node:child_process';

/**
 * The one way this package runs a short-lived helper process — ffmpeg, amixer.
 *
 * Every child used to be spawned by hand, and none of them had a deadline. On a device with no
 * screen that is not a theoretical gap: `prepare()` decodes one note at a time, so a single
 * ffmpeg wedged on a malformed file silently stopped every later note from being decoded, and a
 * mixer call that hung would hold `init()` — and so the whole daemon — at boot. This gives every
 * call the same three guarantees: it ends, it says why, and a failure to start is an error rather
 * than an unhandled `'error'` event.
 *
 * Long-running children with their own lifecycle (`arecord`, `aplay`) are not run through here:
 * they are stopped on purpose by a button, not by a clock.
 */

/**
 * How long a child gets between SIGTERM and SIGKILL once its deadline has passed.
 *
 * SIGTERM first because ffmpeg finalises its output on it; a child that ignores it has already
 * shown it is stuck, and two seconds is long enough to tell those apart on a Pi Zero.
 */
export const PROCESS_KILL_GRACE_MS = 2000;

/**
 * How much of stderr an error keeps, from the end.
 *
 * The **tail**, not the head: ffmpeg and amixer both put the line that explains a failure last,
 * after whatever banner or progress preceded it. Bounded so a runaway child cannot grow it.
 */
export const DEFAULT_STDERR_TAIL_BYTES = 2048;

export type RunProcessOptions = {
  readonly command: string;
  readonly args: readonly string[];
  /** Deadline for the whole run. Past it the child is SIGTERMed, then SIGKILLed. */
  readonly timeoutMs: number;
  readonly stderrTailBytes?: number | undefined;
  readonly killGraceMs?: number | undefined;
  /** Called once with the live child, e.g. to lower its scheduling priority. */
  readonly onSpawn?: ((child: ChildProcess) => void) | undefined;
};

/** A helper process that did not start, did not finish in time, or exited non-zero. */
export class ProcessError extends Error {
  /* Declared and assigned separately: `erasableSyntaxOnly` forbids parameter properties. */
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The last `stderrTailBytes` of what the child wrote to stderr, trimmed. */
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(
    message: string,
    details: {
      readonly command: string;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stderr: string;
      readonly timedOut: boolean;
    },
  ) {
    super(message);
    this.name = 'ProcessError';
    this.command = details.command;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stderr = details.stderr;
    this.timedOut = details.timedOut;
  }
}

/**
 * Runs a command to completion. Resolves on exit code 0; rejects with a {@link ProcessError}
 * otherwise — including when it could not be spawned at all, and when it overran `timeoutMs`.
 *
 * stdin and stdout are closed. Nothing here writes to a child: an unread stdin pipe is an EPIPE
 * waiting to happen the moment the child exits early.
 */
export async function runProcess(options: RunProcessOptions): Promise<void> {
  const { command, args, timeoutMs } = options;
  const tailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
  const graceMs = options.killGraceMs ?? PROCESS_KILL_GRACE_MS;

  await new Promise<void>((resolve, reject) => {
    const tail = new StderrTail(tailBytes);
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const fail = (message: string, exitCode: number | null, signal: NodeJS.Signals | null) => {
      const stderr = tail.text();
      reject(
        new ProcessError(stderr.length > 0 ? `${message}: ${stderr}` : message, {
          command,
          exitCode,
          signal,
          stderr,
          timedOut,
        }),
      );
    };

    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error: unknown) {
      // spawn() throws synchronously for a malformed call (bad argument types, EINVAL); ENOENT
      // arrives as the 'error' event below instead.
      fail(`failed to start ${command}: ${describe(error)}`, null, null);
      return;
    }

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      return true;
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        /*
         * Settled here rather than on 'close': a child stuck in uninterruptible I/O does not
         * exit even for SIGKILL until the kernel lets it, and the caller must not wait on that.
         */
        if (settle()) fail(`${command} timed out after ${timeoutMs} ms`, null, 'SIGKILL');
      }, graceMs);
      killTimer.unref();
    }, timeoutMs);
    deadline.unref();

    child.stderr?.on('data', (chunk: Buffer) => {
      tail.push(chunk);
    });

    child.on('error', (error: Error) => {
      if (settle()) fail(`failed to start ${command}: ${error.message}`, null, null);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!settle()) return;
      if (timedOut) fail(`${command} timed out after ${timeoutMs} ms`, code, signal);
      else if (code === 0) resolve();
      else if (signal !== null) fail(`${command} was killed by ${signal}`, code, signal);
      else fail(`${command} exited with code ${String(code)}`, code, signal);
    });

    options.onSpawn?.(child);
  });
}

/** Keeps the last `limit` bytes written to it, in order. */
class StderrTail {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #length = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.#limit <= 0) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    if (this.#length > this.#limit * 2) this.#compact();
  }

  text(): string {
    this.#compact();
    return Buffer.concat(this.#chunks).toString('utf8').trim();
  }

  /** Collapses to one buffer of at most `limit` bytes; amortised so a chatty child is cheap. */
  #compact(): void {
    const joined = Buffer.concat(this.#chunks);
    const kept =
      joined.length > this.#limit ? joined.subarray(joined.length - this.#limit) : joined;
    this.#chunks = [kept];
    this.#length = kept.length;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
