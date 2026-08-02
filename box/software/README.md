# box/software

The two Node.js daemons that run the box, plus the four browser UIs, the packaging and the deploy
scripts. This is the whole of bloopbox that exists today.

**Everything here runs from this directory.** There is no root `package.json` and no npm workspaces
(see [`../../website/README.md`](../../website/README.md) for when that changes), so:

```bash
cd box/software
```

For what the device *does* — install it, set it up, what the lights mean — see the
[root README](../../README.md). This page is the development half.

## Prerequisites

- **Node.js ≥ 22** (developed on 24)
- **ffmpeg** with Opus support — `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux)

```bash
npm install
npm run sounds      # generate the audio cue WAVs — they are not committed
npm run doctor      # verify ffmpeg and the audio devices
npm run check       # format + lint + typecheck + test. This is the gate; it must pass
```

`npm install` also installs the pre-commit hook, which runs the same gate. The hook itself lives at
the **repo root** (`.githooks/pre-commit`) because git will not find it anywhere else, and it skips
the npm half when nothing under `box/software/` is staged — so a docs-only commit is instant.
`git commit --no-verify` bypasses it.

## Running it

Two terminals — the daemon and Vite for the browser UIs:

```bash
npm run dev:hw      # hardware server + API + Socket.io on :3000, with the simulator HAL
npm run dev:web     # the four UIs with hot reload on :5174, proxying to :3000
```

Then open <http://localhost:5174/simulator/>. Add a third terminal for `npm run dev:wa` (the
WhatsApp bridge) only when you need real pairing or sending.

Set `CONFIG_PATH=./data/config.json` if you are testing anything that saves settings — the default is
the device's `/data`, which does not exist on a dev machine, and without it every save fails
silently back to `config.default.json` in RAM. The full environment table is in
[`../../docs/architecture.md`](../../docs/architecture.md#environment).

In production there is one server: `npm run build` emits `dist/` and `dist/public/`, and
`npm run start:hw` serves both from :3000.

## Driving the simulator

The simulator is a virtual device on a browser canvas, and it is how essentially all of this was
developed — no Raspberry Pi required. It boots into `CONNECTING` and stays there, so start by
clicking **"WhatsApp connected (go READY)"** in the event injector; that is where normal behaviour
lives.

| Action                                                        | What it does                                    |
| ------------------------------------------------------------- | ----------------------------------------------- |
| Click-and-hold a button, or hold <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> | Records, then sends                   |
| Tap a blinking button                                         | Plays that contact's queue                      |
| Tap a dark button                                             | "Oops" double-beep                              |
| Hold <kbd>1</kbd> + <kbd>3</kbd>                              | Toggles silent mode after three seconds         |
| Event injector                                                | Reboot, go READY, inbound notes, Wi-Fi down and restored, hotspot up and down, session expiry |

Injected notes are synthesised 1.4-second tones with a distinct pitch per button (G4 / C5 / E5), so
you can hear both *that* playback worked and *which* contact it came from. Recording needs
microphone permission.

`npm run dev:hw` supervises the server, so the restart-on-save behaviour works in development too.
`npm run dev:hw:watch` does not — `tsx watch` will not restart a process that exits cleanly, so a
config save leaves the server down. Use it for editing source, not for testing config.

## Tests

```bash
npx vitest run src/tests/button.test.ts        # one file
npx vitest run -t 'discards a short recording' # one test by name
npm run test:watch
npm run test:coverage                          # v8; thresholds are declared but not yet met
```

Timing-sensitive suites — LED patterns, debounce, purge TTL — run on **fake timers**. Never add a
real sleep. Server-layer tests drive a real Express app on an ephemeral port with `fetch`.

## All the scripts

| Command                 | Does                                                  |
| ----------------------- | ----------------------------------------------------- |
| `npm run check`         | **The gate.** Format check, lint, typecheck, tests    |
| `npm run dev`           | Hardware server and WhatsApp bridge together          |
| `npm run dev:hw`        | Hardware server, supervised — restarts on config save |
| `npm run dev:hw:watch`  | Hardware server with file watching, no supervisor     |
| `npm run dev:wa`        | WhatsApp bridge only                                  |
| `npm run dev:web`       | Vite dev server for the four browser UIs              |
| `npm run typecheck`     | Both tsconfigs — server and browser                   |
| `npm run lint`          | oxlint, with type-aware rules                         |
| `npm run format`        | prettier (markdown is deliberately out of scope)      |
| `npm run test:watch`    | Vitest in watch mode                                  |
| `npm run test:coverage` | Coverage report                                       |
| `npm run build`         | Compile the server to `dist/` and the UIs to `dist/public/` |
| `npm run doctor`        | Verify ffmpeg and audio device prerequisites          |
| `npm run sounds`        | Regenerate the audio cue WAVs                         |
| `npm run clean`         | Delete build output: `dist/`, `release/`, `coverage/`  |
| `npm run clean:all`     | The above plus `node_modules/` and the generated cues  |
| `npm run release`       | Build the arm64 device tarball (Docker)               |
| `npm run release:smoke` | Install and boot that tarball in an arm64 container   |
| `npm run release:image` | Build a flashable SD card image (Linux + root)        |

## Where things live

```
src/core/        pure domain logic — button interpreter, LED animator, state, network supervisor
src/hal/         everything physical, behind one interface: GPIO, simulator, mock
src/audio/       ffmpeg pipeline, cues, the unread queue, the 48h purge
src/whatsapp/    Baileys client and the contact whitelist
src/config/      Zod schema and the atomic config manager
src/server/      Express routes, admin auth, the bridge link, the captive portal
src/net/         reads what the root network agent publishes
src/ipc/         the event contract between the two daemons — edit this first
src/processes/   the two daemons
src/tests/       Vitest, node environment
public/          the four browser UIs on a shared design system — built by Vite, not tsc
deploy/          systemd units, the installer, the root network agent, the debugging kit
packaging/       the release Dockerfile, pinned versions, the nmcli stub for container tests
scripts/         dev server, sound generation, doctor, release and SD-image builders
```

`scripts/`, `deploy/` and `packaging/` have to stay in this directory together: the release scripts
derive their root from their own location rather than from git, which is what let this whole package
move without editing a single one of them.

Everything generated lives in this directory too and is gitignored: `dist/` (compiled app),
`release/` (the Pi tarball and SD image), `coverage/` (the test report), `node_modules/`, plus the
cue WAVs and `data/`. None of them are needed to develop — `npm run dev:hw` runs `src/` through tsx
and `npm run dev:web` serves `public/` through Vite.

### Cleaning up

```bash
npm run clean        # dist/ release/ coverage/          — then `npm run build`
npm run clean:all    # + node_modules/ + the cue WAVs    — then `npm install && npm run sounds`
```

**Neither touches `data/`, on purpose.** That directory holds `config.json` and the Baileys
credentials, and deleting it drops the WhatsApp pairing — which no command can rebuild, only
re-scanning a QR with the phone that owns it. It is gitignored, so `git clean -Xdf` at the repo root
*will* take it: reach for that only when losing the pairing is what you actually want.

[`../../docs/architecture.md`](../../docs/architecture.md) explains why it is split this way and
which rules are load-bearing. [`../../CLAUDE.md`](../../CLAUDE.md) is the conventions and the
toolchain traps — read it before changing the build.
