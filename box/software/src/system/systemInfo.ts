import { readFile, statfs } from 'node:fs/promises';
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from 'node:os';

/**
 * What the box can say about itself: temperature, uptime, load, memory, card space.
 *
 * This exists because the device has no screen and, once it is in a child's room, no keyboard
 * either. `bloopbox-doctor` answers all of this over SSH — which is exactly the tool a parent
 * does not have. Everything here is read-only observation of files the kernel already exposes,
 * so it needs no privilege the daemon does not already hold.
 *
 * **Every reading is nullable and every failure is silent.** All development happens on macOS,
 * where `/sys/class/thermal` does not exist; a diagnostics page that throws on a laptop is one
 * nobody works on. A null means "this box cannot tell you", which the panel renders as a dash.
 */

/** The Pi's SoC temperature, in millidegrees. Overridable so a test needs no `/sys`. */
export const THERMAL_ZONE_PATH =
  process.env['THERMAL_ZONE_PATH'] ?? '/sys/class/thermal/thermal_zone0/temp';

/** Where the kernel names the board. Absent on anything that is not a device tree platform. */
export const MODEL_PATH = process.env['DEVICE_MODEL_PATH'] ?? '/sys/firmware/devicetree/base/model';

/** Where the kernel lists the sound cards it has. Absent off Linux. */
export const SOUND_CARDS_PATH = process.env['SOUND_CARDS_PATH'] ?? '/proc/asound/cards';

/**
 * The playback device the HAL will actually open.
 *
 * Read from the environment here rather than imported: `src/hal/gpioDriver.ts` is the other
 * reader, and `src/system/` observing the HAL would be a layer pointing the wrong way for a
 * module whose whole job is read-only observation.
 */
const ALSA_PLAYBACK_DEVICE = process.env['ALSA_PLAYBACK_DEVICE'] ?? 'default';

/** One mounted filesystem worth reporting. */
export type StorageInfo = {
  /** What this volume is *for*, in the panel's words — "Card (settings and notes)". */
  readonly label: string;
  readonly path: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedPercent: number;
};

/**
 * Whether this box can actually make a sound.
 *
 * Worth its own reading because the failure it catches is invisible everywhere else. On
 * 2026-09-07 an upgrade regenerated `config.txt` without the codec overlay while
 * `/etc/bloopbox/environment` kept pointing at the card that overlay creates. The box booted,
 * joined Wi-Fi, connected to WhatsApp and reported `READY` — and had no sound card at all. The
 * only trace anywhere was a failed systemd unit, which is not a thing a parent can look at.
 */
export type AudioInfo = {
  /** The card the daemon is configured to play through, or null when it just says `default`. */
  readonly configuredCard: string | null;
  /** The cards the kernel actually has. Null where this box cannot say — anything but Linux. */
  readonly cards: readonly string[] | null;
  /** Whether the configured card is one of them. Null when either side is unknown. */
  readonly configuredCardPresent: boolean | null;
};

export type SystemInfo = {
  /** Epoch ms the reading was taken, so the panel can say how fresh it is. */
  readonly readAtMs: number;
  /** Seconds since the machine booted, and since this daemon started. The two differ after a
   *  config save, which restarts only the daemon — that gap is itself the diagnostic. */
  readonly uptimeSeconds: number;
  readonly processUptimeSeconds: number;
  readonly temperatureC: number | null;
  readonly cpu: {
    /** Busy time as a percentage over the window since the previous reading. Null on the first. */
    readonly usagePercent: number | null;
    readonly loadAverage: readonly [number, number, number];
    readonly cores: number;
  };
  readonly memory: {
    readonly totalBytes: number;
    /** What the kernel will actually hand out, from `MemAvailable` — page cache included.
     *  Falls back to `os.freemem()`, which on Linux understates it badly. */
    readonly availableBytes: number;
    readonly usedPercent: number;
    /** Whether `availableBytes` came from `/proc/meminfo` or from the pessimistic fallback. */
    readonly source: 'meminfo' | 'os';
  };
  readonly storage: readonly StorageInfo[];
  readonly audio: AudioInfo;
  readonly host: {
    readonly hostname: string;
    readonly platform: string;
    readonly release: string;
    readonly arch: string;
    readonly nodeVersion: string;
    /** "Raspberry Pi Zero 2 W Rev 1.0", or null where the kernel does not say. */
    readonly model: string | null;
  };
};

