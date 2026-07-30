import { EventEmitter } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  configSchema,
  type ButtonTimings,
  type ContactConfig,
  type DeviceConfig,
} from './schema.ts';

/**
 * Loads, validates and persists the device configuration.
 *
 * Two properties matter more than anything else here:
 *
 *  1. **It never throws on load.** A missing or corrupt /data/config.json falls back to
 *     config.default.json held in RAM, and the device boots into captive-portal
 *     onboarding. A crash loop on a screenless appliance is unrecoverable for the user.
 *
 *  2. **Writes are atomic.** The Pi has no power button and children pull cables. A
 *     half-written config would brick the device, so we write a temp file, fsync it,
 *     then rename over the target — rename is atomic within a filesystem.
 */

/** Where the writable config lives on the device. Overridable for tests and dev. */
export const DEFAULT_CONFIG_PATH = process.env['CONFIG_PATH'] ?? '/data/config.json';

/** Shipped fallback template, read-only, part of the source tree. */
export const DEFAULT_TEMPLATE_PATH = resolve(import.meta.dirname, '../../config.default.json');

export type ConfigSource = 'file' | 'defaults';

export type LoadResult = {
  readonly config: DeviceConfig;
  readonly source: ConfigSource;
  /** Why we fell back, when we did — surfaced in logs and the admin UI. */
  readonly fallbackReason?: string;
};

type ConfigManagerEvents = {
  change: [DeviceConfig];
};

export type ConfigManagerOptions = {
  readonly configPath?: string;
  readonly templatePath?: string;
};

export class ConfigManager extends EventEmitter<ConfigManagerEvents> {
  readonly #configPath: string;
  readonly #templatePath: string;
  #current: DeviceConfig | null = null;
  #source: ConfigSource = 'defaults';

  constructor(options: ConfigManagerOptions = {}) {
    super();
    this.#configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    this.#templatePath = options.templatePath ?? DEFAULT_TEMPLATE_PATH;
  }

  get configPath(): string {
    return this.#configPath;
  }

  /** Where the currently loaded config came from. */
  get source(): ConfigSource {
    return this.#source;
  }

  /** The active config. Throws only if called before {@link load}. */
  get current(): DeviceConfig {
    if (!this.#current) {
      throw new Error('ConfigManager.load() must be called before accessing config');
    }
    return this.#current;
  }

  /** True once onboarding has completed and contacts are usable. */
  get isConfigured(): boolean {
    return this.#current?.system.configured === true;
  }

  /**
   * Reads and validates the persisted config, falling back to the shipped template.
   * Never rejects for a missing or malformed config file — only if the template itself
   * is unreadable or invalid, which is a build defect rather than a runtime condition.
   */
  async load(): Promise<LoadResult> {
    const fromFile = await this.#tryReadValidated(this.#configPath);
    if (fromFile.ok) {
      this.#current = fromFile.config;
      this.#source = 'file';
      return { config: fromFile.config, source: 'file' };
    }

    const fromTemplate = await this.#tryReadValidated(this.#templatePath);
    if (!fromTemplate.ok) {
      // The template ships with the source; if it is broken nothing can run.
      throw new Error(
        `config.default.json is missing or invalid (${fromTemplate.reason}) — this is a packaging error`,
      );
    }

    this.#current = fromTemplate.config;
    this.#source = 'defaults';
    return {
      config: fromTemplate.config,
      source: 'defaults',
      fallbackReason: fromFile.reason,
    };
  }

  /**
   * Validates and atomically persists a full config, then emits `change`.
   * Rejects without touching disk if the config is invalid.
   */
  async save(candidate: unknown): Promise<DeviceConfig> {
    const parsed = configSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ConfigValidationError(parsed.error);
    }

    await this.#writeAtomic(this.#configPath, parsed.data);
    this.#current = parsed.data;
    this.#source = 'file';
    this.emit('change', parsed.data);
    return parsed.data;
  }

  /**
   * Deep-merges a partial update over the current config, then validates and saves.
   * Used by the admin API, where the client sends only the sections it changed.
   */
  async update(patch: ConfigPatch): Promise<DeviceConfig> {
    const merged = mergeConfig(this.current, patch);
    return this.save(merged);
  }

  /** Removes the persisted config so the next boot re-enters onboarding. */
  async factoryReset(): Promise<DeviceConfig> {
    await unlink(this.#configPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    const result = await this.load();
    this.emit('change', result.config);
    return result.config;
  }

  async #tryReadValidated(
    path: string,
  ): Promise<{ ok: true; config: DeviceConfig } | { ok: false; reason: string }> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error: unknown) {
      return {
        ok: false,
        reason: isNotFound(error) ? 'file not found' : `unreadable: ${describeError(error)}`,
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error: unknown) {
      return { ok: false, reason: `malformed JSON: ${describeError(error)}` };
    }

    const result = configSchema.safeParse(parsedJson);
    if (!result.success) {
      return { ok: false, reason: `failed validation: ${summarizeZodError(result.error)}` };
    }
    return { ok: true, config: result.data };
  }

  /**
   * Atomic write: temp file in the same directory (rename is only atomic within a
   * filesystem), fsync the contents, rename over the target.
   */
  async #writeAtomic(path: string, config: DeviceConfig): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });

    const tempPath = `${path}.tmp`;
    const payload = `${JSON.stringify(config, null, 2)}\n`;

    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      // Without this the rename can land before the data does after power loss.
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(tempPath, path);
    } catch (error: unknown) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * A partial, nested config update. Every section and field is optional.
 *
 * Each section is explicitly `| undefined` as well as optional: under
 * `exactOptionalPropertyTypes` those are different things, and Zod's `.partial()` output
 * sets absent keys to `undefined` rather than omitting them.
 */
