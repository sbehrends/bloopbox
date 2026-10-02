# CLAUDE.md — box/software

Rules for changing the box software. Loaded when Claude first touches a file in this directory; the
repo-wide map, the gate and the tripwires are in [`../../CLAUDE.md`](../../CLAUDE.md), and the
reasoning behind every rule here is in [`../../docs/architecture.md`](../../docs/architecture.md),
under a heading of the same name, unless another document is named.

**This file holds rules and pointers, not prose.** If an explanation here runs past a few lines, it
belongs in `docs/`. Everything below runs from this directory (`box/software/`).

## Prerequisites

- Node ≥ 22 (developed on 24), and **`ffmpeg` on PATH** (override with `FFMPEG_PATH`).
  `npm run doctor` checks both, plus the ALSA capture device and the cue files.
- `npm run sounds` after a fresh clone: the cue WAVs in `src/audio/sounds/` are **generated, not
  committed**. The sources in `src/audio/samples/*.mp3` **are** committed — authored audio that
  cannot be regenerated, so never delete one.
- `data/` is gitignored, so a clean checkout boots into onboarding. Markdown is outside prettier's
  scope on purpose (`.prettierignore`).

## Commands

```bash
npm run dev:hw          # hardware server + API + Socket.io on :3000, simulator HAL, supervised
npm run dev:web         # Vite for the four UIs on :5174, proxying /api and /socket.io
npm run dev:wa          # WhatsApp bridge (only for real pairing/sending)
npx vitest run src/tests/button.test.ts   # one file;  -t '<name>' for one test
```

