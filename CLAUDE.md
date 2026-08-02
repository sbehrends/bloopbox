# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

bloopbox. Screenless IoT appliance: 3 illuminated arcade buttons on a Raspberry Pi Zero 2 W let a 2–5 year
old send and receive WhatsApp voice notes. **Hold to send, tap to play.** No screen, ever.

`docs/PRODUCT.md` is the authoritative behavioral spec (the `§` citations throughout the source
point at its sections; **do not renumber them**). This file records how we build it and the
decisions the spec left open. `PENDING.md` is the backlog — known gaps, unverified claims and
watch items. Check it before starting something and add to it rather than leaving a finding in
conversation.

The rest of the documentation, and who owns what:

| Document                | Owns                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `README.md`             | The user-facing story: install, set up, use, and get a dev environment      |
| `docs/PRODUCT.md`       | What the device does. Behaviour, the LED matrix, the config schema           |
| `docs/architecture.md`  | How the software is put together, for a human reader. The reader-facing twin of the Architecture and Decisions sections below |
| `docs/hardware.md`      | Parts, wiring, GPIO pins, ALSA, the opengpio bias/debounce trap             |
| `docs/deployment.md`    | Releases, the installer, the SD image, systemd, CI                          |
| `docs/hardware-bringup.md` | The gated plan for the first real device, and the debugging kit           |
| `docs/BRAND.md`         | Visual direction and the design system's locked decisions                   |

**When you change behaviour, update the doc that owns it** — usually `docs/PRODUCT.md` for
behaviour and `docs/architecture.md` for structure — and keep this file's copy of the same rule in
step. Duplication between this file and `docs/architecture.md` is deliberate (this one has to work
from context alone), which means drift is the risk to watch for.

## Before you report a task done

Run `npm run check` (format + lint + typecheck + test). It must pass. That is the only gate.

It is also a **pre-commit hook** (`.githooks/pre-commit`, wired up by the `prepare` script, so
`npm install` installs it — no husky). The whole gate takes about six seconds, so the hook runs
all of it rather than just a typecheck, plus `bash -n` over any staged shell script since neither
prettier nor oxlint looks at those. `git commit --no-verify` bypasses it. The hook checks the
working tree, not the staged snapshot: committing a subset of files can still pass here and be
broken in isolation, which is what CI is for.

`npm run doctor` verifies external prerequisites (ffmpeg, ALSA devices). Markdown is deliberately
outside prettier's scope — see `.prettierignore`.

## Prerequisites

- Node ≥ 22 (developed on 24)
- **`ffmpeg` on PATH** — required for the Opus/ogg pipeline. `brew install ffmpeg` on macOS,
  `apt install ffmpeg` on the Pi. Override the location with `FFMPEG_PATH`.
- `npm run sounds` after a fresh clone — the cue WAVs in `src/audio/sounds/` are **generated, not
  committed** (`scripts/generate-sounds.ts` synthesises them). `data/` is gitignored too, so a
  clean checkout has no config and boots into onboarding.

## Commands

```bash
npm run dev:hw          # terminal 1 — hardware server + API + Socket.io on :3000 (SIMULATOR_MODE=true)
npm run dev:web         # terminal 2 — Vite for the two UIs on :5174, proxying /api and /socket.io to :3000
npm run dev:wa          # WhatsApp bridge (only needed for real pairing/sending)
npm run dev             # dev:hw + dev:wa together (no Vite; use the built UIs or add dev:web)
```

Then open `http://localhost:5174/simulator/` or `/admin/`. In production there is one server:
`npm run build` emits `dist/` + `dist/public/`, and `npm run start:hw` serves both from :3000.

Running tests:

```bash
npx vitest run src/tests/button.test.ts        # one file
npx vitest run -t 'discards a short recording' # one test by name
npm run test:watch                             # watch mode
npm run test:coverage                          # v8, 80% thresholds, enforced
```

Individual gate steps when iterating: `npm run typecheck` (runs both server and web projects),
`npm run lint`, `npm run lint:fix`, `npm run format`.

