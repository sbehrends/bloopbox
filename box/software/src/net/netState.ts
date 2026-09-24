import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
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

/** One network the agent saw, for the setup portal's picker. */
export type ScannedNetwork = {
  readonly ssid: string;
  /** 0-100. */
  readonly signal: number;
  /** Whether joining it needs a passphrase. */
  readonly secure: boolean;
};

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
  /** True while the setup hotspot is up. */
  readonly apActive: boolean;
  /** The hotspot's own SSID, so the portal can tell a parent what they joined. */
  readonly apSsid: string | null;
  /**
   * Networks in range.
   *
   * Captured while the radio was still a client — an interface hosting an access point
   * cannot scan — so during setup this is the room as it was moments before the hotspot
   * went up. `scanAgeSeconds` says how stale that is.
   */
  readonly scan: readonly ScannedNetwork[];
  readonly scanAgeSeconds: number;
  /** Why the last join failed, in words a parent can act on. Null if nothing has failed. */
  readonly lastError: string | null;
  /**
   * The id of the last request the agent acted on — its acknowledgement.
   *
   * The agent cannot delete the request file: it sits in the daemon's runtime directory, which
   * `ProtectSystem=strict` leaves read-only to it, and one writer per directory is the rule
   * anyway. So it remembers what it has done and says so here, and the daemon, which owns the
   * file, deletes it once it sees its own id come back.
   */
  readonly handledRequestId: string | null;
  /**
   * Whether the wall clock has been set from the network (`timedatectl`'s `NTPSynchronized`).
   *
   * A Pi has no real-time clock, so until NTP answers it runs on whatever time the last shutdown
   * saved — and quiet hours read that clock. **Null is "cannot tell", not "unsynced"**: no
   * `timedatectl` on the box, an agent that predates this field, or an answer that was not yes or
   * no. Observation only; nothing in the daemon acts on it yet (PENDING.md).
   */
  readonly timeSynced: boolean | null;
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
const scannedNetworkSchema = z.object({
  ssid: z.string().min(1).max(64),
  signal: z.number().min(0).max(100).catch(0),
  secure: z.boolean().catch(true),
});

