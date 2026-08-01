# System Requirements & Architecture Specification

**Project Name:** bloopbox — a screenless WhatsApp voice messenger for kids

**Target Audience:** Children aged 2–5 years

**Tech Stack:** Node.js, TypeScript 7, Baileys, Express, Socket.io, Vitest

**Document Status:** Complete Production Architecture Specification (v6.0)

---

## 1. Executive Summary & Core User Experience

The **Screenless WhatsApp Voice Messenger** is an offline, screen-free IoT appliance designed for toddlers (ages 2–5) to communicate directly with family members via WhatsApp. By assigning dedicated, color-coded arcade buttons to specific individuals (Button 1: Left, Button 2: Center, Button 3: Right), the device replaces digital screens with simple physical interactions: **Hold to Send, Tap to Play**.

### Core Workflows

- **Sending a Message:**

1. Child holds assigned button $\rightarrow$ High short "Pop" chime plays (unless in Silent Mode), button LED turns **Solid ON**.
2. Child speaks into the microphone.
3. Child releases button $\rightarrow$ the recording is **not** sent yet. It stays open for a short **carry-on window** (`buttons.resumeGraceMs`, 400 ms by default) and the LED stays **Solid ON**. Pressing the _same_ button again inside that window continues the same message instead of starting a new one, so a grip that slips mid-sentence costs nothing. Nothing new to learn: solid means "still listening".
4. The window expires $\rightarrow$ Upward "Whoosh" chime plays, LED flashes 3x rapidly $\rightarrow$ Voice note converts to `.ogg` (Opus codec, `ptt: true`) and ships to WhatsApp. The chime plays _after_ the capture is finalised, so it is never recorded into the message it is announcing.
5. Short press ($<1.0\text{s}$) triggers an "Oops/Cancel" double-beep sound, drops the clip, and sends nothing. A tap never opens a carry-on window.

- **Receiving a Message:**

1. Voice note arrives from a whitelisted contact.
2. Assigned button starts **blinking slowly** (0.8s ON / 0.8s OFF).
3. Child taps button **once** $\rightarrow$ All pending unread messages from that sender play **sequentially in a queue** (separated by a short soft chime), and the light turns off once the queue finishes.

---

## 2. Hardware Architecture & Bill of Materials

```
┌────────────────────────────────────────────────────────────────────────┐
│                          ENCLOSURE (WOOD / 3D PRINT)                   │
│                                                                        │
│   ┌─────────────┐       ┌─────────────┐       ┌─────────────┐          │
│   │ [ MOM ] LED │       │ [ DAD ] LED │       │ [GRANDMA]LED│          │
│   └──────┬──────┘       └──────┬──────┘       └──────┬──────┘          │
│          │ Switches            │ Switches            │ Switches        │
│          │                     │                     │                 │
│          ▼                     ▼                     ▼                 │
│   ┌─────────────────────────────────────────────────────────┐          │
│   │                  Raspberry Pi Zero 2 W                  │          │
│   └───────┬────────────────────┬────────────────────┬───────┘          │
│           │                    │ GPIO               │ USB              │
│           │                    ▼                    ▼                  │
│           │             ┌─────────────┐      ┌─────────────┐           │
│           │             │   ULN2003   │      │ USB Audio   │           │
│           │             │ Drivers     │      │ Combo / Mic │           │
│           │             └──────┬──────┘      └─────────────┘           │
│           │                    │ 5V Power                              │
│           │                    ▼                                       │
│           └───────────> Arcade LEDs (1 / 2 / 3)                        │
└────────────────────────────────────────────────────────────────────────┘

```

| Component      | Selected Spec                          | Purpose / Details                                                                |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| **Brain**      | **Raspberry Pi Zero 2 W**              | Quad-core SBC running Linux and two specialized Node.js/TypeScript daemons.      |
| **Buttons**    | 3x 60mm Illuminated Arcade Buttons     | Tactile inputs for contacts (Button 1: Left, Button 2: Center, Button 3: Right). |
| **LED Driver** | ULN2003 Driver Board / Chip            | Amplifies 3.3V Pi GPIO signals to drive 5V arcade LEDs brightly and safely.      |
| **Audio I/O**  | USB Mini Speakerphone OR USB Soundcard | Single USB connection for combined microphone input and speaker playback.        |
| **Power**      | 5V 2.5A Micro-USB Power Supply         | Steady wall power (no power button or internal batteries).                       |