### Environment variables

Defaults are the **device's** absolute paths. `scripts/dev-server.ts` sets only `SIMULATOR_MODE`,
so on macOS `/data` does not exist: without `CONFIG_PATH=./data/config.json` the server falls back
to `config.default.json` in RAM and every settings save fails. Set it when testing config at all.

| Variable                                         | Default               | Notes                                             |
| ------------------------------------------------ | --------------------- | ------------------------------------------------- |
| `SIMULATOR_MODE=true`                            | unset → `gpio`        | Selects the HAL. `HAL_DRIVER=mock` wins over it.  |
| `CONFIG_PATH`                                    | `/data/config.json`   | Point at `./data/config.json` locally             |
| `RECORDING_DIR`                                  | `/tmp/bloopbox`       | `/run/bloopbox` on the device (tmpfs)             |
| `WA_AUTH_DIR`                                    | `/data/auth_info`     | Baileys credentials                               |
| `BRIDGE_TOKEN`                                   | `''`                  | Shared secret both processes must agree on        |
| `HARDWARE_URL` / `PORT`                          | `localhost:3000`      | Where the bridge dials / where the server listens |
| `FFMPEG_PATH`                                    | `ffmpeg`              |                                                   |
| `LOG_LEVEL`                                      | `debug` in dev        | pino; `pino-pretty` in dev. On the device `bloopbox-debug on` flips it |
| `NET_STATE_PATH`                                 | see `src/net/netState.ts` | What the root net agent publishes; absent in dev |
| `PORTAL_PORT`                                    | `80` (dev: `8080`)    | Captive-portal listener; 0 disables it            |
| `ALSA_*`, `LED_ACTIVE_HIGH`, `BUTTON_ACTIVE_LOW` | see `gpioDriver.ts`   | Pi-only, unverified                               |

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

## Baileys 7 notes

Pinned to `7.0.0-rc14` exactly (an RC is what the `latest` tag points at). Things this version
does differently from the 6.x examples most guides show:

- **`printQRInTerminal` is deprecated and its feature removed** — passing it does nothing. The QR
  arrives on `connection.update` and we forward it to the admin panel, which is the only place it
  could be scanned from anyway.
- **`isJidUser` does not exist** (only `isJidGroup`). Group detection is a `@g.us` suffix check.
- `version` on the socket config is `version?: WAVersion`, which under
  `exactOptionalPropertyTypes` rejects an explicit `undefined` — spread it conditionally.
- `syncFullHistory` is **off**: it would download every chat this account ever had into a RAM
  disk on a 512MB machine.
- Outbound audio needs `-avoid_negative_ts make_zero` and one channel, per Baileys' own docs, or
  some clients show the voice bubble but refuse to play it.

## Hardware status: NOT ON HAND

All development happens on macOS through the **simulator** HAL driver. `src/hal/gpioDriver.ts` is
written but **has never run on real hardware** — treat it as unverified. `docs/hardware-bringup.md`
is the plan for the day that changes: gate by gate, with the debugging kit
(`bloopbox-doctor`, `bloopbox-diagnostics`, `bloopbox-hotspot-test`) and who has to be standing
next to the device for each step. Do not add code paths
that only work with real GPIO, and never import `opengpio` statically (it is an
`optionalDependency` and does not build on macOS; `src/hal/index.ts` loads it via dynamic
`import()`).

## Packaging: the device target is Trixie 64-bit, and that is forced by opengpio

`docs/deployment.md` is the full guide. The parts that constrain how you write code:

- **`opengpio@2.0.2` compiles against the libgpiod _v2_ C++ API** (`gpiod::line::value`,
  `line_request::release()`). Bookworm ships libgpiod 1.6, where those do not exist, so the addon
  does not build there at all — verified, not assumed. The target is **Raspberry Pi OS Trixie,
  64-bit**: `libgpiod3` at runtime, `libgpiod-dev` to build. Every current Pi OS Lite arm64 image
  is Trixie. Do not "add Bookworm support".