/** A volume to report on, named for what it holds rather than where it is mounted. */
export type StorageTarget = { readonly label: string; readonly path: string };

/**
 * CPU busy time, as a percentage of wall time since the last reading.
 *
 * Sampled per call rather than on a timer, and deliberately: a timer would keep a counter
 * running for the whole life of a device nobody is looking at, and the panel polls while it is
 * open. The window is therefore however long ago the page last asked, which is what "recent"
 * honestly means here.
 *
 * `os.cpus()` reports cumulative jiffies per core since boot, so the difference between two
 * readings is the only way to get a rate out of it — a single reading is an average over the
 * whole uptime and is useless for spotting a daemon spinning right now.
 */
export class CpuUsageTracker {
  #busy: number;
  #total: number;
  /** The last computed answer, reused when two reads land in the same instant. */
  #last: number | null = null;

  constructor(sample: CpuSample = sampleCpu()) {
    this.#busy = sample.busy;
    this.#total = sample.total;
  }

  /** Percent busy since the previous call. Null until a window has actually elapsed. */
  read(sample: CpuSample = sampleCpu()): number | null {
    const busyDelta = sample.busy - this.#busy;
    const totalDelta = sample.total - this.#total;
    this.#busy = sample.busy;
    this.#total = sample.total;
    // Two reads in the same tick, or a counter that went backwards across a suspend: neither is
    // a rate. Repeat the previous answer rather than inventing 0% or dividing by zero.
    if (totalDelta <= 0) return this.#last;
    this.#last = clampPercent((busyDelta / totalDelta) * 100);
    return this.#last;
  }
}

export type CpuSample = { readonly busy: number; readonly total: number };

/** Summed CPU jiffies across every core: everything, and everything that was not idle. */
export function sampleCpu(): CpuSample {
  let busy = 0;
  let total = 0;
  for (const core of cpus()) {
    const { user, nice, sys, idle, irq } = core.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

/** The SoC temperature in °C, or null where the kernel does not publish one. */
export async function readTemperatureC(path: string = THERMAL_ZONE_PATH): Promise<number | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const milli = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(milli)) return null;
    /*
     * A thermal zone's `temp` file is millidegrees by the sysfs contract, so the division is
     * not a guess — the bounds only catch a garbage read. Out of range answers null
     * rather than a number: a dash reads as "this box cannot tell you", and any figure at all
     * reads as a measurement.
     */
    const celsius = milli / 1000;
    return celsius > -50 && celsius < 200 ? Math.round(celsius * 10) / 10 : null;
  } catch {
    return null;
  }
}

/** The board's own name, as the device tree states it. Null off a device-tree platform. */
export async function readModel(path: string = MODEL_PATH): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8');
    // The device tree stores a null-terminated string; the trailing NUL comes through verbatim.
    const trimmed = raw.replaceAll('\0', '').trim();
    return trimmed.length > 0 ? trimmed.slice(0, 120) : null;
  } catch {
    return null;
  }
}

/**
 * The card name out of an ALSA device string, or null when the string does not name one.
 *
 * `plughw:CARD=wm8960soundcard,DEV=0` is the form the installer writes, and it is addressed by
 * name precisely so a card that changes number cannot send audio somewhere else. `plughw:1,0`
 * and `default` name no card, so there is nothing here that could be checked — null, not a
 * guess, because the panel renders a guess as a fact.
 */
export function parseAlsaCardName(device: string): string | null {
  const named = /(?:^|[:,])CARD=([^,\s]+)/.exec(device);
  return named?.[1] ?? null;
}

/**
 * The card names in `/proc/asound/cards`, whose rows look like:
 *
 * ```
 *  0 [wm8960soundcard]: simple-card - wm8960-soundcard
 *                       wm8960-soundcard
 * ```
 *
 * Null, not `[]`, when the file is missing: "no cards at all" and "this machine does not keep
 * such a list" are different answers, and only the first is a fault.
 */