const netStateSchema = z.object({
  version: z.literal(NET_STATE_VERSION),
  updatedAtMs: z.number(),
  available: z.boolean().catch(false),
  online: z.boolean().catch(false),
  ssid: z.string().min(1).nullable().catch(null),
  signal: z.number().nullable().catch(null),
  apActive: z.boolean().catch(false),
  apSsid: z.string().min(1).nullable().catch(null),
  // One malformed entry drops the whole list rather than the entry: a picker showing some of
  // the networks is worse than one showing none, because only the second is obviously wrong.
  scan: z.array(scannedNetworkSchema).max(40).catch([]),
  scanAgeSeconds: z.number().min(0).catch(0),
  lastError: z.string().max(200).nullable().catch(null),
  handledRequestId: z.string().min(1).max(80).nullable().catch(null),
  // Absent, or anything but a boolean, is unknown — never false, which would claim the agent had
  // asked and been told no.
  timeSynced: z.boolean().nullable().catch(null),
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
    apSsid: result.data.apSsid,
    scan: result.data.scan,
    scanAgeSeconds: result.data.scanAgeSeconds,
    lastError: result.data.lastError,
    // Absent from an agent that predates acknowledgements, which `.catch` reads as null.
    handledRequestId: result.data.handledRequestId,
    timeSynced: result.data.timeSynced,
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
  /**
   * Called on every poll, changed or not, with whatever was read.
   *
   * The hotspot supervisor is a timing machine: it needs the ticks, not just the edges.
   */
  readonly onReading?: (state: NetState | null) => void;
  /** Called when a reading goes stale or starts flowing again. */
  readonly onAgentHealthChange?: (healthy: boolean) => void;
  /** The request file to clear once the agent acknowledges it. Defaults to the device path. */
  readonly requestPath?: string;
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
  readonly #onReading: ((state: NetState | null) => void) | undefined;
  readonly #requestPath: string;

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
    this.#onReading = options.onReading;
    this.#requestPath = options.requestPath ?? NET_REQUEST_PATH;
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

    // Last, so anything reacting to a tick sees the transitions already applied.
    this.#onReading?.(state);

    if (state?.handledRequestId != null) {
      await clearHandledRequest(state.handledRequestId, this.#requestPath);
    }
  }
}

/**
 * Where the daemon asks the root agent for something (see `deploy/net-agent.sh`).
 *
 * In the daemon's own runtime directory, not the agent's: one writer per directory, so the
 * root agent never has to be able to write where the daemon writes, and never ends up owning
 * the recordings tmpfs.
 */
export const NET_REQUEST_PATH = process.env['NET_REQUEST_PATH'] ?? '/run/bloopbox/net-request.json';

/**
 * Everything the daemon is allowed to ask for. The agent enforces the same list.
 *
 * `forget` deletes the profile the device joined, which is what makes a factory reset
 * actually land back at onboarding: deleting `config.json` alone leaves NetworkManager
 * holding an autoconnecting profile, so the device stays online and `NetworkSupervisor`
 * never sees the outage that raises the hotspot.
 */
export const NET_ACTIONS = ['ap-up', 'ap-down', 'join', 'forget'] as const;

export type NetAction = (typeof NET_ACTIONS)[number];

/** Credentials for a `join`. Nothing else carries a payload. */
export type NetJoinCredentials = {
  readonly ssid: string;
  readonly psk: string;
};

/**
 * Every write and delete of the request file, one at a time.
 *
 * The daemon is the file's only writer, and this is what makes that true inside the process as
 * well: a request written between the acknowledgement check reading the old id and deleting the
 * file would otherwise be deleted unread.
 */
let requestFileLock: Promise<unknown> = Promise.resolve();

function withRequestFile<T>(work: () => Promise<T>): Promise<T> {
  const next = requestFileLock.then(work, work);
  requestFileLock = next.catch(() => undefined);
  return next;
}

/**
 * Writes one request for the root agent. Shared by the network actions and by power.
 *
 * Every request carries a fresh `id`, which is how the agent tells a new request from one it has
 * already acted on — it cannot delete the file (see {@link NetState.handledRequestId}), so without
 * this it would run the same join or reboot again on every poll.
 *
 * Written beside its final name and renamed into place, so the agent never reads a truncated
 * document: a plain `writeFile` empties the file first, and an agent reading in that instant
 * sees nothing, drops it, and the request is lost while the panel reports success. Mode 0640
 * because a join carries the Wi-Fi passphrase until the agent acknowledges it.
 */
export function writeAgentRequest(
  body: Readonly<Record<string, string>>,
  path: string = NET_REQUEST_PATH,
): Promise<boolean> {
  return withRequestFile(async () => {
    const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ ...body, id: randomUUID() })}\n`, {
        mode: 0o640,
      });
      await rename(temporary, path);
      return true;
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      return false;
    }
  });
}

/**
 * Deletes the request file once the agent has acknowledged the request in it.
 *
 * Compares ids rather than deleting on any acknowledgement, so a newer request written after the
 * one the agent reports is never removed before the agent has seen it. Never throws: a missing
 * or unreadable file simply has nothing to clear.
 */
export function clearHandledRequest(
  handledId: string,
  path: string = NET_REQUEST_PATH,
): Promise<void> {
  return withRequestFile(async () => {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return;
    }
    let pendingId: unknown;
    try {
      const parsed: unknown = JSON.parse(raw);
      pendingId =
        typeof parsed === 'object' && parsed !== null && 'id' in parsed ? parsed.id : null;
    } catch {
      return;
    }
    if (pendingId === handledId) await rm(path, { force: true }).catch(() => undefined);
  });
}

/**
 * Asks the agent for something.
 *
 * Fire-and-forget by design: the answer arrives as a changed reading, not as a return value,
 * because the agent is a separate process and the radio takes seconds to do anything. Never
 * throws — a request that cannot be written is logged by the caller and retried by the
 * supervisor on the next poll.
 */
export async function requestNetAction(
  action: NetAction,
  options: { readonly credentials?: NetJoinCredentials; readonly path?: string } = {},
): Promise<boolean> {
  const body =
    action === 'join' && options.credentials
      ? { action, ssid: options.credentials.ssid, psk: options.credentials.psk }
      : { action };
  return writeAgentRequest(body, options.path);
}
