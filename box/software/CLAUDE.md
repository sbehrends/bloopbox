# CLAUDE.md — box/software

Rules for changing the box software. Loaded when Claude first touches a file in this directory; the
repo-wide map, the gate and the tripwires are in [`../../CLAUDE.md`](../../CLAUDE.md), and the full
reasoning with diagrams is in [`../../docs/architecture.md`](../../docs/architecture.md).

**This file holds rules and pointers, not prose.** If an explanation here runs past a few lines, it
belongs in `docs/`.

Everything below runs from this directory (`box/software/`).

## Prerequisites

- Node ≥ 22 (developed on 24)
- **`ffmpeg` on PATH** — required for the Opus/ogg pipeline. `brew install ffmpeg` on macOS,
  `apt install ffmpeg` on the Pi. Override with `FFMPEG_PATH`.
- `npm run sounds` after a fresh clone — the cue WAVs in `src/audio/sounds/` are **generated, not
  committed**. The designed source recordings they are partly built from (`src/audio/samples/*.mp3`)
  **are** committed: they are authored audio, so losing one is a broken checkout, not a missing
  build step. `data/` is gitignored too, so a clean checkout has no config and boots into
  onboarding.

`npm run doctor` verifies external prerequisites (ffmpeg, ALSA devices). Markdown is deliberately
outside prettier's scope — see `.prettierignore`.

## Commands

```bash
npm run dev:hw          # terminal 1 — hardware server + API + Socket.io on :3000 (SIMULATOR_MODE=true)
npm run dev:web         # terminal 2 — Vite for the four UIs on :5174, proxying /api and /socket.io
npm run dev:wa          # WhatsApp bridge (only needed for real pairing/sending)
npm run dev             # dev:hw + dev:wa together (no Vite; use the built UIs or add dev:web)
```

Then open `http://localhost:5174/simulator/` or `/admin/`. In production there is one server:
`npm run build` emits `dist/` + `dist/public/`, and `npm run start:hw` serves both from :3000.

```bash
npx vitest run src/tests/button.test.ts        # one file
npx vitest run -t 'discards a short recording' # one test by name
npm run test:watch
npm run test:coverage                          # v8, 80% thresholds declared but NOT met
```

Individual gate steps when iterating: `npm run typecheck` (runs both server and web projects),
`npm run lint`, `npm run lint:fix`, `npm run format`.

### Environment variables

Defaults are the **device's** absolute paths. `scripts/dev-server.ts` sets only `SIMULATOR_MODE` and
`PORTAL_PORT`, so on macOS `/data` does not exist: without `CONFIG_PATH=./data/config.json` the
server falls back to `config.default.json` in RAM and every settings save fails. Set it whenever you
are testing config at all.

