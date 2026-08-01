/**
 * Decides when the setup hotspot goes up and when it comes down (PENDING.md, "AP hotspot /
 * captive portal").
 *
 * Pure and I/O-free like the rest of `src/core/`: it is fed observations and returns an
 * intent, and something else does the privileged work (`deploy/net-agent.sh`, as root). That
 * split is what makes the timing behaviour testable on fake timers instead of a Pi.
 */

/** Timings the supervisor runs on. A plain shape, not literals: they are overridable. */
export type NetworkTimings = {
  readonly unconfiguredGraceMs: number;
  readonly configuredGraceMs: number;
  readonly retryIntervalMs: number;
  readonly joinWindowMs: number;
};

/**
 * How long the device tolerates having no network before offering setup instead.
 *
 * Module constants rather than `config.buttons`-style schema fields, for now: nothing here
 * is about how the device *feels* to use, and no parent has asked. `NetworkSupervisor` takes
 * them as an option, so moving them into the schema later touches one call site.
 */
export const DEFAULT_NETWORK_TIMINGS: NetworkTimings = {
  /**
   * Unconfigured: the parent is standing there waiting, and there is nothing to lose by
   * raising the hotspot. `PRODUCT.md` §6 says 30s; 20s is the same intent, less standing about.
   */
  unconfiguredGraceMs: 20_000,
  /**
   * Configured: deliberately slow. A flat 30s here pops a hotspot into the house every time
   * the router reboots, which is both alarming and useless — the device would be back on the
   * network before anyone reached it.
   */
  configuredGraceMs: 180_000,
  /**
   * How often a hotspot that nobody is using steps aside to let the radio try the real
   * network again. One radio, so this cannot be a background scan: the AP has to come down
   * for the attempt.
   */
  retryIntervalMs: 60_000,
  /** How long that attempt gets before the hotspot goes back up. */
  joinWindowMs: 30_000,
};

/** One reading, as published by the root agent. */
export type NetworkObservation = {
  /** False when the agent has no information — an unknown state is never acted on. */
  readonly available: boolean;
  /** Associated with a real network and holding an address. */
  readonly online: boolean;
  /** The setup hotspot is currently up. */
  readonly apActive: boolean;
};

/** What the supervisor wants done. Anything privileged is somebody else's job. */
export const NetworkIntent = {
  None: 'none',
  ApUp: 'ap-up',
  ApDown: 'ap-down',
} as const;

export type NetworkIntent = (typeof NetworkIntent)[keyof typeof NetworkIntent];

/**
 * Internal phase. Not exported as a concept the rest of the app should reason about — the
 * device's *visible* state is `DeviceStatus.SetupPortal`, driven by `apActive` itself.
 */
const Phase = {
  /** No hotspot; waiting out the grace period. */
  Watching: 'watching',
  /** Hotspot up. */
  Hotspot: 'hotspot',
  /** Hotspot deliberately down, giving the radio a window to rejoin the real network. */
  Retrying: 'retrying',
} as const;

type Phase = (typeof Phase)[keyof typeof Phase];

export type NetworkSupervisorOptions = {
  /** Whether onboarding has been completed — the only thing that changes the grace period. */
  readonly configured: boolean;
  /**
   * Whether there is a network to go back to. Without one, a hotspot that steps aside has
   * nothing to try, so it simply stays up.
   */
  readonly hasTargetNetwork: boolean;
  readonly timings?: Partial<NetworkTimings>;
};

/**
 * Turns a stream of readings into hotspot decisions.
 *
 * Holds its options for its lifetime, like `ButtonInterpreter` — config is snapshot at boot
 * and a save restarts the daemon, so there is nothing to re-read.
 */
export class NetworkSupervisor {
  readonly #timings: NetworkTimings;
  readonly #configured: boolean;
  readonly #hasTargetNetwork: boolean;

  #phase: Phase = Phase.Watching;
  /** When the current phase began. Null in `watching` while the device is online. */
  #since: number | null = null;

  constructor(options: NetworkSupervisorOptions) {
    this.#timings = { ...DEFAULT_NETWORK_TIMINGS, ...options.timings };
    this.#configured = options.configured;
    this.#hasTargetNetwork = options.hasTargetNetwork;
  }

  /** The grace period in force, which depends only on whether the device is set up. */
  get graceMs(): number {
    return this.#configured ? this.#timings.configuredGraceMs : this.#timings.unconfiguredGraceMs;
  }

  /** Exposed for logging and tests; the device's visible state comes from `apActive`. */
  get phase(): Phase {
    return this.#phase;
  }

  /** Forgets everything, as if the daemon had just started. */
  reset(): void {
    this.#phase = Phase.Watching;
    this.#since = null;
  }

  /**
   * Feeds one reading in and gets back what to do about it.
   *
   * Returns an intent only on a transition — a caller polling every few seconds will see
   * `none` almost always, and acting on a repeated intent is never required.
   */
  observe(observation: NetworkObservation, nowMs: number): NetworkIntent {
    // No information is not the same as no network. Freeze rather than guess: raising a
    // hotspot because the agent went quiet would be the worst possible reading of silence.
    if (!observation.available) return NetworkIntent.None;

    if (observation.online) {
      // Back on the real network, from any phase. Nothing to ask for: the agent brings the
      // hotspot down as part of joining, and if one is somehow still up the next reading
      // will say so and be handled below.
      this.#enter(Phase.Watching, null);
      return NetworkIntent.None;
    }

    switch (this.#phase) {
      case Phase.Watching: {
        if (observation.apActive) {
          // Something outside us has a hotspot up — adopt it rather than fight it.
          this.#enter(Phase.Hotspot, nowMs);
          return NetworkIntent.None;
        }
        if (this.#since === null) {
          this.#since = nowMs;
          return NetworkIntent.None;
        }
        if (nowMs - this.#since < this.graceMs) return NetworkIntent.None;
        this.#enter(Phase.Hotspot, nowMs);
        return NetworkIntent.ApUp;
      }

      case Phase.Hotspot: {
        if (!observation.apActive) {
          // The hotspot went away without us asking. Start the grace period over rather than
          // immediately demanding it back, or a failing AP becomes a request loop.
          this.#enter(Phase.Watching, nowMs);
          return NetworkIntent.None;
        }
        // Nothing to step aside for: an unconfigured device has no network to rejoin, so the
        // hotspot stays up until someone uses it.
        if (!this.#hasTargetNetwork) return NetworkIntent.None;
        if (this.#since === null || nowMs - this.#since < this.#timings.retryIntervalMs) {
          return NetworkIntent.None;
        }
        this.#enter(Phase.Retrying, nowMs);
        return NetworkIntent.ApDown;
      }

      case Phase.Retrying: {
        if (this.#since !== null && nowMs - this.#since < this.#timings.joinWindowMs) {
          return NetworkIntent.None;
        }
        // The window closed without the device coming back. Offer setup again.
        this.#enter(Phase.Hotspot, nowMs);
        return NetworkIntent.ApUp;
      }
    }

    // Unreachable — the switch covers every phase — but doing nothing is the right answer to
    // a phase we do not recognise, and the linter wants the exit spelled out.
    return NetworkIntent.None;
  }

  #enter(phase: Phase, since: number | null): void {
    this.#phase = phase;
    this.#since = since;
  }
}