---

## 3. Dynamic Configuration Lifecycle (`/data/config.json`)

To keep source code immutable and support onboard setup, device settings are generated dynamically during initial onboarding and stored in writable storage.

```
[ First Boot / Factory Reset ]
               │
               ▼
   `/data/config.json` missing? ───► Load `config.default.json` in RAM
               │
               ▼
   Boot into AP Hotspot Mode + Show Captive Portal
               │
               ▼
   Parent configures Wi-Fi, WhatsApp numbers, Volume & Quiet Hours
               │
               ▼
   [ SAVE CONFIG ] ───► Atomic write to `/data/config.json`
               │
               ▼
   Restart Hardware & WhatsApp Daemons

```

### Generated `config.json` Schema

```json
{
  "version": 1,
  "system": {
    "hostname": "bloopbox",
    "adminPasswordHash": "$2b$10$e8...",
    "configured": true
  },
  "wifi": {
    "ssid": "Home-Network-5G",
    "password": "SecretWifiPassword123"
  },
  "contacts": {
    "button1": {
      "name": "Mom",
      "phone": "15551234567@s.whatsapp.net",
      "enabled": true
    },
    "button2": {
      "name": "Dad",
      "phone": "15559876543@s.whatsapp.net",
      "enabled": true
    },
    "button3": {
      "name": "Grandma",
      "phone": "15555555555@s.whatsapp.net",
      "enabled": true
    }
  },
  "audio": {
    "speakerVolumePercent": 70,
    "maxVolumeCapPercent": 85,
    "micGainPercent": 60,
    "maxRecordingSeconds": 30
  },
  "quietHours": {
    "enabled": true,
    "startTime": "20:00",
    "endTime": "07:00"
  }
}
```

---

## 4. Software Architecture, Process Model & HAL

The system is built 100% in **TypeScript 7** on Node.js, split into two decoupled background processes managed via `pm2` or `systemd`. Physical hardware calls are isolated behind a **Hardware Abstraction Layer (HAL)**.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        RASPBERRY PI ZERO 2 W                           │
│                                                                        │
│  ┌───────────────────────────┐                ┌──────────────────────┐ │
│  │   Process 1: Hardware     │  IPC / WebSockets │  Process 2: WhatsApp │ │
│  │   & Web Server Daemon     │ ◄────────────► │  Bridge Daemon       │ │
│  │                           │                │                      │ │
│  │ • Express & Socket.io Web │                │ • Baileys Engine     │ │
│  │ • Hardware Abstraction    │                │ • WebSockets Auth    │ │
│  │ • Local Audio Rec/Play    │                │ • Media Downloads    │ │
│  │ • OS Overlayfs & Cleanup  │                │ • Number Whitelist   │ │
│  └─────────────┬─────────────┘                └──────────────────────┘ │
└────────────────┼───────────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────┐
│  Hardware Abstraction Layer (HAL)│
│                                  │
│  ├── [ REAL HARDWARE DRIVER ]    │ ──► GPIO Pins, rpio / pigpio, ALSA
│  └── [ SIMULATED DRIVER ]        │ ──► Web Browser Canvas / Socket.io
└──────────────────────────────────┘

