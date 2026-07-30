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
- Timing constants live in one place per module and are exported, so tests assert against the same
  numbers the runtime uses. No magic numbers inline.
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

| Press duration | Unread present | Result                                                       |
| -------------- | -------------- | ------------------------------------------------------------ |
| < 300 ms       | either         | ignored (debounce)                                           |
| 300 ms – 1.0 s | yes            | play that contact's queue                                    |
| 300 ms – 1.0 s | no             | "oops" double-beep, nothing sent                             |
| ≥ 1.0 s        | either         | record and send on release (capped at `maxRecordingSeconds`) |

Button 1 + Button 3 held together for 3 s toggles silent mode.

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
