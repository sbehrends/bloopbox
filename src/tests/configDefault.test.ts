import { describe, expect, it } from 'vitest';
import defaultConfig from '../../config.default.json' with { type: 'json' };

/**
 * `config.default.json` is the in-RAM fallback when /data/config.json is missing or
 * corrupt (spec §3). If it is malformed the device cannot boot into onboarding.
 *
 * Importing it (rather than reading + JSON.parse) means a syntax error fails the
 * typecheck, and every field below is statically typed from the file's own literal —
 * no casts, no runtime shape guessing. Phase 2a replaces this with full Zod validation.
 */
describe('config.default.json', () => {
  it('declares schema version 1', () => {
    expect(defaultConfig.version).toBe(1);
  });

  it('starts unconfigured so first boot enters the captive portal', () => {
    expect(defaultConfig.system.configured).toBe(false);
    expect(defaultConfig.system.adminPasswordHash).toBe('');
  });

  it('defines all three buttons, disabled and unassigned', () => {
    const { button1, button2, button3 } = defaultConfig.contacts;

    for (const contact of [button1, button2, button3]) {
      expect(contact.enabled).toBe(false);
      expect(contact.target).toBe('');
      expect(contact.name).not.toBe('');
    }
  });

  it('keeps the default volume within the safety cap', () => {
    const { speakerVolumePercent, maxVolumeCapPercent, micGainPercent } = defaultConfig.audio;

    // A toddler holds this near their ear — the cap must never be exceeded by default.
    expect(speakerVolumePercent).toBeLessThanOrEqual(maxVolumeCapPercent);
    expect(maxVolumeCapPercent).toBeLessThanOrEqual(100);
    expect(micGainPercent).toBeGreaterThan(0);
  });

  it('bounds recording length so a stuck button cannot fill the RAM disk', () => {
    expect(defaultConfig.audio.maxRecordingSeconds).toBeGreaterThan(0);
    expect(defaultConfig.audio.maxRecordingSeconds).toBeLessThanOrEqual(120);
  });

  it('ships quiet hours enabled with a midnight-wrapping window', () => {
    const { enabled, startTime, endTime } = defaultConfig.quietHours;

    expect(enabled).toBe(true);
    expect(startTime).toMatch(/^\d{2}:\d{2}$/);
    expect(endTime).toMatch(/^\d{2}:\d{2}$/);
    // 20:00 -> 07:00 crosses midnight; quietHours.ts must handle start > end.
    expect(startTime > endTime).toBe(true);
  });
});
