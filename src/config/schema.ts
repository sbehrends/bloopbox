import * as z from 'zod';

/**
 * The device configuration schema (PRODUCT.md §3) and the single source of truth for
 * its TypeScript types — never hand-write a parallel interface, add the field here.
 *
 * This schema guards both directions:
 *   - reading  /data/config.json at boot (corrupt file -> fall back to defaults)
 *   - writing  from the captive portal / admin API (bad input -> rejected, not persisted)
 *
 * A toddler's only interface to this device is three buttons, so a bad config cannot be
 * diagnosed or corrected by the user. Validation is the safety net.
 */

/** Buttons are fixed at three, positioned left / centre / right. */
export const BUTTON_KEYS = ['button1', 'button2', 'button3'] as const;
export type ButtonKey = (typeof BUTTON_KEYS)[number];

/** Zero-based LED/button index used by the HAL. */
export type ButtonIndex = 0 | 1 | 2;

/** Explicit map rather than `indexOf`, so the types line up without a cast. */
const BUTTON_KEY_TO_INDEX: Readonly<Record<ButtonKey, ButtonIndex>> = {
  button1: 0,
  button2: 1,
  button3: 2,
};

export function buttonKeyToIndex(key: ButtonKey): ButtonIndex {
  return BUTTON_KEY_TO_INDEX[key];
}

export function buttonIndexToKey(index: ButtonIndex): ButtonKey {
  // BUTTON_KEYS is a fixed 3-tuple and ButtonIndex is 0 | 1 | 2, so this is total.
  return BUTTON_KEYS[index];
}

/** "HH:MM" on a 24-hour clock. */
const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a 24-hour time like "20:00"');

/**
 * A WhatsApp JID (`15551234567@s.whatsapp.net`) or the bare digits the admin UI collects.
 * Empty string means "not yet assigned" — valid only while the button is disabled.
 */
const phoneSchema = z
  .string()
  .regex(
    /^$|^\d{7,15}(@s\.whatsapp\.net)?$/,
    'must be 7-15 digits, optionally suffixed with @s.whatsapp.net',
  );

const contactSchema = z
  .object({
    name: z.string().min(1).max(24),
    phone: phoneSchema,
    enabled: z.boolean(),
  })
  .refine((contact) => !contact.enabled || contact.phone.length > 0, {
    error: 'an enabled contact must have a phone number',
    path: ['phone'],
  });

const systemSchema = z.object({
  hostname: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i, 'must be a valid hostname label'),
  /** bcrypt hash, or "" before onboarding sets one. */
  adminPasswordHash: z.string(),
  configured: z.boolean(),
});

const wifiSchema = z.object({
  /** Empty until onboarding; 32 bytes is the 802.11 maximum. */
  ssid: z.string().max(32),
  /** WPA2 passphrases are 8-63 characters; "" means open or not yet set. */
  password: z.string().max(63),
});

const audioSchema = z
  .object({
    speakerVolumePercent: z.number().int().min(0).max(100),
    /** Hard ceiling on playback — this sits near a small child's ears. */
    maxVolumeCapPercent: z.number().int().min(0).max(100),
    micGainPercent: z.number().int().min(0).max(100),
    /** Bounds a stuck button so it cannot fill the RAM disk. */
    maxRecordingSeconds: z.number().int().min(1).max(120),
  })
  .refine((audio) => audio.speakerVolumePercent <= audio.maxVolumeCapPercent, {
    error: 'speakerVolumePercent must not exceed maxVolumeCapPercent',
    path: ['speakerVolumePercent'],
  });

const quietHoursSchema = z.object({
  enabled: z.boolean(),
  /** May wrap past midnight (20:00 -> 07:00); see src/core/quietHours.ts. */
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
});

