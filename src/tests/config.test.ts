import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ConfigManager,
  ConfigValidationError,
  DEFAULT_TEMPLATE_PATH,
  mergeConfig,
} from '../config/configManager.ts';
import {
  buttonIndexToKey,
  buttonKeyToIndex,
  clampVolume,
  configSchema,
  enabledContacts,
  toJid,
  type DeviceConfig,
} from '../config/schema.ts';

/**
 * Config loading, validation and atomic persistence (PRODUCT.md §3).
 *
 * The device has no screen, so a config error cannot be explained to the user — these
 * tests pin the two behaviours that keep it recoverable: never crash on a bad file, and
 * never leave a partially written one.
 */

let workDir: string;
let configPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kids-messenger-config-'));
  configPath = join(workDir, 'config.json');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function manager(): ConfigManager {
  return new ConfigManager({ configPath, templatePath: DEFAULT_TEMPLATE_PATH });
}

/** A complete, valid config for write tests. */
async function validConfig(): Promise<DeviceConfig> {
  const template = configSchema.parse(
    JSON.parse(await readFile(DEFAULT_TEMPLATE_PATH, 'utf8')) as unknown,
  );
  return {
    ...template,
    system: { ...template.system, configured: true, adminPasswordHash: '$2b$10$abcdefg' },
    contacts: {
      button1: { name: 'Mom', phone: '15551234567', enabled: true },
      button2: { name: 'Dad', phone: '15559876543', enabled: true },
      button3: { name: 'Grandma', phone: '', enabled: false },
    },
  };
}

describe('loading', () => {
  it('falls back to the shipped defaults when no config exists', async () => {
    const config = manager();
    const result = await config.load();

    expect(result.source).toBe('defaults');
    expect(result.fallbackReason).toContain('not found');
    expect(result.config.system.configured).toBe(false);
    expect(config.isConfigured).toBe(false);
  });

  it('falls back rather than throwing when the file is corrupt JSON', async () => {
    await writeFile(configPath, '{ this is not: json', 'utf8');

    const result = await manager().load();

    expect(result.source).toBe('defaults');
    expect(result.fallbackReason).toContain('malformed JSON');
  });

  it('falls back rather than throwing when the file is valid JSON but invalid config', async () => {
    // Plausible-looking but the volume exceeds its own cap.
    const broken = { ...(await validConfig()) };
    broken.audio = { ...broken.audio, speakerVolumePercent: 100, maxVolumeCapPercent: 60 };
    await writeFile(configPath, JSON.stringify(broken), 'utf8');

    const result = await manager().load();

    expect(result.source).toBe('defaults');
    expect(result.fallbackReason).toContain('failed validation');
  });

  it('loads a valid persisted config in preference to the defaults', async () => {
    await writeFile(configPath, JSON.stringify(await validConfig()), 'utf8');

    const config = manager();
    const result = await config.load();

    expect(result.source).toBe('file');
    expect(result.fallbackReason).toBeUndefined();
    expect(result.config.contacts.button1.name).toBe('Mom');
    expect(config.isConfigured).toBe(true);
  });

  it('throws when the current config is read before load()', () => {
    expect(() => manager().current).toThrow(/load\(\)/);
  });
});

