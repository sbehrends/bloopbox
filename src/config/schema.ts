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
 * What a button is wired to. Either one person or one group.
 *
 * A group is as valid a destination as a person — "the family chat" on Button 2 is a natural
 * thing to want — and WhatsApp addresses both with a JID, so the pipeline needs no special
 * case beyond recognising which is which.
 */
export const TARGET_KINDS = ['individual', 'group'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** Bare digits (what a parent types) or a full user JID. */
const INDIVIDUAL_PATTERN = /^\d{7,15}(@s\.whatsapp\.net)?$/;
/**
 * Group JIDs are `<id>@g.us`, where the id is usually `<creator>-<timestamp>` but is opaque.
 * Nobody types one from memory, so the admin panel offers a picker fed by the bridge.
 */
const GROUP_PATTERN = /^[\w.-]{5,}@g\.us$/;

export type ParsedTarget = { readonly kind: TargetKind; readonly jid: string };

/** Normalises a configured target into a JID, or null if it is unusable. */
export function parseTarget(raw: string): ParsedTarget | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (GROUP_PATTERN.test(value)) return { kind: 'group', jid: value };
  if (INDIVIDUAL_PATTERN.test(value)) {
    return {
      kind: 'individual',
      jid: value.includes('@') ? value : `${value}@s.whatsapp.net`,
    };
  }
  return null;
}

const targetSchema = z
  .string()
  .max(128)
  .refine((value) => value.length === 0 || parseTarget(value) !== null, {
    error: 'must be a phone number (7-15 digits) or a group id ending in @g.us',
  });

/**
 * Reads the legacy `phone` field as `target`.
 *
 * `target` replaced `phone` when groups became valid destinations. Devices already have a
 * config.json using the old name, and dropping it would fail validation and silently reset
 * the parent's contacts. Rewritten on the next save, so this is a one-way ramp.
 */
function migrateContact(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  // `in` narrows `value` here, so `phone` is readable without a cast.
  if ('target' in value || !('phone' in value)) return value;
  const { phone, ...rest } = value;
  return { ...rest, target: phone };
}

/*
 * Every section with a cross-field rule is written as a plain object *shape* first, then
 * refined. `configUpdateSchema` needs `.partial()`, which only a ZodObject has — a `.refine()`
 * returns something else. The refinements are not lost by patching: `ConfigManager.update()`
 * merges the patch field-by-field and then validates the **merged** config against
 * `configSchema` below, so a partial patch that would break one is still rejected. Checking a
 * patch in isolation could not do that anyway: a new volume has to be compared against the
 * stored cap, which the patch does not carry.
 */
const contactShape = z.object({
  name: z.string().min(1).max(24),
  /** A phone number or a group id. Empty means "not yet assigned". */
  target: targetSchema,
  enabled: z.boolean(),
});

const contactSchema = z.preprocess(
  migrateContact,
  contactShape.refine((contact) => !contact.enabled || contact.target.length > 0, {
    error: 'an enabled contact must have a phone number or group',
    path: ['target'],
  }),
);

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

const audioShape = z.object({
  speakerVolumePercent: z.number().int().min(0).max(100),
  /** Hard ceiling on playback — this sits near a small child's ears. */
  maxVolumeCapPercent: z.number().int().min(0).max(100),
  micGainPercent: z.number().int().min(0).max(100),
  /** Bounds a stuck button so it cannot fill the RAM disk. */
  maxRecordingSeconds: z.number().int().min(1).max(120),
});