```

### Process Breakdown

1. **Process 1 (`hardware-server.ts`):**

- **Web Server & REST API:** Serves admin panel, onboarding Captive Portal, and interactive simulator.
- **HAL & Audio Pipeline:** Intercepts button triggers, handles debouncing, controls ULN2003 LED drivers, and manages local audio recording/playback queues.
- **Config & Housekeeping:** Reads `/data/config.json`, manages automatic 48-hour RAM/disk audio purges (`tmpfs`), and manages quiet hours.

2. **Process 2 (`whatsapp-bridge.ts`):**

- **Baileys Client:** Maintains persistent WhatsApp WebSocket connections.
- **Media Pipeline:** Receives incoming voice notes, saves them to RAM disk (`/tmp`), and notifies Process 1 via local IPC/Sockets.

---

## 5. Web Hardware Simulator & Vitest Test Suite

### Visual Interactive Simulator (`/simulator`)

Setting `SIMULATOR_MODE=true` activates a virtual 2D browser canvas rendering the device UI:

- **Virtual Arcade Buttons:** Mouse drag/hold simulates button hold; release triggers the send pipeline.
- **Real-time Digital LEDs:** Renders spatial LED patterns (Boot marquee, Connecting pulse, Error codes, Silent Mode heartbeat).
- **Browser Audio I/O:** Uses Web Audio APIs (`navigator.mediaDevices.getUserMedia`) to capture laptop audio and playback queued incoming notes.
- **Event Injector:** Inject custom system events (e.g., _Simulate incoming voice note from Mom_, _Trigger Wi-Fi failure_, _Simulate session expiry_).

### Test Suite Strategy (Vitest)

- **HAL Interface Tests:** Verifies correct digital output patterns across all system states.
- **Button Debounce & Timing:** Validates that presses $<300\text{ms}$ are ignored, and presses $<1.0\text{s}$ trigger the "Cancel" double-beep tone.
- **Carry-on Window:** Validates that a release followed by a press inside `resumeGraceMs` continues the same capture rather than starting a second one, and that repeating it cannot push a recording past `maxRecordingSeconds`.
- **Sequential Audio Queue:** Verifies FIFO playback ordering when multiple voice notes arrive from the same contact.
- **Configuration Manager:** Asserts fallback to `config.default.json` and tests atomic writing to `/data/config.json`.
- **Audio Storage Purge:** Validates auto-deletion of temporary audio files older than 48 hours.

---

## 6. Comprehensive Digital LED Signal Matrix

All lighting indicators rely strictly on binary digital states (HIGH/LOW) with spatial positioning: **Button 1 (Left)**, **Button 2 (Center)**, **Button 3 (Right)**.

| Device State   | Pattern Layout (1 / 2 / 3) | Digital Animation / Timing      | Meaning |
| -------------- | -------------------------- | ------------------------------- | ------- |
| **Booting Up** | `[ 1 ] ➔ [ 2 ] ➔ [ 3 ]`    | **Sequential Chasing Loop**<br> |

<br>_(1 ON ➔ 2 ON ➔ 3 ON, 0.2s per step)_ | System hardware initializing and loading services. |
| **Connecting** | `[ 1 ] + [ 2 ] + [ 3 ]` | **Synchronized Blink**<br>

<br>_(All 3 ON for 0.5s, OFF for 0.5s together)_ | Joining Wi-Fi network and establishing WhatsApp socket connection. |
| **Ready / Normal Mode** | `[   ] [   ] [   ]` | **ALL LIGHTS OFF** | System online, connected, and in normal audible mode. |
| **Ready / Silent Mode (Idle)** | `[ 1 ] [   ] [ 3 ]` | **Outer Guard Pulse / Heartbeat**<br>

<br>_(Buttons 1 & 3 flash ON for 0.1s every 4 seconds)_ | **SILENT MODE ACTIVE.** Confirms quiet hours/mute is on without being distracting at night. |
| **Silent Mode Transition** | `[ 1 ] ➔ [ 2 ] ➔ [ 3 ]` | **Single Slow Chasing Pass**<br>

<br>_(One full left-to-right pass: 0.5s per step)_ | Immediate feedback when manually entering or exiting Silent Mode (Hold B1+B3 for 3 sec). |
| **Wi-Fi Error** | `[ 1 ] [ 2 ] [ 3 ]` | **ALL 3 LIGHTS SOLID ON** | Network disconnected, and no setup hotspot up (yet). |
| **Setup Hotspot (AP Mode)** | `[ 1 ] + [ 2 ] + [ 3 ]` | **Synchronized Double-Pulse**<br>

<br>_(All 3: ON 0.15s, OFF 0.15s, ON 0.15s, then OFF for the rest of a 2s period)_ | The open `bloopbox` setup network is up and the captive portal is waiting. Rhythm rather than another rate, because it has to be told apart from Connecting across a room; solid-on stays the language of error. Raised after 20s of no association when unconfigured, 3 min once configured. |
| **WhatsApp Error** | `[ 1 ] [ 2 ] [   ]` | **LIGHTS 1 & 2 SOLID ON** | Wi-Fi connected, but WhatsApp session unlinked or waiting for QR scan. |
| **Unread Message** | `[ X ]` _(Assigned contact)_ | **Single Button Blinking**<br>

<br>_(0.8s ON / 0.8s OFF)_ | Voice note(s) waiting in queue from that specific family member. |
| **Recording Audio** | `[ X ]` _(Pressed button)_ | **Single Button SOLID ON** | Active voice recording in progress. |
| **Message Sent** | `[ X ]` _(Pressed button)_ | **3 Fast Flashes**<br>

<br>_(0.1s ON / 0.1s OFF, 3 times)_ | Audio successfully shipped to WhatsApp. |

---

## 7. Audio Cues & Mute Behavior

### Audio Feedback Cues

- **Start Recording:** High-pitched, ultra-short (< 200ms) "Pop" chime.
- **Stop Recording:** Upward "Whoosh" chime.
- **Message Sent:** Success "Swoosh" sound.
- **Cancel / Short Press ($<1.0\text{s}$):** Low double-beep "Oops" tone.

### Silence & Quiet Hours Rules

- **Manual Toggle:** Press and hold **Button 1 + Button 3** simultaneously for 3 seconds.
- **Scheduled Quiet Hours:** Configurable start and end times via Admin Web UI (e.g., 20:00 to 07:00).
- **Behavior Matrix in Silence Mode:**
- **Inbound Messages:** Button blinks silently (**NO** notification chime).
- **Outbound Recording:** Silent start/stop (**NO** audio cues).
- **Playback:** Tapping a blinking button plays audio normally at configured volume.

---

## 8. OS Protection & Storage Safety

1. **Read-Only Root Filesystem (`overlayfs`):** System OS partitions are mounted Read-Only. Abrupt power loss will never corrupt the system.
2. **RAM Disk for Audio Processing (`tmpfs`):** Audio recordings, `ffmpeg` conversion, and playback buffers execute entirely inside RAM (`/tmp`).
3. **Automatic Storage Purge (TTL):** Unread persistent audio files are purged **48 hours** after creation to maintain zero disk bloat.

---

## 9. Full Directory Blueprint

```text
bloopbox/
├── package.json
├── tsconfig.json               # Configured for TypeScript 7
├── vitest.config.ts            # Test runner configuration
├── config.default.json         # Fallback configuration template
├── src/
│   ├── config/
│   │   └── configManager.ts    # Service to load, validate, write /data/config.json
│   ├── processes/
│   │   ├── hardware-server.ts  # Daemon 1: Web UI, Express, HAL, Audio Queue
│   │   └── whatsapp-bridge.ts  # Daemon 2: Baileys WebSocket connection
│   ├── hal/
│   │   ├── types.ts            # HAL Interface and event types
│   │   ├── index.ts            # HAL Factory (Selects GPIO or Simulator based on ENV)
│   │   ├── gpioDriver.ts       # Physical Pi Zero 2 W pin driver
│   │   └── simulatorDriver.ts  # Browser WebSockets virtual driver
│   ├── audio/
│   │   ├── sounds/             # System chimes (pop.wav, whoosh.wav, oops.wav)
│   │   └── queueManager.ts     # Sequential audio queue handler
│   └── tests/                  # Vitest test suite
│       ├── hal.test.ts
│       ├── button.test.ts
│       ├── config.test.ts
│       └── audioQueue.test.ts
├── public/
│   ├── admin/                  # Admin management Web UI
│   └── simulator/              # Web-based interactive device simulator
└── /data/                      # Persistent writable volume (Ignored by Git)
    └── config.json             # Dynamically generated upon user setup

```