Open `http://localhost:5174/simulator/` or `/admin/`. Every script: [`README.md`](./README.md#all-the-scripts).

### Environment variables

Defaults are the **device's** paths; the full table is
[`docs/architecture.md` § Environment](../../docs/architecture.md#environment). `scripts/dev-server.ts`
sets only `SIMULATOR_MODE=true`, `PORTAL_PORT=8080` and `NOTES_DIR=./data/notes`, so:

- **Set `CONFIG_PATH=./data/config.json` whenever you test config.** Without it the server falls back
  to `config.default.json` in RAM and every settings save fails.
- Anything else run off-device must set `NOTES_DIR` (no fallback, by design) and `STATS_PATH`
  (otherwise nothing persists). `HAL_DRIVER=mock` wins over `SIMULATOR_MODE`.

## Toolchain: TypeScript 7 + oxlint (do not swap in ESLint)

TypeScript 7's npm package no longer exposes the classic compiler API (its `.` export is just
`lib/version.cjs`), so `typescript-eslint` cannot work. Revisit only once it ships TS 7 support.
Linting is `oxlint` + `oxlint-tsgolint`, type-aware via `options.typeAware` in `.oxlintrc.json`.

- oxlint does **not** implement every typescript-eslint rule, and an unknown rule name is a hard
  config parse error. Valid names are in `node_modules/oxlint/configuration_schema.json`
  (`definitions.DummyRuleMap`); `oxlint --rules` prints nothing in 1.76.
- `pedantic` is **off** on purpose (it fired constantly and trained us to ignore the output). Enable
  curated type-aware rules explicitly instead.
- `switch-exhaustiveness-check`: handle `undefined` as a `case`, not inside `default`.
- `import/no-cycle`; `no-console` outside `scripts/` (log through `childLogger`); `max-lines` 700 for
  non-test files. `public/admin/main.ts` has its own cap at today's size until Phase 5 splits it:
  lower it as the file shrinks, never raise it.

## Conventions

- ESM throughout. Relative imports carry the **`.ts` extension**; `rewriteRelativeImportExtensions`
  rewrites them on emit.
- `erasableSyntaxOnly`: no `enum`, `namespace` or parameter properties. Use `as const` objects plus
  union types.
- `noPropertyAccessFromIndexSignature`: read a possibly-absent key with brackets (`process.env['X']`).
- `exactOptionalPropertyTypes`: an optional property rejects an explicit `undefined` — spread it in
  conditionally.
- Config types are **inferred from the Zod schema** (`src/config/schema.ts`). Never hand-write a
  parallel interface.

## Architecture, in one screen

`src/tests/architecture.test.ts` enforces the import rules below against the real import graph.

| Layer          | Rule                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| `src/core/`    | Pure: no Node built-in but `events`, no package but `zod`. Only calls `hal.setLed()`; `send`, `markRead`, `deleteFile` and stats are injected. A catch that swallows must report through `onFault` |
| `src/hal/`     | All physical I/O — buttons, LEDs, **and audio** — behind `types.ts`. Load GPIO dynamically |
| `src/ipc/`     | The daemon-to-daemon contract. **A new event starts in `events.ts`**; every endpoint takes its maps as Socket.io generics. `noteFiles.ts` is the shared file-name contract |
| `src/processes/hardware-server.ts` | Never reaches Baileys, even for a type                        |
| `src/processes/whatsapp-bridge.ts` | Never reaches the HAL or GPIO. Wiring only: decisions go in the tested `whatsapp/bridge.ts` |
| `src/net/`     | The **only** way the daemon learns whether Wi-Fi is up                              |
| `src/stats/`   | Activity totals, on the card. Never a config section                                |
| `src/system/`  | Health readings, the recent-events ring, the reboot/poweroff request. Every reading is nullable |

- Networking is the root `bloopbox-net.service` (`deploy/net-agent.sh`), reached through files in
  `/run`: one writer per directory, the action enum-validated, **never evaluated as shell**.
- **Reboot and shutdown go through the same agent**: `src/system/power.ts` writes `reboot` /
  `poweroff` into the request file, and the allowlist in `consume_request` is the boundary.
  `systemctl reboot` / `poweroff`, **never `--force`** — the ordinary path SIGTERMs the daemons,
  which flushes the counters.
- **A missing, stale or unparseable network reading is *unknown*, reported as "not down".** Never
  invent an outage from missing information.

### The four browser UIs

`public/{simulator,admin,portal,brand}/`: plain TS on `public/shared/`, no framework, **outside
`src/`**, compiled by Vite, not tsc.

- `tsconfig.json` checks `src/` + `scripts/` (no DOM); `tsconfig.web.json` checks `public/` (DOM,
  `types: []`) and whitelists the only shared modules browser code may import — `src/ipc/`,
  `src/audio/cues.ts`, `src/config/schema.ts`. `npm run typecheck` runs both.
- Vite 8 bundles with **Rolldown**: `rolldownOptions`, not `rollupOptions`.
- **The portal is not on the IPC contract** — plain `fetch`, hand-written narrowing, no Socket.io.
  The plugin in `vite.config.ts` fails the build if its entry imports a shared chunk; keep the
  modulepreload polyfill off.

### The design system

Direction and locked decisions in [`docs/BRAND.md`](../../docs/BRAND.md).

- `shared/tokens.css` is **the only file allowed to contain a colour literal**.
- **Nothing enters `base.css` unless two or more pages use it.**
- **Reference the semantic token** (`var(--accent)`), never the brand one (`var(--brand-teal)`).
- **The component layer is CSS, not JS.** The portal imports none of `dom.ts`.
- **The simulator's canvas reads tokens through `theme.ts`**, never its own hexes.
- **`--ch-1/2/3` are yellow, coral, teal, in that order**, matching the logo mark and the lamps.
  Nothing enforces it.

### The server surface

- `/api` is behind `requireAdmin` except the `OPEN` table in `src/tests/adminAuth.test.ts`
  (`GET /status`, `/whatsapp`, `/cues`, `POST /onboard`, the gated `GET /wifi/scan`). The test
  expects `401` from every other route: an open route goes in that table, with its reason.
- The guard **stands aside while `system.configured` is false** and on an empty
  `adminPasswordHash`. Both are deliberate and pinned by `adminAuth.test.ts`. Don't "fix" them.
- **Never call `verifyAdminPassword` per request** (bcrypt is ~300 ms on the button loop). Go
  through `AdminAuthenticator`; its constants are exported and tested with an injected clock.
- **Every browser POST/PUT to `/api` sends `content-type: application/json`**, with a `{}` body if
  it has nothing to say, or `requireSameOrigin` (`csrf.ts`) answers 415. Pinned by `csrf.test.ts`.
- **`/` is the settings panel, mounted after the captive-portal middleware** so the hotspot owns `/`
  during onboarding. Pinned by `captivePortal.test.ts`. `:80` is the same app.
- The bridge authenticates with `BRIDGE_TOKEN` on `x-bridge-token`, compared by `tokensMatch`.

### Configuration

- `PUT /api/config` accepts any subset of any section. Cross-field rules are checked by
  `ConfigManager.save()` against the **merged** config. A section with a refinement is a plain
  `…Shape` plus a refined `…Schema`, because `.partial()` exists only on a `ZodObject`.
- **A new section touches four places:** `configSchema`, `configUpdateSchema`, `ConfigPatch`,
  `mergeConfig`. Use `.prefault({})`. Test it on **behaviour** (the file on disk, `config.current`),
  not on the response.
- A save exits with code 0 for the supervisor to restart. `npm run dev:hw:watch` has **no**
  supervisor, so a save there leaves the server down.

### Activity totals are not config, and must not become one

`src/stats/statsStore.ts`. Reasoning:
[`docs/architecture.md`](../../docs/architecture.md) § Activity totals are a separate file.

- `DeviceController` takes a structurally typed `StatsRecorder`. Never import the store into `core/`.
- **Count in `handleIncoming`, never in `restoreUnread`.** Only a send WhatsApp accepted counts.
- Writes are coalesced: anything that ends the process must `flush()` first.

### A button targets a person **or** a group

- `parseTarget()` in `src/config/schema.ts` alone decides phone vs. group JID. It rejects a
  surviving leading zero rather than guessing a country code. Keep it strict.
- For a group, **membership is the permission**.
- The `z.preprocess` migrating the old `phone` field must stay, or existing contacts reset.

## Baileys 7 notes

Pinned to `7.0.0-rc14` exactly; Dependabot leaves it to a human. Lifecycle reasoning:
[`docs/architecture.md` § The WhatsApp connection](../../docs/architecture.md#the-whatsapp-connection).

- `printQRInTerminal` does nothing. The QR arrives on `connection.update` and goes to the panel.
- `isJidUser` does not exist (only `isJidGroup`). Group detection is a `@g.us` suffix check.
- `syncFullHistory` stays **off** (every chat ever, into RAM, on a 512 MB machine).
- **Ask `isPaired()` in `whatsapp/client.ts`, never `creds.registered`**: a QR scan never sets it.
- Baileys writes media scratch through `os.tmpdir()`, and a failure there kills the process. The
  unit sets `TMPDIR=/run/bloopbox-tmp`. Keep it off `RECORDING_DIR`, which recovery treats as notes.
- Outbound audio needs `-avoid_negative_ts make_zero` and one channel (`audio/ffmpeg.ts`).
- 408 is both `timedOut` and `connectionLost`, and ends an unscanned QR. An unpaired close other than
  515 settles in `notLinked`; never retry it. Follow every await in `#connect` with a generation check.
- `messages.upsert` must handle **both** `notify` and `append` (everything queued while offline is
  `append`). Protobuf `Long` fields are `NaN` under plain arithmetic — convert first.
- "Delete for everyone" arrives on `messages.update` as a `REVOKE` stub. It goes through the
  whitelist like a note, and `wa:revoked` carries the resolved button, never just an id.

## Hardware status: the reference board is proven, the target is not

All development runs on the **simulator** HAL. The one real device is the **reference board** — Pi
3B+, WM8960 HAT, buttons on GPIO17/27/22, lamps on GPIO23/24/25. Install and build images for it
with `--audio-hat wm8960`, **never `--no-leds`**. The 2026-09-30 bench session proved all three
buttons and lamps, audio both ways, lockout and the silent chord on it (`PENDING.md`); **the Pi Zero
2 W has never run any of it**. [`docs/hardware-bringup.md`](../../docs/hardware-bringup.md) is the
gate-by-gate plan and the debugging kit.

WM8960 rules; the measurements are in [`docs/hardware.md`](../../docs/hardware.md) § The reference
board:

- The HAT's own button is on **GPIO17, which is button 1** — keep button 1 there. The HAT's own
  pins (GPIO 2, 3, 18–21) collide with nothing. `BUTTON_PINS` / `LED_PINS` shorten the pin lists.
- `CAPTURE_RATE=48000`: the codec cannot hold two rates on one I²S clock, and the cues are 48 kHz.
- The mixer controls are **`Playback` / `Capture`**, no `Master`; a wrong name fails silently. The
  amp stages below `Playback` are `config.audio.amp*` via `ALSA_AMP_*_MIXER_CONTROL`, **unset by
  default** (a USB adapter has none).
- **`aplay` is not a decoder**: given Ogg/Opus it plays noise and exits 0. `GpioHal.play()` decodes
  to a `play-*.wav` first; cues are already WAV. Locked by `gpioPlayback.test.ts`.
- **A capture element's mute is separate from its gain.** The driver unmutes in its **own** `amixer`
  call; `deploy/audio-init.sh` does it at boot.
- The microphone also needs `… Input Mixer Boost` on and `… Input Boost Mixer LINPUT1=3`, from
  `ALSA_ENABLE_SWITCHES` (entries are `Name` or `Name=Value`).
- Measure capture within **one** recording, the HAT's speaker as stimulus: room noise drifts too far
  between passes ([`docs/audio-quality.md`](../../docs/audio-quality.md)).

### opengpio 2.0.2 has a bias/debounce bug — do not "fix" the driver by passing options

`Watch` hands `bias` and `debounce` to its native binding transposed, so `{ bias: Bias.PullUp }`
leaves the line floating ([`docs/hardware.md`](../../docs/hardware.md) § Pull-ups come from the
firmware). `gpioDriver.ts` passes **no options**:

- Pull-ups come from the firmware: `gpio=17,27,22=ip,pu` in `/boot/firmware/config.txt`, written by
  `deploy/install.sh`, effective only after a reboot.
- Contact chatter is settled in the HAL (`hal/settledLine.ts`: quiet for `BUTTON_SETTLE_MS`, 20 ms,
  then the level is read); press length is judged in `core/buttonInterpreter.ts`.

## Packaging: the device target is Trixie 64-bit, forced by opengpio

[`docs/deployment.md`](../../docs/deployment.md) is the guide. What constrains code:

- `opengpio@2.0.2` needs the libgpiod **v2** API, which Bookworm lacks. Do not "add Bookworm support".
- Everything pinned lives in **`packaging/versions.env`**, sourced by the scripts and both workflows.
- The release bundles the build image's `node` binary, so the addon's ABI cannot drift.
- **`package.json` ships in the release** (`"type": "module"`), and the code resolves
  `../../dist/public` and `../../config.default.json` relative to `dist/`. That layout is
  load-bearing.
- `RECORDING_DIR` is `/run/bloopbox` via `RuntimeDirectory=` — audio-in-RAM with no mount unit.
  `NOTES_DIR` is covered by `ReadWritePaths=@DATA_DIR@` in both units.
- `npm run release:smoke` after touching anything under `deploy/` or `packaging/`.
- `BUILDX_EXTRA_ARGS` is CI's hook for the buildx cache flags; unset locally.

### Two shell traps these scripts have already hit (reasoning: `docs/deployment.md` § Writing the shell scripts)

- **Do not write `cmd | grep -q`** (SIGPIPE under `set -o pipefail`). Capture into a variable and
  use `[[ $x == *y* ]]`. `src/tests/shellScripts.test.ts` fails on it.
- **Do not expand a possibly-empty array as `"${arr[@]}"`**: under `set -u`, bash 3.2 (macOS's
  `/bin/bash`) calls it unbound. Use an unquoted `${VAR:-}` where word splitting is wanted, with
  `# shellcheck disable=SC2086` and a note saying why.

## Tests

`src/tests/*.test.ts`, node environment.

- Timing-sensitive suites run on **fake timers** — never add a real sleep. Where real filesystem
  work is awaited, assert with `waitFor`, not a fixed number of yields.
- A test that builds a second `DeviceController` on the same `MockHal` must **`dispose()`** the
  first: `stop()` leaves its HAL listeners attached, so it still answers every press.
- Server tests drive a **real Express app on an ephemeral port with `fetch`**
  (`src/tests/support/apiHarness.ts`). No supertest. `bridgeLink.test.ts` uses a real Socket.io
  pair, because the token gate exists only during a handshake.
- **Coverage is a ratchet** in `vitest.config.ts`, enforced by `npm run check` (`test:gate`). Never
  lower a threshold; raise it in the commit that lifts coverage. Never copy the numbers elsewhere.

## Decisions the spec left open

Each rule and its tests are in the table in
[`docs/architecture.md` § Decisions the spec left open](../../docs/architecture.md#decisions-the-spec-left-open):
read the row before changing anything it names. Test titles cite the ID (`[D-05]`), and
`decisions.test.ts` fails when a decision loses its test or a test cites an unknown ID. Change one
deliberately — its tests, `PRODUCT.md` and `architecture.md` in the same commit — never around it.

| ID | Decision | ID | Decision |
| -- | -------- | -- | -------- |
| D-01 | LED priority ladder | D-09 | One sound per send |
| D-02 | Tap vs. cancel | D-10 | Notes are decoded on arrival |
| D-03 | A blinking button does not record | D-11 | Read-only mode |
| D-04 | Carry-on window | D-12 | Silent chord |
| D-05 | One button at a time | D-13 | Silent mode gating |
| D-06 | Bip before the mic | D-14 | Boot animation held |
| D-07 | Nothing plays over a note | D-15 | Beyond the spec |
| D-08 | Whoosh after finalise | D-16 | Designed vs synthesised cues |
|  |  | D-17 | No chime into an open microphone |

## Safety constraints (these protect a real device in a child's room)

- **The two directions do not share a directory** (`src/audio/directories.ts`). Outbound captures
  stay in tmpfs (`RECORDING_DIR`): nothing the child records reaches the card. Inbound notes are on
  the card (`NOTES_DIR`) to survive a power cut. Playback deletes a note, so *present on disk* means
  *unread*; everything is purged at **48 h** regardless.
- **`notesDirectory()` must never fall back to `RECORDING_DIR`** — an upgrade keeps the environment
  file that sets it. Pinned by `purge.test.ts`.
- **Nothing writes a note under its final name except the rename** in `whatsapp/mediaDownload.ts`
  (`.part` → `fsync` → `rename`). Recovery treats every `wa-<i>-<id>.ogg` as unread audio.
- `/data/config.json` writes are **atomic and serialised** (`src/config/atomicWrite.ts`). Invalid or
  missing config falls back to `config.default.json` **in RAM** and boots into onboarding; it never
  crashes the daemon.
- Only configured JIDs get through `src/whatsapp/whitelist.ts`; everything else is dropped **before
  download**. JIDs are normalised first, so all of a contact's linked devices match.
  `whitelist.test.ts` assumes anything not explicitly assigned must not get through.
- **No whole WhatsApp address reaches the log**: log `maskJid(jid)` (`whatsapp/privacy.ts`).
  `bridge.test.ts` fails on any full number.