- Everything pinned lives in **`packaging/versions.env`** — base images, the Pi OS image and its
  sha256, the apt lists. One place, sourced by the scripts and both workflows.
- The release **bundles the `node` binary** from the build image, so the compiled addon's
  `NODE_MODULE_VERSION` and the runtime loading it cannot drift. The device installs no Node and
  compiles nothing.
- **`package.json` ships in the release.** Without `"type": "module"` beside `dist/`, node
  rejects every import in it. `hardware-server.js` also resolves the UI at `../../dist/public`
  and `configManager.js` the defaults at `../../config.default.json`, both relative to `dist/` —
  so that layout is load-bearing, not tidiness.
- **`RECORDING_DIR` is `/run/bloopbox` on the device**, not `/tmp`: `/run` is already a
  tmpfs, so `RuntimeDirectory=` in both units gives us audio-in-RAM with no mount unit.
- The three commands: `npm run release`, `npm run release:smoke`, `npm run release:image`.
  The smoke test installs the artefact in a bare Trixie arm64 container and boots both daemons;
  run it after touching anything under `deploy/` or `packaging/`.
- **Do not write `cmd | grep -q` in these scripts.** `grep -q` exits at the first match, the
  producer takes a SIGPIPE, and `set -o pipefail` reports the whole check as failed. This bit
  three separate checks during bring-up. Capture into a variable and use `[[ $x == *y* ]]`.

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

`docs/architecture.md` is the same material written out for a human reader, with diagrams. What
follows is the short version plus the rules that constrain a change.

Two decoupled Node processes (systemd units on the Pi):

| Process                  | File                               | Owns                                                                      |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| 1. Hardware & web server | `src/processes/hardware-server.ts` | Express + Socket.io, HAL, LED animation, audio record/play, config, purge |
| 2. WhatsApp bridge       | `src/processes/whatsapp-bridge.ts` | Baileys socket, media download/upload, contact whitelist                  |

**IPC:** Process 2 connects to Process 1's Socket.io server as a _client_ on localhost. The event
contract lives in `src/ipc/events.ts` and is the single source of truth for both sides. Process 1
never imports Baileys; Process 2 never touches GPIO or audio devices.

**Networking sits outside both.** The daemons run unprivileged under `ProtectSystem=strict` and
cannot talk to NetworkManager. A third unit, `bloopbox-net.service`, runs `deploy/net-agent.sh` as
root and publishes what `nmcli` says to `/run/bloopbox-net/net-state.json`; `src/net/netState.ts`
reads it and that is the **only** way the daemon learns whether Wi-Fi is up. A missing, stale or
unparseable reading means *unknown*, which is reported as "not down" — never invent an outage from
missing information, or every dev machine lights the error pattern. Requests in the other
direction (bring the AP up, join a network) will go through a separate `/run/bloopbox`
file with a strictly validated action, so each directory has exactly one writer; see `PENDING.md`.

**HAL:** all physical I/O — buttons, LEDs, _and audio in/out_ — sits behind `src/hal/types.ts`.
Drivers: `simulatorDriver` (browser over Socket.io), `gpioDriver` (real Pi), `mockDriver` (tests,
records every `setLed` call with a timestamp).

Domain logic in `src/core/` is **pure and I/O-free** — it only calls `hal.setLed()`. That is what
makes the timing behavior unit-testable with fake timers. Keep it that way.

Supporting layers: `src/server/` (Express routes, admin auth, the `/bridge` Socket.io link,
simulator transport), `src/audio/` (ffmpeg pipeline, cue playback, unread queue, 48 h purge),
`src/whatsapp/` (Baileys client + whitelist), `src/config/` (Zod schema + atomic ConfigManager),
`src/net/` (reads what the root network agent publishes).

### The four browser UIs

`public/simulator/` (virtual device), `public/admin/` (parent settings), `public/portal/`
(first-boot setup over the hotspot) and `public/brand/` (the living brand kit) are plain TS on a
shared design system in `public/shared/` — no framework. They are **outside `src/`** and compiled
by Vite, not tsc:

- Three tsconfigs. `tsconfig.json` typechecks `src/` + `scripts/` (node libs, no DOM);
  `tsconfig.web.json` typechecks `public/` with DOM libs and `types: []`, whitelisting only the
  shared modules browser code may import (`src/ipc/`, `src/audio/cues.ts`, `src/config/schema.ts`);
  `tsconfig.build.json` is the emit config. `npm run typecheck` runs the first two — a DOM global in
  `src/`, or a node global in `public/`, fails there and nowhere else.
- Vite 8 bundles with **Rolldown**: use `rolldownOptions`, not `rollupOptions`.
- The simulator and admin panel speak the same typed contract as the daemons via
  `src/ipc/events.ts`. Adding a simulator or admin event means editing that file first.
- **The portal is deliberately not on that contract.** It runs in a captive-portal webview,
  where WebSocket is unreliable and storage is ephemeral, so it is plain `fetch` against
  `GET /api/wifi/scan` and `POST /api/wifi/join` and narrows every response by hand. Keep it
  that way: a dependency on Socket.io there is a page that hangs on a phone.

### The design system in `public/shared/`

`docs/BRAND.md` is the direction and the locked decisions; `/brand/` is the living kit, and it
renders using the same two stylesheets the product pages do, so it cannot drift. Four layers:

| File | Holds |
| ---- | ----- |
| `shared/tokens.css` | Palette, type scale, spacing, radii, motion. **The only file allowed to contain a colour literal.** |
| `shared/base.css` | Every shared component as a CSS class — lockup, card, button, field, choice row, status, `.error-box`, kbd. |
| `shared/dom.ts` | The DOM those classes expect: `card()`, `field()`, `checkboxField()`, `actionButton()`, `element()`. |
| `shared/theme.ts` | `readToken()` + the channel token names, for code that cannot use a class. |
| `shared/bloopbox-mark.svg` | The logo mark, for the `<img>` lockups. Unreadable below ~24px. |
| `shared/bloopbox-favicon.svg` | A simpler drawing of the same mark, for `rel="icon"` only. |

Rules that keep it honest:

- **Nothing enters `base.css` unless two or more pages use it.** Page-local styling lives beside
  its page (`admin/admin.css`, `simulator/simulator.css`, `portal/portal.css`, `brand/brand.css`).
- **Reference the semantic token, not the brand one** — `var(--accent)`, not `var(--brand-teal)`.
  Dark mode overrides only the semantic layer, which is why it is fifteen lines.
- **The component layer is CSS, not JS, on purpose.** It is the only kind of component the portal
  can share without taking a JS dependency a captive webview cannot be trusted with. `dom.ts` is
  therefore optional: pure DOM, no fetch, no Socket.io, and the portal imports none of it. Verify
  after touching the build: `dist/public/portal/index.html` must reference no shared JS chunk.
- **The simulator's canvas reads tokens through `theme.ts`** rather than holding its own hexes —
  `getComputedStyle` on `:root`, resolved once at load. A canvas cannot use a class, and this is
  the only sanctioned way around that.
- **`--ch-1/2/3` are yellow, coral, teal, in that order, because that is the order the buttons are
  drawn in the logo mark.** Reordering them means redrawing both SVGs, or the box in the child's
  room stops matching the picture of it. Nothing enforces this yet — see `PENDING.md`.

### Server surface

