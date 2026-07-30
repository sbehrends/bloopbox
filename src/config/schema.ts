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
});

export type DeviceConfig = z.infer<typeof configSchema>;
export type ContactConfig = z.infer<typeof contactSchema>;
export type AudioConfig = z.infer<typeof audioSchema>;
export type QuietHoursConfig = z.infer<typeof quietHoursSchema>;

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