const audioSchema = audioShape.refine(
  (audio) => audio.speakerVolumePercent <= audio.maxVolumeCapPercent,
  {
    error: 'speakerVolumePercent must not exceed maxVolumeCapPercent',
    path: ['speakerVolumePercent'],
  },
);

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
const buttonTimingsShape = z.object({
  /** Presses shorter than this are contact bounce or an accidental brush. */
  debounceMs: z.number().int().min(0).max(2000).default(150),
  /** At or beyond this, a press is a recording rather than a tap. */
  recordThresholdMs: z.number().int().min(100).max(10_000).default(500),
  /**
   * A committed recording carrying less *actual audio* than this is discarded. Distinct
   * from the threshold above: a slow microphone start can leave a long hold nearly empty.
   */
  minRecordingMs: z.number().int().min(0).max(10_000).default(500),
  /**
   * How long after release a recording stays open, waiting to be continued.
   *
   * Small hands slip. Without this, a grip that fails mid-sentence ships half a message
   * and the child has no way to carry on. Pressing the same button again inside this
   * window resumes the *same* take rather than starting a new one. The cost is that every
   * message sends this much later, so it is deliberately short. 0 disables it entirely:
   * the recording commits the instant the button comes up.
   */
  resumeGraceMs: z.number().int().min(0).max(3000).default(400),
  /** How long Button 1 + Button 3 must be held together to toggle silent mode. */
  silentComboMs: z.number().int().min(500).max(15_000).default(3000),
});

const buttonTimingsSchema = buttonTimingsShape
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
 * What the admin API accepts: **any subset of any mutable section, to any depth.** `version`
 * and `system.adminPasswordHash` are deliberately absent — they are not client-editable.
 *
 * Partial all the way down, uniformly. It used to be uneven — `system`, `wifi` and `contacts`
 * took a patch while `audio`, `quietHours` and `buttons` demanded every field — which meant a
 * form sending one timing got a 400 listing everything it forgot, for no reason a caller could
 * infer. `mergeConfig` has always merged field-by-field, so the plumbing never needed the
 * stricter shape; only this schema did.
 *
 * Cross-field rules still hold. They live on the refined schemas above and run against the
 * **merged** config in `ConfigManager.save()`, which is the only place they can run correctly:
 * a patch raising the volume has to be compared against the stored cap, and the patch does not
 * carry it.
 */
const contactPatchSchema = z.preprocess(migrateContact, contactShape.partial());

export const configUpdateSchema = z
  .object({
    system: systemSchema.pick({ hostname: true }).partial(),
    wifi: wifiSchema.partial(),
    contacts: z
      .object({
        button1: contactPatchSchema,
        button2: contactPatchSchema,
        button3: contactPatchSchema,
      })
      .partial(),
    audio: audioShape.partial(),
    quietHours: quietHoursSchema.partial(),
    buttons: buttonTimingsShape.partial(),
  })
  .partial();

export type ConfigUpdate = z.infer<typeof configUpdateSchema>;

/** Clamps a requested volume to the configured safety cap. */
export function clampVolume(requestedPercent: number, audio: AudioConfig): number {
  const bounded = Math.round(Math.min(Math.max(requestedPercent, 0), 100));
  return Math.min(bounded, audio.maxVolumeCapPercent);
}

/** Normalises a configured target into the JID Baileys expects. "" if unusable. */
export function toJid(target: string): string {
  return parseTarget(target)?.jid ?? '';
}

export type ResolvedContact = {
  readonly key: ButtonKey;
  readonly index: ButtonIndex;
  readonly contact: ContactConfig;
  readonly jid: string;
  readonly kind: TargetKind;
};

/**
 * The contacts that may send to and receive from this device.
 *
 * This is the whitelist. Anything not in it is dropped — a toddler must not be reachable by
 * strangers, and that includes groups nobody deliberately assigned.
 */
export function enabledContacts(config: DeviceConfig): ResolvedContact[] {
  return BUTTON_KEYS.flatMap((key) => {
    const contact = config.contacts[key];
    if (!contact.enabled) return [];
    const parsed = parseTarget(contact.target);
    if (!parsed) return [];
    return [{ key, index: buttonKeyToIndex(key), contact, jid: parsed.jid, kind: parsed.kind }];
  });
}