`/api` is the only mutable surface, mounted in `hardware-server.ts` alongside `/audio` (recordings)
and `/sounds` (cues). The app also listens on **:80** (`PORTAL_PORT`, via
`AmbientCapabilities=CAP_NET_BIND_SERVICE`) because a phone's captive-portal probe asks nowhere
else; off-device that bind fails with EACCES and is logged and ignored. Everything under `/api` sits behind `requireAdmin` — HTTP Basic against a
bcrypt hash in config — except `GET /status`, `GET /whatsapp`, `GET /cues` and `POST /onboard`.
The guard also **stands aside entirely while `system.configured` is false**, or first-run
onboarding could never set a password; don't "fix" that. It stands aside on an empty
`adminPasswordHash` too, which means a config with `configured: true` and no hash is wide open —
a **decided, accepted risk**, because the guard cannot tell that state from mid-onboarding and
refusing to serve would make the device recoverable only by pulling the SD card. Both halves are
pinned by `src/tests/adminAuth.test.ts`; the watch item in `PENDING.md` has the reasoning.
The bridge authenticates separately with `BRIDGE_TOKEN` on the `x-bridge-token` header,
compared in constant time.

`PUT /api/config` accepts **any subset of any section, to any depth** — `configUpdateSchema` is
partial all the way down, `mergeConfig` merges field by field, and cross-field rules
(volume ≤ cap, debounce < threshold, an enabled contact has a target) are enforced by
`ConfigManager.save()` against the **merged** config. That last part is the load-bearing bit: a
patch raising the volume does not carry the cap, so the rule can only be checked after merging.
Sections with a refinement are therefore written as a plain `…Shape` object plus a refined
`…Schema` — `.partial()` exists only on a ZodObject.

### Tests

`src/tests/*.test.ts`, node environment. `vitest.config.ts` declares 80% coverage thresholds
(excluding `src/tests`, `src/processes` and `gpioDriver.ts`) but **`npm run check` does not run
them** — it calls plain `vitest run`. As of this writing `npm run test:coverage` reports **77%
statements / 68% branches**, so the thresholds still fail: `src/whatsapp/` (24%) is the large
remaining hole and `src/audio/` sits at 75%. `src/server/simulatorTransport.ts` is untested on
purpose — it is the browser end of a debugging tool, not device code.
Treat that number as a known debt, not a passing gate.

Server-layer tests drive a **real Express app on an ephemeral port with `fetch`**, assembled the
way `hardware-server.ts` assembles it — see `src/tests/support/apiHarness.ts`, which is a helper
rather than a suite (`include` is `*.test.ts` only). No supertest: nothing was worth a dependency
here. `bridgeLink.test.ts` does the same with a real Socket.io server and client, because the
token gate is handshake middleware and only exists during a connection.

Timing-sensitive suites (LED patterns, debounce,
purge TTL) run on **fake timers** — never add a real sleep. Where a code path awaits real
filesystem work (`deviceController.test.ts` leaves `setImmediate` real because commit awaits `rm`),
assert with a `waitFor` condition rather than a fixed number of yields: fixed flushes passed in
isolation and failed intermittently under parallel load.

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

## A button targets a person **or** a group

`contacts.*.target` accepts either a phone number (bare digits, normalised to
`<digits>@s.whatsapp.net`) or a group JID ending in `@g.us`. `parseTarget()` in
`src/config/schema.ts` is the only place that decides which, and everything downstream just
carries the resulting JID — Baileys addresses both identically.

Group JIDs are opaque, so nobody can type one. The admin panel offers a picker fed by
`GET /api/whatsapp/groups`, which asks the bridge, which calls `groupFetchAllParticipating()`.
That endpoint is behind the admin gate: the list names the family's group chats.

**The field used to be `phone`.** `src/config/schema.ts` migrates it via a `z.preprocess` on the
contact schema, because devices already have a config.json using the old name and dropping it
would fail validation and silently reset the parent's contacts.

For a group, **membership is the permission.** A parent assigning "the family chat" is accepting
everyone in it; the device cannot filter further without becoming unpredictable to a child. The
speaker is logged but not gated on.

## Config is snapshot at boot — saving restarts the daemon

`DeviceController` reads config when it is constructed and never re-reads it. Writing settings
makes the hardware server exit cleanly (code 0) so a supervisor brings it back with the new
values: `requestRestart()` in `src/processes/hardware-server.ts`.