The full table is in [`../../docs/architecture.md`](../../docs/architecture.md#environment). The ones
that bite in development:

| Variable         | Default             | Notes                                            |
| ---------------- | ------------------- | ------------------------------------------------ |
| `SIMULATOR_MODE` | unset → `gpio`      | Selects the HAL. `HAL_DRIVER=mock` wins over it   |
| `CONFIG_PATH`    | `/data/config.json` | Point at `./data/config.json` locally             |
| `RECORDING_DIR`  | `/tmp/bloopbox`     | `/run/bloopbox` on the device (tmpfs)             |
| `BRIDGE_TOKEN`   | `''`                | Shared secret both processes must agree on        |
| `PORTAL_PORT`    | `80` (dev: `8080`)  | Captive-portal listener; `0` disables it          |

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

## Conventions

- ESM throughout. Import relative paths **with the `.ts` extension** (`./foo.ts`) —
  `rewriteRelativeImportExtensions` rewrites them to `.js` on emit.
- `erasableSyntaxOnly` is on: no `enum`, no `namespace`, no parameter properties. Use `as const`
  objects + union types instead of enums.
- Config types are **inferred from the Zod schema** in `src/config/schema.ts`. Never hand-write a
  parallel interface — add the field to the schema and the type follows.
- Timing values live in exactly one place and are exported. No magic numbers inline. Anything a user
  might want to tune belongs in the Zod schema (`config.buttons` is the precedent).

## Architecture, in one screen

`docs/architecture.md` has the diagrams and the why. The constraints on a change:

| Layer          | Rule                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| `src/core/`    | Pure and I/O-free. Only calls `hal.setLed()`. This is what makes timing testable    |
| `src/hal/`     | All physical I/O — buttons, LEDs, **and audio** — behind `types.ts`. Load GPIO dynamically |
| `src/ipc/`     | The daemon-to-daemon contract. **Adding an event means editing `events.ts` first**  |
| `src/processes/hardware-server.ts` | Never imports Baileys                                         |
| `src/processes/whatsapp-bridge.ts` | Never touches GPIO or audio devices                           |
| `src/net/`     | The **only** way the daemon learns whether Wi-Fi is up                              |

Networking sits outside both daemons: they run unprivileged under `ProtectSystem=strict` and cannot
talk to NetworkManager, so `bloopbox-net.service` runs `deploy/net-agent.sh` as root and the two
communicate through files in `/run` — one writer per directory, and the action is enum-validated,
never evaluated as shell.

**A missing, stale or unparseable network reading means *unknown*, reported as "not down".** Never
invent an outage from missing information, or every dev machine lights the error pattern.

### The four browser UIs

`public/simulator/`, `public/admin/`, `public/portal/` and `public/brand/` are plain TS on a shared
design system in `public/shared/` — no framework, **outside `src/`**, compiled by Vite not tsc.

- Three tsconfigs. `tsconfig.json` typechecks `src/` + `scripts/` (node libs, no DOM);
  `tsconfig.web.json` typechecks `public/` with DOM libs and `types: []`, whitelisting the only
  shared modules browser code may import (`src/ipc/`, `src/audio/cues.ts`, `src/config/schema.ts`);
  `tsconfig.build.json` is the emit config. `npm run typecheck` runs the first two, so a DOM global
  in `src/` or a node global in `public/` fails there and nowhere else.
- Vite 8 bundles with **Rolldown**: use `rolldownOptions`, not `rollupOptions`.
- **The portal is deliberately not on the IPC contract.** It runs in a captive-portal webview where
  WebSocket is unreliable and storage is ephemeral, so it is plain `fetch` with hand-written
  narrowing. A dependency on Socket.io there is a page that hangs on a phone. Verify after touching
  the build: `dist/public/portal/index.html` must reference **no shared JS chunk**.

### The design system

`docs/BRAND.md` is the direction; `/brand/` is the living kit, rendered with the same stylesheets the
product pages use so it cannot drift. Rules that keep it honest:

- `shared/tokens.css` is **the only file allowed to contain a colour literal**.
- **Nothing enters `base.css` unless two or more pages use it.** Page-local styling lives beside its
  page.
- **Reference the semantic token, not the brand one** — `var(--accent)`, not `var(--brand-teal)`.
  Dark mode overrides only the semantic layer, which is why it is fifteen lines.
- **The component layer is CSS, not JS, on purpose** — it is the only kind the portal can share
  without a JS dependency. `dom.ts` is therefore optional and the portal imports none of it.
- **The simulator's canvas reads tokens through `theme.ts`** rather than holding its own hexes. A
  canvas cannot use a class; this is the only sanctioned way around that.
- **`--ch-1/2/3` are yellow, coral, teal, in that order**, matching the logo mark. Reordering means
  redrawing both SVGs. Nothing enforces it yet — see `PENDING.md`.

### Server surface

Everything under `/api` sits behind `requireAdmin` (HTTP Basic against a bcrypt hash) **except**
`GET /status`, `GET /whatsapp`, `GET /cues` and `POST /onboard`.

The guard **stands aside entirely while `system.configured` is false** — first-run onboarding could
otherwise never set a password. Don't "fix" that. It also stands aside on an empty
`adminPasswordHash`, which leaves a hand-edited `configured: true` config wide open: a **decided,
accepted risk**, because the guard cannot tell that state from mid-onboarding and refusing to serve
would make the device recoverable only by pulling the SD card. Both halves are pinned by
`src/tests/adminAuth.test.ts`; the watch item in `PENDING.md` has the reasoning.

The app also listens on **:80** (`PORTAL_PORT`) because a phone's captive-portal probe asks nowhere
else; off-device that bind fails with `EACCES` and is logged and ignored. The bridge authenticates
separately with `BRIDGE_TOKEN` on the `x-bridge-token` header, compared in constant time.

### Config

`PUT /api/config` accepts **any subset of any section, to any depth**. Cross-field rules
(volume ≤ cap, debounce < threshold, an enabled contact has a target) are checked by
`ConfigManager.save()` against the **merged** config — the only place they can be, since a patch
raising the volume does not carry the cap. Sections with a refinement are a plain `…Shape` object
plus a refined `…Schema`, because `.partial()` exists only on a `ZodObject`.

**Adding a section touches four places:** `configSchema`, `configUpdateSchema`, `ConfigPatch` and
`mergeConfig`. The last is the one that fails silently — `whatsapp.markPlayedAsRead` shipped broken
for ten minutes because of it, and the test that caught it asserted on **behaviour**, not on the
response. Use `.prefault({})`, not `.default({})`, and cover the migration with a test.

Config is read at construction and never re-read. A save exits the process cleanly (code 0) so a
supervisor restarts it: systemd on the device (`Restart=always` is load-bearing),
`scripts/dev-server.ts` under `npm run dev:hw`, and **nothing** under `npm run dev:hw:watch` —
`tsx watch` will not restart a process that exits cleanly, so a config save leaves the server down.

### A button targets a person **or** a group

`contacts.*.target` takes a phone number (normalised to `<digits>@s.whatsapp.net`) or a group JID
ending in `@g.us`. `parseTarget()` in `src/config/schema.ts` is the only place that decides which.
Normalisation rejects a surviving leading zero rather than guessing a country code — a
wrong-but-plausible target validates, saves, looks configured, and is silently dead in both
directions on a device with no screen.

Group JIDs are opaque, so the admin panel offers a picker fed by `GET /api/whatsapp/groups`. For a
group, **membership is the permission**. The field used to be `phone` and is migrated by a
`z.preprocess`; dropping that would fail validation and silently reset a parent's contacts.

## Baileys 7 notes

Pinned to `7.0.0-rc14` exactly (an RC is what the `latest` tag points at). Differences from the 6.x
examples most guides show:

- **`printQRInTerminal` is deprecated and its feature removed** — passing it does nothing. The QR
  arrives on `connection.update` and we forward it to the admin panel.
- **`isJidUser` does not exist** (only `isJidGroup`). Group detection is a `@g.us` suffix check.
- `version` on the socket config is `version?: WAVersion`, which under `exactOptionalPropertyTypes`
  rejects an explicit `undefined` — spread it conditionally.
- `syncFullHistory` is **off**: it would download every chat this account ever had into a RAM disk
  on a 512 MB machine.
- Outbound audio needs `-avoid_negative_ts make_zero` and one channel, per Baileys' own docs, or
  some clients show the voice bubble but refuse to play it.
- **`creds.registered` is only set by the phone-number pairing path.** It is assigned in exactly
  one place in the library (`Socket/messages-recv.js`, the `link_code_companion_reg` handler). A
  **QR scan** finishes through `configureSuccessfulPairing`, which fills in `me`, `account` and
  `platform` and never touches the flag — so a scanned device has a complete working session on
  disk with `registered: false` beside it. Ask `isPaired()` in `whatsapp/client.ts`, never the flag.
- **Baileys writes media scratch through `os.tmpdir()`** (`encryptedStream` → `<type><id>-enc`) on
  every outbound send, and a failure there arrives as an unhandled `'error'` event that kills the
  process. The unit sets `TMPDIR=/run/bloopbox-tmp`; under `ProtectSystem=strict`, `/tmp` is
  read-only. Keep it off `RECORDING_DIR` — `audio/recovery.ts` treats files there as unread notes.
- `messages.upsert` must handle **both** `notify` and `append`. Baileys picks the type with
  `node.attrs.offline ? 'append' : 'notify'`, so everything queued while disconnected arrives as
  `append`. `messageTimestamp` is a protobuf Long — arithmetic straight on it yields `NaN`.

## Hardware status: NOT ON HAND

All development happens on macOS through the **simulator** HAL driver. `src/hal/gpioDriver.ts` is
written but **has never run on real hardware** — treat it as unverified.
`docs/hardware-bringup.md` is the gate-by-gate plan for the day that changes, with the debugging kit
(`bloopbox-doctor`, `bloopbox-audio-test`, `bloopbox-diagnostics`, `bloopbox-hotspot-test`).

**The MVP board is a Pi 3B+ with a WM8960 audio HAT, one button and no LEDs** —
`install.sh --audio-hat wm8960 --no-leds`. Three things that follow from it, all in `docs/hardware.md`:
the HAT's own button is on **GPIO17, which is already button 1**, so it needs no wiring; `BUTTON_PINS`
and `LED_PINS` make the pin lists shorter than three without touching anything above the HAL; and this
codec needs `CAPTURE_RATE=48000` because it cannot hold two rates on one I²S clock and the record cues
are 48 kHz. Its ALSA controls are **`Playback`/`Capture`** — measured 2026-08-10; this codec has no
`Master`, and the wrong name fails silently because a mixer error is non-fatal by design.

Two more ALSA facts, both learned the same day by having neither direction work on a live device:

- **`aplay` is not a decoder.** It reads WAV/AU/VOC and plays anything else as raw PCM *without
  failing*, so an inbound Ogg/Opus note came out as full-volume noise. `GpioHal.play()` decodes to a
  `play-*.wav` in the RAM disk first; `playCue` does not, because cues are generated as WAV. Locked by
  `gpioPlayback.test.ts`, which also covers the stop-during-decode race.
- **A capture element's mute is separate from its gain.** `amixer sset Capture 60% cap` leaves the
  mute bit alone, and this codec's input PGAs power up muted — a recording of exactly the right length
  containing silence. The driver unmutes in its **own** `amixer` call (an unsupported parameter would
  fail the line and take the gain with it) and `deploy/audio-init.sh` does it at boot for
  `bloopbox-audio-test` and any bare `arecord`.
- **This codec's microphone needs three settings, and only one of them is gain.** Unmute, then
  `… Input Mixer Boost` on (42 dB — it connects the PGA to the boost mixer feeding the ADC), then
  `… Input Boost Mixer LINPUT1=3` (+29 dB). All measured; the table is in `docs/hardware.md`. They
  come from `ALSA_ENABLE_SWITCHES`, whose entries are now `Name` **or** `Name=Value`. When measuring
  capture, use the HAT's own speaker as the stimulus and compare two windows of **one** recording —
  ambient room noise moved 18 dB between identical passes and invalidates everything.

### opengpio 2.0.2 has a bias/debounce bug — do not "fix" the driver by passing options

`Watch`'s constructor calls its native binding as `watch(chip, line, debounce, bias, cb)` while the
binding's own signature is `watch(chip, line, bias, debounce, cb)` — **the two are transposed**.
Asking for `{ bias: Bias.PullUp }` therefore sets a 4 ms debounce and leaves the line floating,
which on a button input means garbage reads.

`gpioDriver.ts` passes **no options at all** and handles both concerns elsewhere: pull-ups come from
the firmware (`gpio=17,27,22=ip,pu`, written into `/boot/firmware/config.txt` by
`deploy/install.sh`, effective only after a reboot), and debounce is software-side in
`core/buttonInterpreter.ts`, which we need anyway for the tap-vs-hold distinction.

## Packaging: the device target is Trixie 64-bit, forced by opengpio

`docs/deployment.md` is the full guide. The parts that constrain how you write code:

- **`opengpio@2.0.2` compiles against the libgpiod _v2_ C++ API.** Bookworm ships libgpiod 1.6,
  where `gpiod::line::value` and `line_request::release()` do not exist, so the addon does not build
  there at all — verified, not assumed. Do not "add Bookworm support".
- Everything pinned lives in **`packaging/versions.env`** — one place, sourced by the scripts and
  both workflows.
- The release **bundles the `node` binary** from the build image, so the compiled addon's
  `NODE_MODULE_VERSION` and the runtime loading it cannot drift.
- **`package.json` ships in the release.** Without `"type": "module"` beside `dist/`, node rejects
  every import in it. `hardware-server.js` resolves the UI at `../../dist/public` and
  `configManager.js` the defaults at `../../config.default.json`, both relative to `dist/` — that
  layout is load-bearing, not tidiness.
- **`RECORDING_DIR` is `/run/bloopbox` on the device**, not `/tmp`: `/run` is already a tmpfs, so
  `RuntimeDirectory=` in both units gives audio-in-RAM with no mount unit.
- `npm run release:smoke` after touching anything under `deploy/` or `packaging/`.
- `BUILDX_EXTRA_ARGS` is the hook CI uses to add `--cache-from/--cache-to type=gha` to the buildx
  invocation. Unset locally, so a local build is unchanged.

### Two shell traps these scripts have already hit

- **Do not write `cmd | grep -q`.** `grep -q` exits at the first match, the producer takes a
  SIGPIPE, and `set -o pipefail` reports the whole check as failed. This bit three separate checks
  during bring-up. Capture into a variable and use `[[ $x == *y* ]]`.
- **Do not expand a possibly-empty array as `"${arr[@]}"`.** Every script here runs
  `set -euo pipefail`, and on **bash 3.2 — which is what macOS ships as `/bin/bash`** — that is an
  unbound-variable error when the array is empty. Use an unquoted `${VAR:-}` where word splitting is
  what you want, with a `# shellcheck disable=SC2086` and a note saying why.

## Tests

`src/tests/*.test.ts`, node environment. Timing-sensitive suites (LED patterns, debounce, purge TTL)
run on **fake timers** — never add a real sleep. Where a code path awaits real filesystem work
(`deviceController.test.ts` leaves `setImmediate` real because commit awaits `rm`), assert with a
`waitFor` condition rather than a fixed number of yields: fixed flushes passed in isolation and
failed intermittently under parallel load.

Server-layer tests drive a **real Express app on an ephemeral port with `fetch`**, assembled the way
`hardware-server.ts` assembles it — see `src/tests/support/apiHarness.ts`. No supertest.
`bridgeLink.test.ts` uses a real Socket.io server and client, because the token gate is handshake
middleware and only exists during a connection.

`vitest.config.ts` declares 80% coverage thresholds but **`npm run check` does not run them** — it
calls plain `vitest run`. Currently ~77% statements / 68% branches, so they still fail:
`src/whatsapp/` (24%) is the large hole, `src/audio/` sits at 75%, and
`src/server/simulatorTransport.ts` is untested on purpose. Known debt, not a passing gate.

## Decisions the spec left open

**Resolved and locked by tests.** If you think one is wrong, change it deliberately in one place,
update the test, and update `docs/PRODUCT.md` and `docs/architecture.md` in the same commit — do not
work around it locally. Full reasoning for each is in
[`../../docs/architecture.md`](../../docs/architecture.md).

| Decision | Rule | Locked by |
| -------- | ---- | --------- |
| **LED priority ladder** | `PRODUCT.md` §6's nine patterns collide, so they resolve **per LED, first match wins**: recording → overlay → lifecycle status → unread → silent heartbeat → off. The setup hotspot outranks the Wi-Fi error | `ledPriority.test.ts` |
| **Tap vs. cancel** | `< debounceMs` ignored; `debounceMs`–`recordThresholdMs` plays the queue or beeps "oops"; `≥ recordThresholdMs` records. Defaults 150 / 500 / 500 / 400 / 3000 ms, all in `config.buttons` | `button.test.ts` |
| **Carry-on window** | A **confirmed** recording stays open `resumeGraceMs` after release; the same button resumes the *same* take. `maxRecordingSeconds` is **not** restarted by a resume. A different button commits what is waiting. `durationMs` counts held time only | `button.test.ts` |
| **Cue timing** | The "pop" is deferred to `recordThresholdMs`, not press time — at press we cannot tell a tap from a hold, and popping early meant every tap-to-play chimed. Capture still starts at t=0; the LED goes solid immediately | `button.test.ts` |
| **Whoosh after finalise** | `#commitCapture` finalises the capture **before** playing the whoosh — the speaker sits next to the microphone and it was recording itself into every message | `deviceController.test.ts` |
| **Silent chord** | Buttons 1 + 3 for `silentComboMs` toggles the **effective** state. Both presses are swallowed the instant the chord forms; released early, nothing happens | `button.test.ts` |
| **Silent mode gating** | Suppressed: inbound chime, record cues, sent, oops. **Not** suppressed: playback, always at the configured volume, always clamped to `maxVolumeCapPercent` | `hal.test.ts`, `audioQueue.test.ts` |
| **Boot animation held** | Status resolves instantly, so `BOOTING` would never be seen. `BOOT_ANIMATION_MS` (2.6 s) holds it; the simulator has a Reboot injector to replay it | — |
| **Beyond the spec** | `notify.wav` (§7 implies an inbound chime without listing one), `boot.wav` (§6 defines a boot LED pattern but no sound; the only channel for "it came back on its own") and `src/core/` itself (the spec's blueprint has no home for the state machine) | `deviceController.test.ts` |
| **Designed vs synthesised cues** | `boot`, `notify` and `swoosh` are mastered from committed MP3s in `src/audio/samples/`; the rest are tone recipes. Both write one WAV per cue into `src/audio/sounds/`, so nothing below `playCue` knows the difference. Trim and peak level are decided in `scripts/generate-sounds.ts`, never left to a filter | `soundFiles.test.ts` |

## Safety constraints (these protect a real device in a child's room)

- Audio recordings live in **tmpfs only** — `/run/bloopbox` on the device. Unread audio is purged
  after **48 h** whether heard or not; playback deletes a note immediately, which is what makes
  *present on disk* mean *unread*.
- `/data/config.json` writes are **atomic** (tmp file → `fsync` → `rename`). A half-written config
  during power loss would brick the device.
- Invalid or missing config falls back to `config.default.json` **in RAM** and boots into
  onboarding. It never crashes the daemon.
- Only the configured JIDs are accepted — `src/whatsapp/whitelist.ts`. Unknown numbers, groups
  nobody assigned, status broadcasts, newsletters and the device's own echoed sends are all dropped,
  **before download**, so a stranger's audio never reaches the disk. `src/tests/whitelist.test.ts`
  is written from the position that anything not explicitly assigned must not get through.
- JIDs are normalised before comparison (`15551234567:12@s.whatsapp.net` is the same person as
  `15551234567@s.whatsapp.net`), or the same contact would be accepted or rejected depending on
  which of their linked devices they sent from.
