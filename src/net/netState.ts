import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * What the device knows about its own network (PENDING.md, "AP hotspot / captive portal").
 *
 * The daemon runs unprivileged under `ProtectSystem=strict`, so it cannot ask
 * NetworkManager anything. `deploy/net-agent.sh` runs as root, polls `nmcli`, and publishes
 * the answer as JSON in a tmpfs; this module reads it. All the privileged work stays on the
 * other side of that file.
 *
 * Nothing here decides anything about the AP — this is observation only.
 */

/** Where the root agent publishes. Its own runtime directory, not the daemon's. */
export const NET_STATE_PATH = process.env['NET_STATE_PATH'] ?? '/run/bloopbox-net/net-state.json';

/**
 * How often the daemon re-reads the file. A stat-and-parse of a few hundred bytes in a RAM
 * disk, so the cost is noise; the point is that Wi-Fi loss shows on the LEDs promptly.
 */
export const NET_STATE_POLL_MS = 2000;

/**
 * A reading older than this is discarded as stale, which means the agent has stopped
 * publishing. Comfortably more than the agent's own 5s poll (`NET_AGENT_POLL_SECONDS` in
 * `deploy/net-agent.sh`) so ordinary jitter never trips it — keep the two in step.
 */
export const NET_STATE_MAX_AGE_MS = 30_000;

/** The schema version the agent writes. A mismatch is treated as no reading at all. */
export const NET_STATE_VERSION = 1;

/** A published reading, once validated. */
export type NetState = {
  /** When the agent wrote it, epoch ms. */
  readonly updatedAtMs: number;
  /** False when nmcli is missing — the agent is running but has nothing to report. */
  readonly available: boolean;
  /** Associated with a network and holding an address. */
  readonly online: boolean;
  /** The associated SSID, or null. Never a passphrase — the file is world-readable. */
  readonly ssid: string | null;
  /** Signal strength 0–100, or null when not associated. */
  readonly signal: number | null;
  /** True while the setup hotspot is up. Always false until that ships. */
  readonly apActive: boolean;
};

/**
 * Whether Wi-Fi should be reported as down.
 *
 * Deliberately conservative: only a fresh reading that explicitly says "not online" counts.
 * A missing file, an unparseable one, a stale one, or an agent without nmcli all mean
 * *unknown*, and unknown must not light the error pattern — on a dev machine the file never
 * exists at all, and inventing an outage from missing information is worse than missing one.
 */
export function isWifiDown(state: NetState | null, nowMs: number): boolean {
  if (state === null) return false;
  if (!state.available) return false;
  if (nowMs - state.updatedAtMs > NET_STATE_MAX_AGE_MS) return false;
  return !state.online;
}

/** True once a reading is too old to trust, so the daemon can log the agent going quiet. */
export function isStale(state: NetState, nowMs: number): boolean {
  return nowMs - state.updatedAtMs > NET_STATE_MAX_AGE_MS;
}

/**
 * The published document.
 *
 * Two tiers on purpose. `version` and `updatedAtMs` are strict — without them the reading
 * cannot be placed in time and is worthless, so a bad one is discarded outright. Everything
 * else carries `.catch()`, because this file is written by a shell script on the far side of
 * a privilege boundary: a field that arrives missing or wrong-typed should degrade to the
 * cautious answer, not throw away an otherwise usable reading.
 */
const netStateSchema = z.object({
  version: z.literal(NET_STATE_VERSION),
  updatedAtMs: z.number(),
  available: z.boolean().catch(false),
  online: z.boolean().catch(false),
  ssid: z.string().min(1).nullable().catch(null),
  signal: z.number().nullable().catch(null),
  apActive: z.boolean().catch(false),
});

/** Parses a published reading, or returns null if it cannot be trusted. */
export function parseNetState(raw: string): NetState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = netStateSchema.safeParse(parsed);
  if (!result.success) return null;

  return {
    updatedAtMs: result.data.updatedAtMs,
    available: result.data.available,
    online: result.data.online,
    ssid: result.data.ssid,
    signal: result.data.signal,
    apActive: result.data.apActive,
  };
}

/** Reads and validates the published reading. Null whenever it cannot be had. */
export async function readNetState(path: string = NET_STATE_PATH): Promise<NetState | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // Absent is the normal case in development and before the agent's first write.
    return null;
  }
  return parseNetState(raw);
}

export type NetStateWatcherOptions = {
  readonly path?: string;
  readonly intervalMs?: number;
  /** Injectable clock, so tests need no real waiting. */
  readonly now?: () => number;
  /** Called only when the answer changes, not on every poll. */
  readonly onWifiDownChange: (down: boolean) => void;
  /** Called when a reading goes stale or starts flowing again. */
  readonly onAgentHealthChange?: (healthy: boolean) => void;
};

/**
 * Polls the published reading and reports Wi-Fi transitions.
 *
 * Polling rather than `fs.watch`: the agent writes by rename, which `fs.watch` reports
 * inconsistently across platforms, and a 2s stat of a RAM-disk file costs nothing.
 */
export class NetStateWatcher {
  readonly #path: string;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #onWifiDownChange: (down: boolean) => void;
  readonly #onAgentHealthChange: ((healthy: boolean) => void) | undefined;

  #timer: NodeJS.Timeout | null = null;
  #wifiDown = false;
  #agentHealthy: boolean | null = null;
  #last: NetState | null = null;

  constructor(options: NetStateWatcherOptions) {
    this.#path = options.path ?? NET_STATE_PATH;
    this.#intervalMs = options.intervalMs ?? NET_STATE_POLL_MS;
    this.#now = options.now ?? Date.now;
    this.#onWifiDownChange = options.onWifiDownChange;
    this.#onAgentHealthChange = options.onAgentHealthChange;
  }

  /** The most recent trusted reading, for `/api/status`. */
  get last(): NetState | null {
    return this.#last;
  }

  get wifiDown(): boolean {
    return this.#wifiDown;
  }

  /** Reads once immediately, then on the interval. */
  async start(): Promise<void> {
    await this.poll();
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.poll();
    }, this.#intervalMs);
    // Never hold the event loop open just to read a status file.
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One read-and-compare. Exposed so tests can step it without timers. */
  async poll(): Promise<void> {
    const state = await readNetState(this.#path);
    this.#last = state;

    const healthy = state !== null && !isStale(state, this.#now());
    if (this.#agentHealthy !== healthy) {
      this.#agentHealthy = healthy;
      this.#onAgentHealthChange?.(healthy);
    }

    const down = isWifiDown(state, this.#now());
    if (down !== this.#wifiDown) {
      this.#wifiDown = down;
      this.#onWifiDownChange(down);
    }
  }
}