describe('atomic writes', () => {
  it('persists a valid config and reloads it identically', async () => {
    const config = manager();
    await config.load();

    const desired = await validConfig();
    await config.save(desired);

    const reloaded = await manager().load();
    expect(reloaded.source).toBe('file');
    expect(reloaded.config).toEqual(desired);
  });

  it('leaves no temp file behind after a successful write', async () => {
    const config = manager();
    await config.load();
    await config.save(await validConfig());

    const entries = await readdir(workDir);
    expect(entries).toEqual(['config.json']);
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('writes formatted JSON so a parent can inspect it over SSH', async () => {
    const config = manager();
    await config.load();
    await config.save(await validConfig());

    const raw = await readFile(configPath, 'utf8');
    expect(raw).toContain('\n  "version": 1');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('creates the parent directory when /data is empty', async () => {
    const nested = resolve(workDir, 'data', 'nested', 'config.json');
    const config = new ConfigManager({
      configPath: nested,
      templatePath: DEFAULT_TEMPLATE_PATH,
    });
    await config.load();
    await config.save(await validConfig());

    await expect(readFile(nested, 'utf8')).resolves.toContain('"version": 1');
  });

  it('rejects an invalid config without touching the existing file', async () => {
    const config = manager();
    await config.load();
    const good = await validConfig();
    await config.save(good);

    await expect(config.save({ version: 1, nonsense: true })).rejects.toThrow(
      ConfigValidationError,
    );

    // The previously good file must survive untouched.
    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
    expect(onDisk).toEqual(good);
  });

  it('reports which fields failed validation', async () => {
    const config = manager();
    await config.load();

    const broken = await validConfig();
    broken.contacts.button1 = { name: 'Mom', phone: '', enabled: true };

    await expect(config.save(broken)).rejects.toMatchObject({
      name: 'ConfigValidationError',
    });
  });

  it('emits change so both daemons can reload without a restart', async () => {
    const config = manager();
    await config.load();

    const seen: DeviceConfig[] = [];
    config.on('change', (next) => seen.push(next));

    await config.save(await validConfig());

    expect(seen).toHaveLength(1);
    expect(seen[0]?.system.configured).toBe(true);
  });
});

describe('partial updates from the admin API', () => {
  it('merges a single section and keeps the rest', async () => {
    const config = manager();
    await config.load();
    await config.save(await validConfig());

    await config.update({ audio: { speakerVolumePercent: 40 } });

    expect(config.current.audio.speakerVolumePercent).toBe(40);
    expect(config.current.contacts.button1.name).toBe('Mom');
  });

  it('rejects an update that would break an invariant', async () => {
    const config = manager();
    await config.load();
    await config.save(await validConfig());

    // Above the configured cap of 85.
    await expect(config.update({ audio: { speakerVolumePercent: 99 } })).rejects.toThrow(
      ConfigValidationError,
    );
  });
});

describe('factory reset', () => {
  it('removes the persisted config and returns to defaults', async () => {
    const config = manager();
    await config.load();
    await config.save(await validConfig());

    const after = await config.factoryReset();

    expect(after.system.configured).toBe(false);
    expect(config.source).toBe('defaults');
    await expect(readFile(configPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('is safe to call when no config was ever written', async () => {
    const config = manager();
    await config.load();
    await expect(config.factoryReset()).resolves.toMatchObject({
      system: { configured: false },
    });
  });
});

describe('mergeConfig', () => {
  it('merges section-wise without dropping sibling fields', async () => {
    const base = await validConfig();
    const merged = mergeConfig(base, { quietHours: { enabled: false } });

    expect(merged.quietHours.enabled).toBe(false);
    expect(merged.quietHours.startTime).toBe(base.quietHours.startTime);
    expect(merged.contacts).toEqual(base.contacts);
  });

  it('merges an individual contact without disturbing the others', async () => {
    const base = await validConfig();
    const merged = mergeConfig(base, {
      contacts: { button3: { name: 'Nana', phone: '15551110000', enabled: true } },
    });

    expect(merged.contacts.button3.name).toBe('Nana');
    expect(merged.contacts.button1).toEqual(base.contacts.button1);
  });
});

describe('schema helpers', () => {
  it('maps button keys to zero-based indices both ways', () => {
    expect(buttonKeyToIndex('button1')).toBe(0);
    expect(buttonKeyToIndex('button3')).toBe(2);
    expect(buttonIndexToKey(0)).toBe('button1');
    expect(buttonIndexToKey(2)).toBe('button3');
  });

  it('clamps volume to the configured cap', async () => {
    const { audio } = await validConfig(); // cap 85
    expect(clampVolume(50, audio)).toBe(50);
    expect(clampVolume(95, audio)).toBe(85);
    expect(clampVolume(-10, audio)).toBe(0);
    expect(clampVolume(1000, audio)).toBe(85);
  });

  it('normalises bare numbers into WhatsApp JIDs, idempotently', () => {
    expect(toJid('15551234567')).toBe('15551234567@s.whatsapp.net');
    expect(toJid('15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
    expect(toJid('')).toBe('');
  });

  it('lists only enabled contacts that actually have a number', async () => {
    const config = await validConfig();
    const active = enabledContacts(config);

    expect(active.map((c) => c.key)).toEqual(['button1', 'button2']);
    expect(active[0]).toMatchObject({ index: 0, jid: '15551234567@s.whatsapp.net' });
  });
});

describe('schema validation rules', () => {
  it('refuses an enabled contact with no phone number', async () => {
    const config = await validConfig();
    config.contacts.button3 = { name: 'Grandma', phone: '', enabled: true };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('allows a disabled contact with no phone number', async () => {
    const config = await validConfig();
    config.contacts.button3 = { name: 'Grandma', phone: '', enabled: false };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('refuses a volume above its own cap', async () => {
    const config = await validConfig();
    config.audio = { ...config.audio, speakerVolumePercent: 90, maxVolumeCapPercent: 80 };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('refuses malformed quiet-hours times', async () => {
    const config = await validConfig();
    config.quietHours = { ...config.quietHours, startTime: '25:00' };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('refuses a recording cap that could exhaust the RAM disk', async () => {
    const config = await validConfig();
    config.audio = { ...config.audio, maxRecordingSeconds: 3600 };
    expect(configSchema.safeParse(config).success).toBe(false);
  });
});
