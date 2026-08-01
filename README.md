# bloopbox

A screenless WhatsApp voice messenger for children aged 2–5. Three illuminated arcade buttons, each
assigned to one family member. **Hold to send a voice note, tap to play what arrived.** No screen,
no menus, no scrolling.

Runs on a Raspberry Pi Zero 2 W as two Node.js daemons. See [`PRODUCT.md`](./docs/PRODUCT.md) for the
full behavioral specification, [`CLAUDE.md`](./CLAUDE.md) for architecture and conventions, and
[`PENDING.md`](./PENDING.md) for known gaps and the backlog.

## Status

Under active development, built in phases:

- [x] **Phase 1** — project foundation, tooling, validation gate
- [x] **Phase 2** — hardware server: config, LED state machine, HAL, audio pipeline, simulator UI
- [x] **Phase 3** — WhatsApp bridge (Baileys), people and groups as targets
- [x] **Phase 4** — packaging: arm64 release builds, an installer, systemd units, a flashable
      SD card image and CI ([`docs/deployment.md`](./docs/deployment.md))
- [ ] **Phase 5** — hardware bring-up: the GPIO driver, audio and WhatsApp pairing against real
      hardware (waiting on the parts)

The physical device does not exist yet. Everything is developed and verified against a **browser
based hardware simulator**, so no Pi is needed to work on this. The build pipeline is verified
against arm64 Debian Trixie containers, up to booting both daemons out of a mounted SD card
image — but nothing has yet run on a Pi with buttons attached.

## Prerequisites