export async function readSoundCards(path: string = SOUND_CARDS_PATH): Promise<string[] | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return [...raw.matchAll(/^\s*\d+\s+\[([^\]]+)\]/gm)].map((match) => (match[1] ?? '').trim());
  } catch {
    return null;
  }
}

/** One reading of whether the configured playback card is really there. */
export async function readAudioInfo(
  device: string = ALSA_PLAYBACK_DEVICE,
  path: string = SOUND_CARDS_PATH,
): Promise<AudioInfo> {
  const configuredCard = parseAlsaCardName(device);
  const cards = await readSoundCards(path);
  return {
    configuredCard,
    cards,
    // Both halves have to be known before this can mean anything. A dev machine has no
    // /proc/asound and an unnamed device has nothing to look for; neither is a broken box.
    configuredCardPresent:
      configuredCard === null || cards === null ? null : cards.includes(configuredCard),
  };
}

/**
 * Memory the kernel would actually give a process.
 *
 * `os.freemem()` is `MemFree`, which on Linux excludes the page cache and so reports a healthy
 * Pi as nearly out of memory — the classic misreading. `MemAvailable` is the kernel's own
 * estimate of what is reclaimable, and is the number worth showing a parent.
 */
export async function readAvailableMemory(): Promise<{
  bytes: number;
  source: 'meminfo' | 'os';
}> {
  try {
    const raw = await readFile('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(raw);
    if (match?.[1] !== undefined) return { bytes: Number(match[1]) * 1024, source: 'meminfo' };
  } catch {
    // Not Linux, or a kernel too old for MemAvailable. The fallback is honest, just gloomy.
  }
  return { bytes: freemem(), source: 'os' };
}

/** Space on one volume, or null when it cannot be stat'd — a path that is not there yet. */
export async function readStorage(target: StorageTarget): Promise<StorageInfo | null> {
  try {
    const stats = await statfs(target.path);
    // `bsize` is the preferred block size, which is what `blocks`/`bavail` are counted in.
    const totalBytes = stats.blocks * stats.bsize;
    // `bavail`, not `bfree`: the reserved blocks in between are root's, and this daemon is not.
    const freeBytes = stats.bavail * stats.bsize;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return {
      label: target.label,
      path: target.path,
      totalBytes,
      freeBytes,
      usedPercent: clampPercent(((totalBytes - freeBytes) / totalBytes) * 100),
    };
  } catch {
    return null;
  }
}

export type SystemInfoOptions = {
  readonly cpu: CpuUsageTracker;
  /** The volumes worth reporting. The caller names them, because only it knows what they hold. */
  readonly storage: readonly StorageTarget[];
  readonly now?: () => number;
};

/**
 * One complete reading.
 *
 * Every part is gathered concurrently and every part can fail on its own, so a laptop with no
 * thermal zone still gets memory and disk rather than an error page.
 */
export async function readSystemInfo(options: SystemInfoOptions): Promise<SystemInfo> {
  const now = options.now ?? Date.now;
  const [temperatureC, model, available, storage, audio] = await Promise.all([
    readTemperatureC(),
    readModel(),
    readAvailableMemory(),
    Promise.all(options.storage.map(readStorage)),
    readAudioInfo(),
  ]);

  const totalBytes = totalmem();
  const [one, five, fifteen] = loadavg();

  return {
    readAtMs: now(),
    uptimeSeconds: Math.round(uptime()),
    processUptimeSeconds: Math.round(process.uptime()),
    temperatureC,
    cpu: {
      usagePercent: options.cpu.read(),
      loadAverage: [one ?? 0, five ?? 0, fifteen ?? 0],
      cores: cpus().length,
    },
    memory: {
      totalBytes,
      availableBytes: available.bytes,
      usedPercent:
        totalBytes > 0 ? clampPercent(((totalBytes - available.bytes) / totalBytes) * 100) : 0,
      source: available.source,
    },
    // A volume that would not stat is dropped rather than reported as empty: "0 bytes free"
    // is a fire alarm, and a missing row is the truth.
    storage: storage.filter((entry): entry is StorageInfo => entry !== null),
    audio,
    host: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
      nodeVersion: process.version,
      model,
    },
  };
}

/** One decimal place, and never outside 0-100 whatever the arithmetic produced. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}
