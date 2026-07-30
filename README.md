# Kids WhatsApp Voice Messenger

A screenless WhatsApp voice messenger for children aged 2–5. Three illuminated arcade buttons, each
assigned to one family member. **Hold to send a voice note, tap to play what arrived.** No screen,
no menus, no scrolling.

Runs on a Raspberry Pi Zero 2 W as two Node.js daemons. See [`PRODUCT.md`](./PRODUCT.md) for the
full behavioral specification and [`CLAUDE.md`](./CLAUDE.md) for architecture and conventions.

## Status

Under active development, built in phases:

- [x] **Phase 1** — project foundation, tooling, validation gate
- [ ] **Phase 2** — hardware server: config, LED state machine, HAL, audio pipeline, simulator UI
- [ ] **Phase 3** — WhatsApp bridge (Baileys)
- [ ] **Phase 4** — Raspberry Pi provisioning (deferred until hardware is on hand)

The physical device does not exist yet. Everything is developed and verified against a **browser
based hardware simulator**, so no Pi is needed to work on this.

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
`npm run start:hw` serves directly from :3000 alongside the API.

## Scripts

| Command                 | Does                                                |
| ----------------------- | --------------------------------------------------- |
| `npm run check`         | **The gate.** Format check, lint, typecheck, tests. |
| `npm run dev`           | Both daemons in watch mode                          |
| `npm run dev:hw`        | Hardware server only (simulator mode)               |
| `npm run dev:wa`        | WhatsApp bridge only                                |
| `npm run test:watch`    | Vitest in watch mode                                |
| `npm run test:coverage` | Coverage report                                     |
| `npm run build`         | Compile server to `dist/` and UIs to `dist/public/` |
| `npm run doctor`        | Verify ffmpeg / audio device prerequisites          |
| `npm run sounds`        | Regenerate the audio cue WAVs                       |

## Hardware

| Component  | Part                                    |
| ---------- | --------------------------------------- |
| Brain      | Raspberry Pi Zero 2 W                   |
| Buttons    | 3× 60 mm illuminated arcade buttons     |
| LED driver | ULN2003 (3.3 V GPIO → 5 V LEDs)         |
| Audio      | USB speakerphone or USB soundcard + mic |
| Power      | 5 V 2.5 A micro-USB                     |

## Safety and privacy

The device only accepts messages from the three explicitly configured phone numbers — groups,
status broadcasts, and unknown senders are dropped. Recordings live in a RAM disk and unread audio
is deleted after 48 hours. The root filesystem is mounted read-only so pulling the plug cannot
corrupt it.