/**
 * Button press timings (PRODUCT.md §1, §5).
 *
 * Configurable because the right values are a feel judgement that depends on the child and
 * the switches, and finding them by editing source and rebuilding is far too slow. These are
 * the defaults; the admin panel can adjust them live.
 *
 * `prefault({})` rather than `default({})` on the section below is deliberate — Zod's
 * `.default()` substitutes the literal value *without* parsing it, so `{}` would come back
 * empty and leave every timing undefined. `prefault` runs it through the schema, so the
 * field defaults here are the single source of truth and an existing config.json written
 * before this section existed still loads.
 */
const buttonTimingsSchema = z
  .object({
    /** Presses shorter than this are contact bounce or an accidental brush. */
    debounceMs: z.number().int().min(0).max(2000).default(150),
    /** At or beyond this, a press is a recording rather than a tap. */
    recordThresholdMs: z.number().int().min(100).max(10_000).default(500),
    /**
     * A committed recording carrying less *actual audio* than this is discarded. Distinct
     * from the threshold above: a slow microphone start can leave a long hold nearly empty.
     */
    minRecordingMs: z.number().int().min(0).max(10_000).default(500),
    /** How long Button 1 + Button 3 must be held together to toggle silent mode. */
    silentComboMs: z.number().int().min(500).max(15_000).default(3000),
  })
  .prefault({})
  .refine((timings) => timings.debounceMs < timings.recordThresholdMs, {
    // Without a gap between them there is no tap, so playing a message becomes impossible.
    error: 'debounceMs must be less than recordThresholdMs, or tapping to play is unreachable',
    path: ['debounceMs'],
  });

export const configSchema = z.object({
  version: z.literal(1),
  system: systemSchema,
  wifi: wifiSchema,
  contacts: z.object({
    button1: contactSchema,
    button2: contactSchema,
    button3: contactSchema,
  }),
  audio: audioSchema,
  quietHours: quietHoursSchema,
  buttons: buttonTimingsSchema,
});

export type DeviceConfig = z.infer<typeof configSchema>;
export type ContactConfig = z.infer<typeof contactSchema>;
export type AudioConfig = z.infer<typeof audioSchema>;
export type QuietHoursConfig = z.infer<typeof quietHoursSchema>;
export type ButtonTimings = z.infer<typeof buttonTimingsSchema>;

/** The shipped timings, derived from the schema so they cannot drift out of step. */
export const DEFAULT_BUTTON_TIMINGS: ButtonTimings = buttonTimingsSchema.parse(undefined);

/**
 * What the admin API accepts: any subset of the mutable sections. `version` and
 * `system.adminPasswordHash` are deliberately absent — they are not client-editable.
 */
export const configUpdateSchema = z
  .object({
    system: systemSchema.pick({ hostname: true }).partial(),
    wifi: wifiSchema.partial(),
    contacts: z
      .object({
        button1: contactSchema,
        button2: contactSchema,
        button3: contactSchema,
      })
      .partial(),
    audio: audioSchema,
    quietHours: quietHoursSchema,
    buttons: buttonTimingsSchema,
  })
  .partial();

export type ConfigUpdate = z.infer<typeof configUpdateSchema>;

/** Clamps a requested volume to the configured safety cap. */
export function clampVolume(requestedPercent: number, audio: AudioConfig): number {
  const bounded = Math.round(Math.min(Math.max(requestedPercent, 0), 100));
  return Math.min(bounded, audio.maxVolumeCapPercent);
}

/** Normalises a bare phone number into the JID form Baileys expects. */
export function toJid(phone: string): string {
  if (phone.length === 0) return '';
  return phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
}

/** The contacts that may send to and receive from this device. */
export function enabledContacts(
  config: DeviceConfig,
): { key: ButtonKey; index: ButtonIndex; contact: ContactConfig; jid: string }[] {
  return BUTTON_KEYS.flatMap((key) => {
    const contact = config.contacts[key];
    if (!contact.enabled || contact.phone.length === 0) return [];
    return [{ key, index: buttonKeyToIndex(key), contact, jid: toJid(contact.phone) }];
  });
}
