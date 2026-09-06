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

  it('ships a single in-range speaker volume and a usable mic gain', () => {
    const { speakerVolumePercent, micGainPercent } = defaultConfig.audio;

    expect(speakerVolumePercent).toBeGreaterThan(0);
    expect(speakerVolumePercent).toBeLessThanOrEqual(100);
    expect(micGainPercent).toBeGreaterThan(0);
  });

  it('ships able to send', () => {
    // Read-only is opt-in: a fresh box does both halves until a parent says otherwise.
    expect(defaultConfig.mode.readOnly).toBe(false);
  });

  it('bounds recording length so a stuck button cannot fill the RAM disk', () => {
    expect(defaultConfig.audio.maxRecordingSeconds).toBeGreaterThan(0);
    expect(defaultConfig.audio.maxRecordingSeconds).toBeLessThanOrEqual(120);
  });

  it('ships quiet hours OFF, with a midnight-wrapping window ready to switch on', () => {
    const { enabled, startTime, endTime, timezone } = defaultConfig.quietHours;

    /*
     * Off on purpose. The window is meaningless until somebody says which zone it is in, and
     * the only zone we can honestly default to is UTC — so shipping it on means a box that
     * goes quiet at 20:00 Greenwich wherever it actually lives. (The device clock is no help:
     * Raspberry Pi OS defaults to Europe/London.) Silent-when-it-should-chime on a screenless
     * device is indistinguishable from broken.
     */
    expect(enabled).toBe(false);
    expect(timezone).toBe('UTC');
    expect(startTime).toMatch(/^\d{2}:\d{2}$/);
    expect(endTime).toMatch(/^\d{2}:\d{2}$/);
    // 20:00 -> 07:00 crosses midnight; quietHours.ts must handle start > end.
    expect(startTime > endTime).toBe(true);
  });
});
