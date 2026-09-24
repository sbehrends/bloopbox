import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  configSchema,
  DEFAULT_BUTTON_TIMINGS,
  enabledContacts,
  parseTarget,
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
  workDir = await mkdtemp(join(tmpdir(), 'bloopbox-config-'));
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
      button1: { name: 'Mom', target: '15551234567', enabled: true },
      button2: { name: 'Dad', target: '15559876543', enabled: true },
      button3: { name: 'Grandma', target: '', enabled: false },
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
    // Plausible-looking but the volume is out of range.
    const broken = { ...(await validConfig()) };
    broken.audio = { ...broken.audio, speakerVolumePercent: 140 };
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
    broken.contacts.button1 = { name: 'Mom', target: '', enabled: true };

    await expect(config.save(broken)).rejects.toMatchObject({
      name: 'ConfigValidationError',
    });
  });

  it('returns the validated config it persisted', async () => {
    const config = manager();
    await config.load();

    const saved = await config.save(await validConfig());

    // No change event: settings are applied by restarting the daemon, so nothing observes
    // a write in-process. See "Config is snapshot at boot" in CLAUDE.md.
    expect(saved.system.configured).toBe(true);
    expect(config.current).toEqual(saved);
  });
});

describe('concurrent and failed writes', () => {
  it('applies two overlapping updates in turn, so neither undoes the other', async () => {
    // Two admin tabs saving at once. Both used to merge over the same `current`, and the second
    // write silently threw away the first one's change.
    const config = manager();
    await config.load();
    await config.save(await validConfig());

    await Promise.all([
      config.update({ audio: { speakerVolumePercent: 31 } }),
      config.update({ quietHours: { enabled: true } }),
    ]);

    const reloaded = await manager().load();
    expect(reloaded.config.audio.speakerVolumePercent).toBe(31);
    expect(reloaded.config.quietHours.enabled).toBe(true);
    expect(await readdir(workDir)).toEqual(['config.json']);
  });

  it('leaves no temp file behind when the write fails, and the next save still runs', async () => {
    const config = manager();
    await config.load();
    // A directory where the file should be: every step up to the rename succeeds.
    await mkdir(configPath);
    await writeFile(join(configPath, 'occupied'), '');

    await expect(config.save(await validConfig())).rejects.toThrow(/EISDIR|ENOTEMPTY|EEXIST|EPERM/);
    expect((await readdir(workDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    await rm(configPath, { recursive: true });
    await expect(config.save(await validConfig())).resolves.toMatchObject({
      system: { configured: true },
    });
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

    /*
     * A cross-field rule the patch cannot see on its own: button3 has no target, so enabling
     * it is only invalid once merged. Checked in ConfigManager.save() against the merged
     * config, which is the only place it can be checked correctly.
     */
    await expect(config.update({ contacts: { button3: { enabled: true } } })).rejects.toThrow(
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
      contacts: { button3: { name: 'Nana', target: '15551110000', enabled: true } },
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

  it('normalises bare numbers into WhatsApp JIDs, idempotently', () => {
    expect(toJid('15551234567')).toBe('15551234567@s.whatsapp.net');
    expect(toJid('15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
    expect(toJid('')).toBe('');
  });

  it('lists only enabled contacts that actually have a target', async () => {
    const config = await validConfig();
    const active = enabledContacts(config);

    expect(active.map((c) => c.key)).toEqual(['button1', 'button2']);
    expect(active[0]).toMatchObject({ index: 0, jid: '15551234567@s.whatsapp.net' });
  });
});

describe('schema validation rules', () => {
  it('refuses an enabled contact with no target', async () => {
    const config = await validConfig();
    config.contacts.button3 = { name: 'Grandma', target: '', enabled: true };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('allows a disabled contact with no target', async () => {
    const config = await validConfig();
    config.contacts.button3 = { name: 'Grandma', target: '', enabled: false };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('refuses a volume outside 0-100', async () => {
    const config = await validConfig();
    for (const speakerVolumePercent of [-1, 101, 7.5]) {
      expect(
        configSchema.safeParse({ ...config, audio: { ...config.audio, speakerVolumePercent } })
          .success,
      ).toBe(false);
    }
  });

  it('fills in the amplifier stages for a config written before they existed', async () => {
    /*
     * Same migration hazard as the timezone field: these arrived on 2026-08-17, and an
     * installed device whose config no longer parses falls back to the defaults in RAM and
     * re-enters onboarding. They default to the measured maximum, because the WM8960 powers
     * its output PGA up 20 dB down and nothing else in the chain can compensate.
     */
    const config = await validConfig();
    const audio: Record<string, unknown> = { ...config.audio };
    for (const key of ['ampVolumePercent', 'ampBoostDc', 'ampBoostAc']) delete audio[key];

    const result = configSchema.safeParse({ ...config, audio });

    expect(result.success).toBe(true);
    expect(result.data?.audio.ampVolumePercent).toBe(100);
    expect(result.data?.audio.ampBoostDc).toBe(5);
    expect(result.data?.audio.ampBoostAc).toBe(5);
    expect(result.data?.contacts.button1.name).toBe('Mom');
  });

  it('keeps the stored amplifier stages when a patch touches only the digital volume', async () => {
    // The `.partial()` + `.default()` trap: a patch that omits these must not reset them.
    const config = manager();
    await config.load();
    await config.update({ audio: { ampVolumePercent: 60, ampBoostDc: 2, ampBoostAc: 2 } });

    await config.update({ audio: { speakerVolumePercent: 55 } });

    expect(config.current.audio.ampVolumePercent).toBe(60);
    expect(config.current.audio.ampBoostDc).toBe(2);
    expect(config.current.audio.ampBoostAc).toBe(2);
  });

  it('refuses an amplifier boost outside 0-5', async () => {
    const config = await validConfig();
    for (const ampBoostDc of [-1, 6]) {
      expect(
        configSchema.safeParse({ ...config, audio: { ...config.audio, ampBoostDc } }).success,
      ).toBe(false);
    }
  });

  it('drops maxVolumeCapPercent from a config written before it was removed', async () => {
    /*
     * The cap was deleted on 2026-08-17. Zod strips unknown keys rather than rejecting them,
     * which is what makes this a non-event for an installed device: the stale key is ignored on
     * load and gone after the next save. A `.strict()` object here would have bricked every box
     * in the field into onboarding.
     */
    const config = await validConfig();

    const result = configSchema.safeParse({
      ...config,
      audio: { ...config.audio, maxVolumeCapPercent: 85 },
    });

    expect(result.success).toBe(true);
    expect(result.data?.audio).not.toHaveProperty('maxVolumeCapPercent');
    expect(result.data?.audio.speakerVolumePercent).toBe(config.audio.speakerVolumePercent);
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

describe('read receipts', () => {
  it('sends them unless a parent says otherwise', async () => {
    // The sender has no other way to learn a child heard them, so the default is on.
    const config = await validConfig();
    expect(config.whatsapp.markPlayedAsRead).toBe(true);
  });

  it('fills the section in for a config written before it existed', async () => {
    const legacy: Record<string, unknown> = { ...(await validConfig()) };
    delete legacy['whatsapp'];

    const result = configSchema.safeParse(legacy);

    expect(result.success).toBe(true);
    expect(result.data?.whatsapp.markPlayedAsRead).toBe(true);
    // The parent's own settings must survive the migration, not reset to defaults.
    expect(result.data?.contacts.button1.name).toBe('Mom');
  });

  it('takes the setting off', async () => {
    const config = { ...(await validConfig()), whatsapp: { markPlayedAsRead: false } };

    const result = configSchema.safeParse(config);

    expect(result.success).toBe(true);
    expect(result.data?.whatsapp.markPlayedAsRead).toBe(false);
  });
});

describe('read-only mode', () => {
  it('ships two-way', async () => {
    // The flag exists to be turned on deliberately; a box that arrives unable to send would
    // look broken to the parent who just wired up three contacts.
    const config = await validConfig();
    expect(config.mode.readOnly).toBe(false);
  });

  it('fills the section in for a config written before it existed', async () => {
    const legacy: Record<string, unknown> = { ...(await validConfig()) };
    delete legacy['mode'];

    const result = configSchema.safeParse(legacy);

    expect(result.success).toBe(true);
    expect(result.data?.mode.readOnly).toBe(false);
    // The parent's own settings must survive the migration, not reset to defaults.
    expect(result.data?.contacts.button1.name).toBe('Mom');
  });

  /*
   * The `mergeConfig` half of the four places a section has to be wired. Asserted on the
   * *stored* value rather than on the API's answer, because the failure this catches is a
   * save that validates, replies 200, restarts the daemon and silently discards the change —
   * exactly how `whatsapp.markPlayedAsRead` shipped broken.
   */
  it('survives a partial save, and leaves the rest of the config alone', async () => {
    const config = manager();
    await config.load();
    await config.save(await validConfig());

    await config.update({ mode: { readOnly: true } });

    expect(config.current.mode.readOnly).toBe(true);
    expect(config.current.contacts.button1.name).toBe('Mom');

    const stored = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
    expect(stored.mode.readOnly).toBe(true);
  });

  it('can be turned back off', async () => {
    const config = manager();
    await config.load();
    await config.save({ ...(await validConfig()), mode: { readOnly: true } });

    await config.update({ mode: { readOnly: false } });

    expect(config.current.mode.readOnly).toBe(false);
  });
});

describe('quiet-hours timezone', () => {
  it('fills the field in for a config written before it existed', async () => {
    const legacy = await validConfig();
    const quietHours: Record<string, unknown> = { ...legacy.quietHours };
    delete quietHours['timezone'];

    const result = configSchema.safeParse({ ...legacy, quietHours });

    /*
     * The failure this guards against is not a rejected save — it is a *boot*. An installed
     * device whose config no longer parses falls back to the defaults in RAM and re-enters
     * onboarding, so a required field added here would cost a parent their contacts on the
     * next update. It has to default.
     */
    expect(result.success).toBe(true);
    expect(result.data?.quietHours.timezone).toBe('UTC');
    expect(result.data?.contacts.button1.name).toBe('Mom');
  });

  it('rejects a zone name ICU does not know', async () => {
    const config = await validConfig();

    const result = configSchema.safeParse({
      ...config,
      quietHours: { ...config.quietHours, timezone: 'Europe/Atlantis' },
    });

    expect(result.success).toBe(false);
  });

  it('keeps the stored zone when a patch touches only the times', async () => {
    /*
     * Asserted on the merged config rather than on the response, because that is where the
     * equivalent bug hid last time: `.partial()` on a field carrying a `.default()` would
     * quietly reinstate "UTC" on every save that did not name a zone, and the save would
     * still answer 200.
     */
    const config = manager();
    await config.load();
    await config.update({ quietHours: { enabled: true, timezone: 'Europe/Berlin' } });

    await config.update({ quietHours: { startTime: '21:30' } });

    expect(config.current.quietHours.timezone).toBe('Europe/Berlin');
    expect(config.current.quietHours.startTime).toBe('21:30');
  });
});

describe('button timings', () => {
  it('ships the tuned defaults in config.default.json', async () => {
    const config = await validConfig();
    expect(config.buttons).toEqual(DEFAULT_BUTTON_TIMINGS);
  });

  it('fills the section in for a config written before it existed', async () => {
    // The migration case: a real config.json from an earlier build has no `buttons` key.
    const legacy: Record<string, unknown> = { ...(await validConfig()) };
    delete legacy['buttons'];

    const result = configSchema.safeParse(legacy);

    expect(result.success).toBe(true);
    expect(result.data?.buttons).toEqual(DEFAULT_BUTTON_TIMINGS);
    // Crucially, the parent's own settings survive rather than resetting to defaults.
    expect(result.data?.contacts.button1.name).toBe('Mom');
  });

  it('fills in individual missing fields', async () => {
    const partial: Record<string, unknown> = {
      ...(await validConfig()),
      buttons: { debounceMs: 90 },
    };

    const result = configSchema.safeParse(partial);

    expect(result.success).toBe(true);
    expect(result.data?.buttons.debounceMs).toBe(90);
    expect(result.data?.buttons.recordThresholdMs).toBe(DEFAULT_BUTTON_TIMINGS.recordThresholdMs);
  });

  it('refuses timings that would leave no tap window', async () => {
    const config = await validConfig();
    // Debounce past the record threshold means a tap can never be observed, so
    // playing a received message would become impossible.
    config.buttons = { ...config.buttons, debounceMs: 800, recordThresholdMs: 400 };

    const result = configSchema.safeParse(config);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/tapping to play is unreachable/);
  });

  it('refuses out-of-range timings', async () => {
    const config = await validConfig();
    for (const bad of [
      { debounceMs: -1 },
      { recordThresholdMs: 50 },
      { silentComboMs: 100 },
      { minRecordingMs: 999_999 },
    ]) {
      const candidate = { ...config, buttons: { ...config.buttons, ...bad } };
      expect(configSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('persists a retuned set through an atomic write', async () => {
    const manager2 = manager();
    await manager2.load();
    await manager2.save(await validConfig());

    await manager2.update({ buttons: { debounceMs: 80, recordThresholdMs: 350 } });

    const reloaded = await manager().load();
    expect(reloaded.config.buttons.debounceMs).toBe(80);
    expect(reloaded.config.buttons.recordThresholdMs).toBe(350);
    // Untouched fields keep their values.
    expect(reloaded.config.buttons.silentComboMs).toBe(DEFAULT_BUTTON_TIMINGS.silentComboMs);
  });
});

describe('targets — a button points at a person or a group', () => {
  it('normalises a bare phone number into a user JID', () => {
    expect(parseTarget('15551234567')).toEqual({
      kind: 'individual',
      jid: '15551234567@s.whatsapp.net',
    });
  });

  it('accepts a full user JID unchanged', () => {
    expect(parseTarget('15551234567@s.whatsapp.net')).toEqual({
      kind: 'individual',
      jid: '15551234567@s.whatsapp.net',
    });
  });

  it('recognises a group JID', () => {
    expect(parseTarget('15551234567-1699999999@g.us')).toEqual({
      kind: 'group',
      jid: '15551234567-1699999999@g.us',
    });
  });

  it('tolerates surrounding whitespace, which is easy to paste in', () => {
    expect(parseTarget('  15551234567  ')?.jid).toBe('15551234567@s.whatsapp.net');
  });

  it('strips the two spellings of "dial internationally"', () => {
    // The case that prompted this: 00 + country code is 15 digits, so the old digits-only
    // pattern accepted it whole and built 005491155555555@s.whatsapp.net — a JID that
    // validates, saves, and silently reaches nobody.
    expect(parseTarget('005491155555555')?.jid).toBe('5491155555555@s.whatsapp.net');
    expect(parseTarget('+5491155555555')?.jid).toBe('5491155555555@s.whatsapp.net');
  });

  it('accepts a number written the way a contacts app shows it', () => {
    for (const written of [
      '+54 9 11 5555-5555',
      '0054 9 11 5555 5555',
      '(0054) 9.11.5555.5555',
      '+54–9–11–5555–5555', // en dashes, which is what a phone keyboard often inserts
    ]) {
      expect(parseTarget(written)?.jid).toBe('5491155555555@s.whatsapp.net');
    }
  });

  it('rejects a national number rather than guessing its country', () => {
    // A leading 0 that survives is a *trunk* prefix, so the country code is missing. Guessing
    // one would point the button at a stranger, which is worse than refusing the save.
    expect(parseTarget('01155555555')).toBeNull();
    expect(parseTarget('0 11 5555 5555')).toBeNull();
  });

  it('rejects anything that is neither', () => {
    for (const bad of ['', '  ', '123', 'not-a-number', 'name@example.com', '+', '00']) {
      expect(parseTarget(bad)).toBeNull();
    }
  });

  it('is idempotent through toJid', () => {
    const jid = toJid('15551234567');
    expect(toJid(jid)).toBe(jid);
    expect(toJid('15551234567-1699999999@g.us')).toBe('15551234567-1699999999@g.us');
    expect(toJid('rubbish')).toBe('');
  });
});

describe('group targets in config', () => {
  it('accepts a group as an enabled contact', async () => {
    const config = await validConfig();
    config.contacts.button3 = {
      name: 'Family',
      target: '15551234567-1699999999@g.us',
      enabled: true,
    };

    const result = configSchema.safeParse(config);

    expect(result.success).toBe(true);
  });

  it('reports the kind so the bridge can log which it used', async () => {
    const config = await validConfig();
    config.contacts.button3 = {
      name: 'Family',
      target: '15551234567-1699999999@g.us',
      enabled: true,
    };

    const active = enabledContacts(configSchema.parse(config));

    expect(active.map((c) => c.kind)).toEqual(['individual', 'individual', 'group']);
  });

  it('refuses a malformed target', async () => {
    const config = await validConfig();
    config.contacts.button1 = { name: 'Mom', target: 'not-a-target', enabled: true };

    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('excludes a contact whose target is unusable, rather than sending nowhere', async () => {
    const config = configSchema.parse(await validConfig());
    // Bypassing validation the way a hand-edited file could: enabled but with no target.
    const tampered = { ...config, contacts: { ...config.contacts } };
    tampered.contacts.button1 = { name: 'Mom', target: '', enabled: true };

    // button1 is dropped despite being enabled; button3 was already disabled in the fixture.
    expect(enabledContacts(tampered).map((c) => c.key)).toEqual(['button2']);
  });
});

describe('legacy `phone` field migration', () => {
  it('reads a config written before groups existed', async () => {
    const legacy = {
      ...(await validConfig()),
      contacts: {
        button1: { name: 'Mom', phone: '15551234567', enabled: true },
        button2: { name: 'Dad', phone: '15559876543', enabled: true },
        button3: { name: 'Grandma', phone: '', enabled: false },
      },
    };

    const result = configSchema.safeParse(legacy);

    expect(result.success).toBe(true);
    expect(result.data?.contacts.button1.target).toBe('15551234567');
    // The parent's contacts must survive the rename, not reset to defaults.
    expect(result.data?.contacts.button2.target).toBe('15559876543');
  });

  it('prefers target when both are somehow present', async () => {
    const mixed = {
      ...(await validConfig()),
      contacts: {
        button1: { name: 'Mom', target: '15551110000', phone: '15559990000', enabled: true },
        button2: { name: 'Dad', target: '', enabled: false },
        button3: { name: 'Grandma', target: '', enabled: false },
      },
    };

    const result = configSchema.safeParse(mixed);

    expect(result.data?.contacts.button1.target).toBe('15551110000');
  });

  it('still enforces the invariant on a migrated contact', async () => {
    const legacy = {
      ...(await validConfig()),
      contacts: {
        button1: { name: 'Mom', phone: '', enabled: true },
        button2: { name: 'Dad', phone: '', enabled: false },
        button3: { name: 'Grandma', phone: '', enabled: false },
      },
    };

    expect(configSchema.safeParse(legacy).success).toBe(false);
  });
});
