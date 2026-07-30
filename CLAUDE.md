# Kids WhatsApp Voice Messenger — working notes

Screenless IoT appliance: 3 illuminated arcade buttons on a Raspberry Pi Zero 2 W let a 2–5 year
old send and receive WhatsApp voice notes. **Hold to send, tap to play.** No screen, ever.

`PRODUCT.md` is the authoritative behavioral spec. This file records how we build it and the
decisions the spec left open.

## Before you report a task done

Run `npm run check` (format + lint + typecheck + test). It must pass. That is the only gate.

`npm run doctor` verifies external prerequisites (ffmpeg, ALSA devices).

## Prerequisites

- Node ≥ 22 (developed on 24)
- **`ffmpeg` on PATH** — required for the Opus/ogg pipeline. `brew install ffmpeg` on macOS,
  `apt install ffmpeg` on the Pi. Override the location with `FFMPEG_PATH`.

## Toolchain: TypeScript 7 + oxlint (do not swap in ESLint)

TypeScript 7 is the Go rewrite. Its npm package **no longer exposes the classic JS compiler API** —
the `.` export is just `lib/version.cjs`, with everything else under `./unstable/*`. Consequently
`typescript-eslint` cannot work at all (its peer range caps at `<6.1.0`, and even canary does), so
**ESLint is not usable on this project**.

Linting is `oxlint` + `oxlint-tsgolint`, with `options.typeAware: true` in `.oxlintrc.json` giving
real type-aware rules (`no-floating-promises`, `no-misused-promises`, `await-thenable`,
`no-unsafe-type-assertion`). Notes:

- oxlint implements ~847 rules but **not every typescript-eslint rule** — e.g. there is no
  `unicorn/prevent-abbreviations`. An unknown rule name is a hard config parse error. Check
  `node_modules/oxlint/configuration_schema.json` (`definitions.DummyRuleMap`) for valid names;
  `oxlint --rules` prints nothing in 1.76.
- The `pedantic` category is **off** on purpose — `prefer-readonly-parameter-types` and
  `strict-void-return` fired constantly and trained us to ignore output. Curated type-aware rules
  are enabled explicitly instead.
- Revisit ESLint only once typescript-eslint ships TS 7 support.

## Hardware status: NOT ON HAND

All development happens on macOS through the **simulator** HAL driver. `src/hal/gpioDriver.ts` is
written but **has never run on real hardware** — treat it as unverified. Do not add code paths
that only work with real GPIO, and never import `opengpio` statically (it is an
`optionalDependency` and does not build on macOS; `src/hal/index.ts` loads it via dynamic
`import()`).

## opengpio 2.0.2 has a bias/debounce bug — do not "fix" the driver by passing options

`Watch`'s constructor calls its native binding as `watch(chip, line, debounce, bias, cb)` while
the binding's own signature is `watch(chip, line, bias, debounce, cb)` — **the two are
transposed**. Asking for `{ bias: Bias.PullUp }` therefore sets a 4 ms debounce and leaves the
line floating, which on a button input means garbage reads.

`gpioDriver.ts` passes **no options at all** and handles both concerns properly elsewhere:

- **Pull-ups** come from the firmware — `gpio=17,27,22=ip,pu` in `/boot/firmware/config.txt`,
  applied by `scripts/provision.sh`. This is more robust anyway: it is set before userspace
  starts and survives any library change.
- **Debounce** is software-side in `core/buttonInterpreter.ts` (`config.buttons.debounceMs`),
  which we need regardless for the tap-vs-hold distinction.

If you find yourself adding an options object to that `watch()` call, re-read this first.

## Architecture

Two decoupled Node processes (systemd units on the Pi):

| Process                  | File                               | Owns                                                                      |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| 1. Hardware & web server | `src/processes/hardware-server.ts` | Express + Socket.io, HAL, LED animation, audio record/play, config, purge |
| 2. WhatsApp bridge       | `src/processes/whatsapp-bridge.ts` | Baileys socket, media download/upload, contact whitelist                  |

**IPC:** Process 2 connects to Process 1's Socket.io server as a _client_ on localhost. The event
contract lives in `src/ipc/events.ts` and is the single source of truth for both sides. Process 1
never imports Baileys; Process 2 never touches GPIO or audio devices.

**HAL:** all physical I/O — buttons, LEDs, _and audio in/out_ — sits behind `src/hal/types.ts`.
Drivers: `simulatorDriver` (browser over Socket.io), `gpioDriver` (real Pi), `mockDriver` (tests,
records every `setLed` call with a timestamp).

Domain logic in `src/core/` is **pure and I/O-free** — it only calls `hal.setLed()`. That is what
makes the timing behavior unit-testable with fake timers. Keep it that way.

## Conventions

- ESM throughout. Import relative paths **with the `.ts` extension** (`./foo.ts`) —
  `rewriteRelativeImportExtensions` rewrites them to `.js` on emit.
- `erasableSyntaxOnly` is on: no `enum`, no `namespace`, no parameter properties. Use
  `as const` objects + union types instead of enums.
- Config types are **inferred from the Zod schema** in `src/config/schema.ts`. Never hand-write a
  parallel interface — add the field to the schema and the type follows.
