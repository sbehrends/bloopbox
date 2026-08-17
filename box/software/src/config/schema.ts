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
 * The zone a quiet-hours window is expressed in.
 *
 * `UTC` because it is the only answer that is never a wrong *guess* — every alternative
 * claims to know where the family lives.
 *
 * What it is emphatically **not** is the device clock. Measured on a freshly flashed box
 * 2026-08-17: Raspberry Pi OS defaults to **Europe/London**, and `date` there read BST, an
 * hour off UTC. So the untrustworthy reading is not a neutral one that happens to be wrong —
 * it is a real, plausible-looking zone that is simply somebody else's. A 20:00–07:00 window
 * read against it is silently shifted, which on a screenless device looks like "the box
 * stopped chiming" and nothing else.
 */
export const DEFAULT_TIMEZONE = 'UTC';

/**
 * Whether ICU knows this zone name.
 *
 * Asked of the runtime rather than checked against a shipped list: the list would be a second
 * copy of the tzdata, and it would rot. `Intl.DateTimeFormat` throws `RangeError` for a name
 * it does not recognise, which is exactly the question. Called without `new` on purpose — it
 * is a constructor that also works as a plain function, and the result is thrown away.
 */
export function isKnownTimeZone(name: string): boolean {
  try {
    Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** An IANA zone name — "Europe/Berlin", "America/Argentina/Buenos_Aires", "UTC". */
const timeZoneSchema = z
  .string()
  .refine(isKnownTimeZone, 'must be an IANA timezone name like "Europe/Berlin"')
  .default(DEFAULT_TIMEZONE);

/**
 * What a button is wired to. Either one person or one group.
 *
 * A group is as valid a destination as a person — "the family chat" on Button 2 is a natural
 * thing to want — and WhatsApp addresses both with a JID, so the pipeline needs no special
 * case beyond recognising which is which.
 */
export const TARGET_KINDS = ['individual', 'group'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** What a JID's user part must look like once every dialling convention is stripped off. */
const BARE_DIGITS = /^\d{7,15}$/;

/** The suffix WhatsApp gives an individual, as opposed to a group. */
const USER_SUFFIX = '@s.whatsapp.net';

/** Separators people paste along with a number: "+54 9 11 5555-5555", "(011) 5555.5555". */
const PHONE_PUNCTUATION = /[\s().\- ‐-―]/g;
/**
 * Group JIDs are `<id>@g.us`, where the id is usually `<creator>-<timestamp>` but is opaque.
 * Nobody types one from memory, so the admin panel offers a picker fed by the bridge.
 */
const GROUP_PATTERN = /^[\w.-]{5,}@g\.us$/;

export type ParsedTarget = { readonly kind: TargetKind; readonly jid: string };

/**
 * Reduces however a parent wrote a phone number to the bare digits of a JID.
 *
 * A JID's user part is E.164 digits and nothing else — no `+`, no separators, and no way to
 * tell a good number from a bad one by looking. That makes a wrong-but-plausible target the
 * worst failure this config has: it validates, it saves, the panel shows the button
 * configured, and the button is silently dead in both directions on a device with no screen.
 * So anything that is unambiguously a dialling convention is removed, and anything genuinely
 * ambiguous is rejected rather than guessed at.
 *
 * Removed, because neither can ever appear in a JID:
 *   - separators — spaces, dashes of every Unicode flavour, dots, parentheses
 *   - one leading `+` or `00`, the two spellings of "dial internationally"
 *
 * Rejected, not guessed:
 *   - a remaining leading `0`, which is a *national* trunk prefix. `01155555555` is missing
 *     its country code, and inventing one would produce a number that reaches a stranger.
 *     Country codes never begin with 0, so a surviving leading zero is always a mistake.
 *
 * Exported because `WhatsAppClient#requestPairingCode` needs the exact same reduction — typing
 * `0049…` instead of `49…` for the pairing phone number produces a bare-digits string that is
 * valid-looking (right length, all digits) but identifies no one, and WhatsApp's only response
 * to that is a generic "couldn't link device" with no hint of why.
 */
export function normalisePhone(value: string): string | null {
  const withoutSuffix = value.endsWith(USER_SUFFIX) ? value.slice(0, -USER_SUFFIX.length) : value;
  const stripped = withoutSuffix.replace(PHONE_PUNCTUATION, '');
  let bare = stripped;
  if (bare.startsWith('+')) bare = bare.slice(1);
  else if (bare.startsWith('00')) bare = bare.slice(2);
  if (!BARE_DIGITS.test(bare)) return null;
  if (bare.startsWith('0')) return null;
  return bare;
}

/** Normalises a configured target into a JID, or null if it is unusable. */
export function parseTarget(raw: string): ParsedTarget | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (GROUP_PATTERN.test(value)) return { kind: 'group', jid: value };
  const digits = normalisePhone(value);
  if (digits === null) return null;
  return { kind: 'individual', jid: `${digits}${USER_SUFFIX}` };
}

const targetSchema = z
  .string()
  .max(128)
  .refine((value) => value.length === 0 || parseTarget(value) !== null, {
    error:
      'must be a phone number with its country code (7-15 digits; +, 00, spaces and dashes ' +
      'are fine, a leading 0 without a country code is not) or a group id ending in @g.us',
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

/**
 * One volume, not two.
 *
 * There used to be a second field, `maxVolumeCapPercent`, meant as a ceiling a parent set once
 * with `speakerVolumePercent` as the day-to-day knob. It was removed on 2026-08-17 because it
 * never did the job: both fields sat in the same admin card behind the same save button, so
 * anyone who could raise the volume could raise the cap in the same click — a speed bump, not
 * a lock. What it did deliver was a save that failed with an error naming a field the parent
 * had not touched. `clampVolume()` went with it: its input was `speakerVolumePercent` and its
 * ceiling came from the same config, and the schema already refused to load or save a config
 * where one exceeded the other, so it could never once have changed a value.
 *
 * The ceiling that is actually load-bearing is `max(100)` here, which pins the top of the
 * range to whatever `amixer -M sset Playback 100%` means on the wired card.
 *
 * No `.refine()` and so no Shape/Schema split — there is no cross-field rule left to check.
 */
/**
 * The output chain has three stages, and only the first was ever being set.
 *
 * On the WM8960 the DAC feeds an analogue output PGA, which feeds a class-D amplifier with
 * its own gain. Measured on the real device 2026-08-17: `Playback` was at 0 dB while
 * `Speaker` sat at **−20 dB** and both class-D boosts at 0 — so the loudest the box could go
 * was 26 dB below what the hardware can do, and no amount of turning `speakerVolumePercent`
 * up could reach it. All three are exposed rather than pinned at maximum because the top of
 * the range is not automatically the right place: the boosts trade headroom for distortion on
 * a small speaker, so the useful setting is a judgement about a particular enclosure.
 *
 * Each maps to an ALSA control named by an environment variable, and every one of them is
 * **optional** — a plain USB adapter has no such controls, so an unset name means the stage
 * does not exist and is skipped. See `src/hal/gpioDriver.ts`.
 */
const audioSchema = z.object({
  /** Digital DAC volume — `ALSA_MIXER_CONTROL`, `Playback` on the WM8960. */
  speakerVolumePercent: z.number().int().min(0).max(100),
  /**
   * Analogue output PGA — `ALSA_AMP_MIXER_CONTROL`, `Speaker` on the WM8960 (−73…+6 dB).
   *
   * Defaulted, like the two below, so a config.json written before these existed still parses.
   * A required field here would drop every installed device back into onboarding and cost a
   * parent their contacts — see the "quiet-hours timezone" block in `config.test.ts`.
   */
  ampVolumePercent: z.number().int().min(0).max(100).default(100),
  /** Class-D DC boost — `ALSA_AMP_DC_MIXER_CONTROL`, `Speaker DC`. 0-5, not a percentage. */
  ampBoostDc: z.number().int().min(0).max(5).default(5),
  /** Class-D AC boost — `ALSA_AMP_AC_MIXER_CONTROL`, `Speaker AC`. Normally equal to DC. */
  ampBoostAc: z.number().int().min(0).max(5).default(5),
  micGainPercent: z.number().int().min(0).max(100),
  /** Bounds a stuck button so it cannot fill the RAM disk. */
  maxRecordingSeconds: z.number().int().min(1).max(120),
});

const quietHoursSchema = z.object({
  enabled: z.boolean(),
  /** May wrap past midnight (20:00 -> 07:00); see src/core/quietHours.ts. */
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
  /**
   * The zone `startTime` and `endTime` are read in — **not** the device clock's.
   *
   * Defaulted rather than required so a config.json written before this field existed still
   * parses. An unparseable config falls back to the defaults in RAM and boots into
   * onboarding, which for an installed device means losing a parent's contacts to a schema
   * addition. Locked by the "quiet-hours timezone" block in `config.test.ts`.
   */
  timezone: timeZoneSchema,
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

/**
 * How the device behaves as a WhatsApp participant, as opposed to as a device.
 *
 * `prefault({})` for the same reason as the timings above: devices already have a config.json
 * written before this section existed, and a required section would fail validation and reset
 * a parent's contacts.
 */
const whatsappShape = z.object({
  /**
   * Send a read receipt when the child plays a message.
   *
   * On by default: the two ticks turning blue is how the person who recorded it learns their
   * message landed, and on a device with no screen there is nothing else to tell them. It is
   * optional because it also reports *when* a small child is at the box, which some parents
   * will reasonably not want to broadcast — and because a grandparent watching for blue ticks
   * that never come is its own kind of unhappiness.
   *
   * Off does not queue receipts for later. Nothing is sent, ever, for those messages.
   */
  markPlayedAsRead: z.boolean().default(true),
});

const whatsappSchema = whatsappShape.prefault({});

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
  whatsapp: whatsappSchema,
});

export type DeviceConfig = z.infer<typeof configSchema>;
export type ContactConfig = z.infer<typeof contactSchema>;
export type AudioConfig = z.infer<typeof audioSchema>;
export type QuietHoursConfig = z.infer<typeof quietHoursSchema>;
export type ButtonTimings = z.infer<typeof buttonTimingsSchema>;
export type WhatsAppConfig = z.infer<typeof whatsappSchema>;

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
    audio: audioSchema.partial(),
    quietHours: quietHoursSchema.partial(),
    buttons: buttonTimingsShape.partial(),
    whatsapp: whatsappShape.partial(),
  })
  .partial();

export type ConfigUpdate = z.infer<typeof configUpdateSchema>;

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