type PatchSection<T> = { readonly [K in keyof T]?: T[K] | undefined };

export type ConfigPatch = {
  readonly [K in keyof DeviceConfig]?:
    (DeviceConfig[K] extends object ? PatchSection<DeviceConfig[K]> : DeviceConfig[K]) | undefined;
};

/** Falls back to `base` when the patch omits a field *or* sets it to undefined. */
function pick<T>(patched: T | undefined, base: T): T {
  return patched === undefined ? base : patched;
}

/**
 * Merges a patch one level into each section.
 *
 * Written out field by field rather than with object spread on purpose: spreading a patch
 * whose key is explicitly `undefined` *overwrites* the base value with undefined, which on
 * this device would silently erase a phone number or a volume cap. `pick` treats an
 * explicit undefined as "not supplied", which is what every caller means.
 */
export function mergeConfig(base: DeviceConfig, patch: ConfigPatch): DeviceConfig {
  const contact = (
    patched: PatchSection<ContactConfig> | undefined,
    current: ContactConfig,
  ): ContactConfig => ({
    name: pick(patched?.name, current.name),
    phone: pick(patched?.phone, current.phone),
    enabled: pick(patched?.enabled, current.enabled),
  });

  return {
    // Schema version is ours to set, never the client's.
    version: base.version,
    system: {
      hostname: pick(patch.system?.hostname, base.system.hostname),
      adminPasswordHash: pick(patch.system?.adminPasswordHash, base.system.adminPasswordHash),
      configured: pick(patch.system?.configured, base.system.configured),
    },
    wifi: {
      ssid: pick(patch.wifi?.ssid, base.wifi.ssid),
      password: pick(patch.wifi?.password, base.wifi.password),
    },
    contacts: {
      button1: contact(patch.contacts?.button1, base.contacts.button1),
      button2: contact(patch.contacts?.button2, base.contacts.button2),
      button3: contact(patch.contacts?.button3, base.contacts.button3),
    },
    audio: {
      speakerVolumePercent: pick(
        patch.audio?.speakerVolumePercent,
        base.audio.speakerVolumePercent,
      ),
      maxVolumeCapPercent: pick(patch.audio?.maxVolumeCapPercent, base.audio.maxVolumeCapPercent),
      micGainPercent: pick(patch.audio?.micGainPercent, base.audio.micGainPercent),
      maxRecordingSeconds: pick(patch.audio?.maxRecordingSeconds, base.audio.maxRecordingSeconds),
    },
    quietHours: {
      enabled: pick(patch.quietHours?.enabled, base.quietHours.enabled),
      startTime: pick(patch.quietHours?.startTime, base.quietHours.startTime),
      endTime: pick(patch.quietHours?.endTime, base.quietHours.endTime),
    },
    buttons: mergeButtons(patch.buttons, base.buttons),
  };
}

function mergeButtons(
  patched: PatchSection<ButtonTimings> | undefined,
  base: ButtonTimings,
): ButtonTimings {
  return {
    debounceMs: pick(patched?.debounceMs, base.debounceMs),
    recordThresholdMs: pick(patched?.recordThresholdMs, base.recordThresholdMs),
    minRecordingMs: pick(patched?.minRecordingMs, base.minRecordingMs),
    silentComboMs: pick(patched?.silentComboMs, base.silentComboMs),
  };
}

/** Thrown by {@link ConfigManager.save} when a candidate config fails validation. */
export class ConfigValidationError extends Error {
  readonly issues: readonly { path: string; message: string }[];

  constructor(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
    super(`invalid configuration: ${summarizeZodError(error)}`);
    this.name = 'ConfigValidationError';
    this.issues = error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
  }
}

function summarizeZodError(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True if the config path is writable — false on a read-only root without /data mounted. */
export async function isConfigPathWritable(path = DEFAULT_CONFIG_PATH): Promise<boolean> {
  try {
    await access(dirname(path), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