- Timing values live in exactly one place and are exported, so tests assert against the same
  numbers the runtime uses. No magic numbers inline. Anything a user might want to tune belongs in
  the Zod schema (`config.buttons` is the precedent), not in a module constant.
- Conventional commits (`feat:`, `fix:`, `test:`, `chore:`), one per milestone.

## Decisions the spec left open

These are **resolved and locked by tests**. If you think one is wrong, change it deliberately in
one place and update the test — do not work around it locally.

### LED priority ladder

`PRODUCT.md` §6 lists the nine patterns independently, but they collide (silent-mode heartbeat on
LED 1 vs. an unread message on LED 1). Resolved **per-LED, first match wins**:

1. Recording on this button → **solid on**
2. Active one-shot animation (boot chase, connecting blink, sent-flash, silent-mode transition
   chase) → that animation's current frame
3. Device error — Wi-Fi down → all 3 solid; WhatsApp unlinked → LEDs 1 & 2 solid
4. Unread message on this button → blink 0.8s on / 0.8s off
5. Silent mode idle **and** this is button 1 or 3 → 0.1s pulse every 4s
6. otherwise → **off**

### Tap vs. cancel

The spec says a short press is the "oops" cancel _and_ that a tap plays unread messages. Resolved
by press duration and unread state:

| Press duration                   | Unread present | Result                                                       |
| -------------------------------- | -------------- | ------------------------------------------------------------ |
| < `debounceMs`                   | either         | ignored (debounce)                                           |
| `debounceMs`–`recordThresholdMs` | yes            | play that contact's queue                                    |
| `debounceMs`–`recordThresholdMs` | no             | "oops" double-beep, nothing sent                             |
| ≥ `recordThresholdMs`            | either         | record and send on release (capped at `maxRecordingSeconds`) |

**These are config, not constants.** They live in `config.buttons` (defaults 150 / 500 / 500 /
3000 ms) and are editable from the admin panel, taking effect on the next press with no restart —
finding the right feel by editing source and rebuilding was far too slow. `DEFAULT_BUTTON_TIMINGS`
in `src/config/schema.ts` is the single source of truth, derived from the schema's own field
defaults.

Two things the schema enforces, because both would break the device in ways a parent could not
diagnose:

- `debounceMs` **must** be below `recordThresholdMs`. Without a gap there is no tap, so playing a
  received message becomes impossible.
- A committed recording carrying less than `minRecordingMs` of _actual audio_ is discarded rather
  than sent. Hold duration and captured duration are not the same thing: a slow microphone start
  can leave a long hold with almost no audio in it.

`ButtonInterpreter` takes `timings` as a constructor option and exposes `setTimings()`. A press
already in flight keeps the windows it started under — re-arming its timers mid-press would match
neither the old nor the new values.

### Adding a config section without breaking existing devices

`buttons` was added after devices already had a `config.json`. A new **required** section would
have failed validation, silently falling back to defaults and wiping the parent's contacts. The
section uses `.prefault({})` so an absent or partial section fills in from the field defaults.

Note `.prefault({})`, **not** `.default({})` — Zod's `.default()` substitutes the literal value
_without_ parsing it, so `{}` comes back empty and every timing ends up `undefined`. Use
`prefault` for any future section, and cover the migration with a test (see
`src/tests/config.test.ts`).

Button 1 + Button 3 held together for 3 s toggles silent mode. Both presses are swallowed the
instant the chord forms, so a child mashing the outer buttons can never send two voice notes; if
the chord is released early, nothing at all happens.

**Cue timing follows from this.** Spec §1 plays the "pop" the moment a button is held, but at press
time we cannot tell a tap from a hold — popping immediately would mean every tap-to-play began with
a spurious recording chime. So the pop is deferred to the 1.0 s threshold, where the press is
unambiguously a recording. Audio capture still starts at t=0 (nothing the child says is lost), and
the LED goes solid immediately, so they always get instant acknowledgement.

### Boot animation is held deliberately

The daemon derives status from Wi-Fi/WhatsApp health, which resolves instantly — so `BOOTING`
would never be visible even though `PRODUCT.md` §6 defines a chase pattern for it.
`BOOT_ANIMATION_MS` (2.6 s) holds it, and the simulator has a **Reboot** injector to replay it,
since a browser opened after startup would otherwise never see it.

### Silent mode gating

Suppressed: inbound notification chime, record start/stop cues. **Not** suppressed: playback
itself, which always plays at the configured volume (spec §7). Volume is always clamped to
`audio.maxVolumeCapPercent`.

### Added beyond the spec

- `notify.wav` — §7 implies an inbound chime in normal mode but never lists one among the cues.
- `src/core/` — the spec's blueprint has no home for the state machine / LED animator / button
  interpreter. They must be separate from the HAL to stay testable.

## Safety constraints (these protect a real device in a child's room)

- Audio recordings live in `tmpfs` (`/tmp`) only. Persistent unread audio is purged after **48 h**.
- `/data/config.json` writes are **atomic** (tmp file → `fsync` → `rename`). A half-written config
  during power loss would brick the device.
- Invalid or missing config falls back to `config.default.json` **in RAM** and boots into the
  captive-portal onboarding flow. It never crashes the daemon.
- Only the three configured JIDs are accepted. Groups, status broadcasts, and unknown senders are
  dropped — a toddler must not be reachable by strangers.