There is deliberately **no live-reload path**. Applying some values live and others only on
restart produces states no test covers and no user can reason about — new button timings against a
stale volume cap, say. A restart is a couple of seconds on this device and leaves exactly one code
path to reason about.

Who does the restarting:

| Context                | Supervisor                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device                 | systemd, `Restart=always` in `deploy/systemd/bloopbox-hardware.service`                                                                                              |
| `npm run dev:hw`       | `scripts/dev-server.ts`, a ~60-line respawner                                                                                                                        |
| `npm run dev:hw:watch` | nothing — `tsx watch` does **not** restart a process that exits cleanly, so a config save leaves the server down. Use it for editing source, not for testing config. |

The admin panel shows "device restarting", polls `/api/status`, and reloads once it answers.

## Decisions the spec left open

These are **resolved and locked by tests**. If you think one is wrong, change it deliberately in
one place and update the test — do not work around it locally, and update `docs/PRODUCT.md` and
`docs/architecture.md` in the same commit.

### LED priority ladder

`PRODUCT.md` §6 lists the nine patterns independently, but they collide (silent-mode heartbeat on
LED 1 vs. an unread message on LED 1). Resolved **per-LED, first match wins**:

1. Recording on this button → **solid on**
2. Active one-shot animation (boot chase, connecting blink, sent-flash, silent-mode transition
   chase) → that animation's current frame
3. Setup hotspot up → all 3 double-pulse (150ms on / 150ms off / 150ms on, then dark to 2s)
4. Device error — Wi-Fi down → all 3 solid; WhatsApp unlinked → LEDs 1 & 2 solid
5. Unread message on this button → blink 0.8s on / 0.8s off
6. Silent mode idle **and** this is button 1 or 3 → 0.1s pulse every 4s
7. otherwise → **off**

Rungs 3 and 4 are one `DeviceStatus` each and so mutually exclusive; the hotspot ranks above the
Wi-Fi error because with the hotspot up, "the network is gone" is the cause and "setup is waiting
for you" is the part a parent can act on. It is a **rhythm**, not another rate: every other
pattern here is a symmetric square wave or a chase, and people tell a heartbeat from a blink
across a room far more reliably than they tell 0.5s blinking from 1.5s blinking. Solid-on stays
the language of error. There is deliberately **no cue** — the hotspot can come up at 3am because
the router died, and a chime in a child's bedroom is the worse failure.

### Tap vs. cancel

The spec says a short press is the "oops" cancel _and_ that a tap plays unread messages. Resolved
by press duration and unread state:

| Press duration                   | Unread present | Result                                                       |
| -------------------------------- | -------------- | ------------------------------------------------------------ |
| < `debounceMs`                   | either         | ignored (debounce)                                           |
| `debounceMs`–`recordThresholdMs` | yes            | play that contact's queue                                    |
| `debounceMs`–`recordThresholdMs` | no             | "oops" double-beep, nothing sent                             |
| ≥ `recordThresholdMs`            | either         | record; on release it stays open for `resumeGraceMs` (below), then sends (capped at `maxRecordingSeconds`) |

**These are config, not constants.** They live in `config.buttons` (defaults 150 / 500 / 500 /
400 / 3000 ms) and are editable from the admin panel — finding the right feel by editing source and
rebuilding was far too slow. `DEFAULT_BUTTON_TIMINGS` in `src/config/schema.ts` is the single
source of truth, derived from the schema's own field defaults.

Two things the schema enforces, because both would break the device in ways a parent could not
diagnose:

- `debounceMs` **must** be below `recordThresholdMs`. Without a gap there is no tap, so playing a
  received message becomes impossible.
- A committed recording carrying less than `minRecordingMs` of _actual audio_ is discarded rather
  than sent. Hold duration and captured duration are not the same thing: a slow microphone start
  can leave a long hold with almost no audio in it.

`ButtonInterpreter` takes `timings` as a constructor option and holds them for its lifetime.

### A released recording stays open for a moment (`resumeGraceMs`)