- **Node.js ≥ 22** (developed on 24)
- **ffmpeg** with Opus support — `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Pi)

Verify with:

```bash
npm run doctor
```

## Getting started

```bash
npm install
npm run sounds      # generate the audio cue WAVs (not committed)
npm run doctor      # check external prerequisites
npm run check       # format + lint + typecheck + test — must pass
```

Then run two terminals — the API server and the Vite dev server for the UIs:

```bash
npm run dev:hw      # terminal 1: hardware server + API on :3000
npm run dev:web     # terminal 2: UIs with hot reload on :5174
```

Open http://localhost:5174/simulator/ (virtual device) or http://localhost:5174/admin/ (admin
panel). Vite proxies `/api` and `/socket.io` through to :3000.

In production there is only one server: `npm run build` emits the UIs into `dist/public/`, which
`npm run start:hw` serves from :3000 alongside the API.

### Using the simulator

The device boots into `CONNECTING` and stays there until WhatsApp links, so start by clicking
**"WhatsApp connected (go READY)"** in the event injector — that is the state where normal
behaviour lives.

| Action                                                                             | What it does                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Click-and-hold a button (or hold <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>) for ≥0.5s | Records, then sends on release                                      |
| Tap a blinking button (0.15–0.5s)                                                  | Plays every voice note waiting from that contact                    |
| Tap a dark button                                                                  | "Oops" double-beep — nothing was sent                               |
| Press under 0.15s                                                                  | Ignored entirely — that is a toddler brushing it                    |
| Admin → Button timings                                                             | Retune all of the above (device restarts to apply)                  |
| Hold <kbd>1</kbd>+<kbd>3</kbd> for 3s                                              | Toggles silent mode                                                 |
| Event injector                                                                     | Reboot, go READY, fake inbound notes, Wi-Fi failure, session expiry |

Injected notes are synthesised 1.4-second tones with a distinct pitch per button (G4 / C5 / E5), so
you can hear both _that_ playback worked and _which_ contact it came from.

All four press timings — debounce, record threshold, minimum recording length and the silent-mode
chord — are editable under **Button timings** in the admin panel, so finding the right feel needs
no rebuild. Saving any setting **restarts the device** to apply it: config is read at boot rather
than watched. `npm run dev:hw` supervises the server and brings it straight back, and the admin
panel shows "restarting" then reloads itself.

Recording needs microphone permission.

### Linking WhatsApp

Sending and receiving need a linked WhatsApp account. Run both daemons, open the admin panel, and
scroll to **WhatsApp** — it offers two routes:

- **Scan the QR.** On your phone: WhatsApp → Settings → Linked devices → Link a device.
- **Link with a phone number.** Enter your number, press _Get a pairing code_, then on your phone
  choose "Link with phone number instead" and type the 8-character code. Usually easier than
  pointing a camera at a laptop.

Codes expire after about 20 seconds; press _Refresh pairing status_ for a new one.

Once linked, assign a target to each button under **Contacts** — a phone number, or a group chosen
from the picker (which appears after linking, since group ids have to be read from the account).
Saving restarts the device, then the LEDs go dark, meaning ready.

> The account you link becomes the identity the device sends as. Use a spare number if you would
> rather not have a toddler's device speaking as you.

## Scripts

| Command                 | Does                                                  |
| ----------------------- | ----------------------------------------------------- |
| `npm run check`         | **The gate.** Format check, lint, typecheck, tests.   |
| `npm run dev`           | Both daemons in watch mode                            |
| `npm run dev:hw`        | Hardware server, supervised — restarts on config save |
| `npm run dev:hw:watch`  | Hardware server with file watching, no supervisor     |
| `npm run dev:wa`        | WhatsApp bridge only                                  |
| `npm run test:watch`    | Vitest in watch mode                                  |
| `npm run test:coverage` | Coverage report                                       |
| `npm run build`         | Compile server to `dist/` and UIs to `dist/public/`   |
| `npm run doctor`        | Verify ffmpeg / audio device prerequisites            |
| `npm run sounds`        | Regenerate the audio cue WAVs                         |
| `npm run release`       | Build the arm64 device tarball (Docker)               |
| `npm run release:smoke` | Install and boot that tarball in an arm64 container   |
| `npm run release:image` | Build a flashable SD card image (Linux + root)        |

## Hardware

| Component  | Part                                    |
| ---------- | --------------------------------------- |
| Brain      | Raspberry Pi Zero 2 W                   |
| Buttons    | 3× 60 mm illuminated arcade buttons     |
| LED driver | ULN2003 (3.3 V GPIO → 5 V LEDs)         |
| Audio      | USB speakerphone or USB soundcard + mic |
| Power      | 5 V 2.5 A micro-USB                     |

The OS target is **Raspberry Pi OS Trixie, 64-bit**, and that is not a preference: the GPIO
addon compiles against the libgpiod v2 API, which Bookworm does not have.

## Putting it on a device

```bash
npm run release          # arm64 tarball, built in Docker — the Pi compiles nothing
npm run release:smoke    # install and boot it in a bare arm64 Debian Trixie container
```

Then either copy the tarball over and `sudo ./install.sh`, or build a card that needs no install
step at all:

```bash
sudo ./scripts/build-sd-image.sh --wifi-ssid Home --wifi-psk secret --wifi-country DE
```

Flash the resulting `.img.xz`, power up, and the device is on the network with the admin panel on
port 3000. Full details, including what the installer changes and how Wi-Fi is provisioned
without a screen, are in [`docs/deployment.md`](./docs/deployment.md).

## Safety and privacy

Each button targets one person **or** one group, and the device accepts messages only from those
targets — unknown numbers, groups nobody assigned, status broadcasts and newsletters are all
dropped, before any audio is downloaded. Recordings live in a RAM disk (`/run/bloopbox`,
a tmpfs) and unread audio is deleted after 48 hours. Writes to `/data/config.json` are atomic, so
losing power mid-save cannot corrupt the parent's settings.

`PRODUCT.md` §11 also calls for a **read-only root filesystem** via overlayfs. That is not built
yet: with `/data` on the root filesystem, enabling the overlay would make every setting and the
WhatsApp pairing evaporate on reboot, so it needs a dedicated partition first. See `PENDING.md`.
