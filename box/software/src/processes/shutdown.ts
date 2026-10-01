/**
 * An orderly, bounded exit, shared by both daemons.
 *
 * The shutdown this replaced was one `async` chain: any step that rejected skipped every step
 * after it — the LEDs stayed lit, the activity totals went unflushed — and the fallback exit was
 * only armed once the whole chain had finished, so a step that never settled hung the process
 * until systemd's `TimeoutStopSec` SIGKILLed it. Now the fallback is armed first, every step runs
 * in its own try/catch, and a crash takes the same orderly path out with exit code 1.
 *
 * Exit code 0 stays reserved for a clean, intentional exit — the config-save restart among them —
 * which systemd's `Restart=always` turns into a restart either way. 1 is what makes the journal
 * say a crash happened.
 */

/** Longest an orderly shutdown may take. Well inside both units' `TimeoutStopSec=10`. */
export const SHUTDOWN_TIMEOUT_MS = 5000;

export type TeardownStep = {
  /** For the log line when the step fails. */
  readonly name: string;
  readonly run: () => unknown;
};

/** The three levels used, structurally, so a test can pass plain spies for a pino logger. */
export type ShutdownLog = Record<
  'info' | 'error' | 'fatal',
  (details: object, message: string) => void
>;

export type ShutdownOptions = {
  readonly log: ShutdownLog;
  /** Injectable for tests; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  readonly timeoutMs?: number;
};

/** What `installHandlers` listens on — `process`, or a stand-in in a test. */
export type ProcessEvents = {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  on(
    event: 'unhandledRejection' | 'uncaughtException',
    listener: (reason: unknown) => void,
  ): unknown;
};

export class Shutdown {
  readonly #log: ShutdownLog;
  readonly #exit: (code: number) => void;
  readonly #timeoutMs: number;
  #steps: readonly TeardownStep[] = [];
  #started = false;
  #exitCode = 0;

  constructor(options: ShutdownOptions) {
    this.#log = options.log;
    this.#exit = options.exit ?? ((code) => process.exit(code));
    this.#timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  }

  get started(): boolean {
    return this.#started;
  }

  /**
   * What to tear down, in order. Set once the daemon has built the things it names; a signal
   * that arrives before then exits straight away, which is all an unstarted daemon needs.
   */
  setSteps(steps: readonly TeardownStep[]): void {
    this.#steps = steps;
  }

  /**
   * Starts the shutdown. A second call only raises the exit code: a crash in the middle of a
   * clean restart must still be reported as a crash, but must not start a second teardown.
   */
  begin(reason: string, exitCode: 0 | 1 = 0): void {
    this.#exitCode = Math.max(this.#exitCode, exitCode);
    if (this.#started) return;
    this.#started = true;
    this.#log.info({ reason, exitCode }, 'shutting down');

    // First, so nothing below can keep the process alive past its budget.
    const deadline = setTimeout(() => {
      this.#log.error({ timeoutMs: this.#timeoutMs }, 'shutdown timed out; exiting anyway');
      this.#exit(this.#exitCode);
    }, this.#timeoutMs);
    deadline.unref();

    void (async (): Promise<void> => {
      for (const step of this.#steps) {
        try {
          await step.run();
        } catch (error: unknown) {
          this.#log.error({ err: error, step: step.name }, 'shutdown step failed; continuing');
        }
      }
      clearTimeout(deadline);
      this.#exit(this.#exitCode);
    })();
  }

  /**
   * Signals and crashes, both routed through `begin`. Installed at the very top of `main`, so a
   * failure during startup is also an orderly exit rather than whatever Node does by default.
   */
  installHandlers(target: ProcessEvents = process): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      target.on(signal, () => {
        this.begin(signal);
      });
    }
    target.on('unhandledRejection', (reason) => {
      this.#log.fatal({ err: reason }, 'unhandled promise rejection');
      this.begin('unhandledRejection', 1);
    });
    target.on('uncaughtException', (error) => {
      this.#log.fatal({ err: error }, 'uncaught exception');
      this.begin('uncaughtException', 1);
    });
  }
}