A toddler's grip slips. Committing on the release edge means half a sentence ships and there is no
way to continue it, so a **confirmed** recording is held open for `resumeGraceMs` (400 ms) after
the button comes up; pressing the same button again inside that window resumes the _same_ take.

The capture is never stopped across the gap — one handle, one file, no concatenation, and no
driver-side work at all. The gap's room noise lands in the message, which is what a paused speaker
actually sounds like and is bounded by the window. Stitching separate segments together was the
alternative and is disproportionate for that.

Rules, all locked by `src/tests/button.test.ts`:

- Only a **confirmed** press opens a window. A tap never does, so tap-to-play is untouched.
- `maxRecordingSeconds` is **not** restarted by a resume — the timer is carried across, so pumping
  the button cannot grow a file in the RAM disk. If it fires mid-window, the take commits there.
- A **different** button going down commits whatever is waiting, rather than leaving two takes
  open. That also keeps the silent-mode chord out of this path entirely.
- `reset()` drops an open window silently, exactly as it already dropped an in-flight press.
- `resumeGraceMs: 0` restores commit-on-release. The cost of the feature is that every message
  sends this much later, so the number is deliberately small.
- The reported `durationMs` is time actually held (first press to final release); the trailing
  window is not speech and is not counted.

No cue marks the resume, and none is needed: the LED never goes out. `pressVisualOff` still fires
on release, but ladder rule 1 (`recording` is still set) keeps the LED solid, so **solid means
"still listening"** and the whoosh still means "gone".

Relatedly, `#commitCapture` finalises the capture **before** playing the whoosh. The cue comes out
of a speaker sitting next to the microphone; playing it first recorded it into the tail of every
message.

### Adding a config section without breaking existing devices

`buttons` was added after devices already had a `config.json`. A new **required** section would
have failed validation, silently falling back to defaults and wiping the parent's contacts. The
section uses `.prefault({})` so an absent or partial section fills in from the field defaults.

Note `.prefault({})`, **not** `.default({})` — Zod's `.default()` substitutes the literal value
_without_ parsing it, so `{}` comes back empty and every timing ends up `undefined`. Use
`prefault` for any future section, and cover the migration with a test (see
`src/tests/config.test.ts`).

A section is wired up in **four** places, and missing the last one fails silently. Beyond
`configSchema` and `configUpdateSchema`, both `ConfigPatch` and `mergeConfig` in
`configManager.ts` name every section explicitly — deliberately, since a mapped type cannot
express that `contacts` is patchable two levels deep while `version` is not patchable at all.
Forget `mergeConfig` and `PUT /api/config` validates the patch, answers `200`, restarts the
daemon, and discards the change. `whatsapp.markPlayedAsRead` shipped that way for ten minutes;
the test that caught it asserted on behaviour rather than on the response, which is the reason it
caught it.

Button 1 + Button 3 held together for 3 s toggles silent mode. Both presses are swallowed the
instant the chord forms, so a child mashing the outer buttons can never send two voice notes; if
the chord is released early, nothing at all happens.

**Cue timing follows from this.** Spec §1 plays the "pop" the moment a button is held, but at press
time we cannot tell a tap from a hold — popping immediately would mean every tap-to-play began with
a spurious recording chime. So the pop is deferred to `recordThresholdMs` (500 ms by default), where
the press is unambiguously a recording. Audio capture still starts at t=0 (nothing said is lost), and
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
- Only the configured JIDs are accepted — `src/whatsapp/whitelist.ts`, the safety boundary of
  the product. Unknown numbers, groups nobody assigned, status broadcasts, newsletters and the
  device's own echoed sends are all dropped. Filtering happens **before** download, so a
  stranger's audio never reaches the disk. `src/tests/whitelist.test.ts` is written from the
  position that anything not explicitly assigned must not get through.
- JIDs are normalised before comparison (`15551234567:12@s.whatsapp.net` is the same person as
  `15551234567@s.whatsapp.net`), or the same contact would be accepted or rejected depending on
  which of their linked devices they happened to send from.
