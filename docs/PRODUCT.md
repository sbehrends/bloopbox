# bloopbox — Behavioural Specification

**Project:** bloopbox — a screenless WhatsApp voice messenger for children

**Target audience:** children aged 2–5, set up by a parent

**Tech stack:** Node.js ≥ 22, TypeScript 7, Baileys 7, Express 5, Socket.io 4, Zod 4, Vitest 4

**Status:** this document describes **the behaviour as currently built**, and flags the parts that
are specified but not implemented. It is the authoritative reference for *what the device does*; the
`§` citations throughout the source point at these section numbers, so they are stable — do not
renumber them. [`architecture.md`](./architecture.md) covers *how* it is built, and
[`../PENDING.md`](../PENDING.md) is the honest list of what is unproven.

---

## 1. Core user experience

A parent assigns each of three illuminated arcade buttons to one person or one group chat
(**Button 1: left, Button 2: centre, Button 3: right**). The child then has one gesture pair for
everything: **hold to send, tap to play.**

Press boundaries are **configuration**, not constants — they live in `config.buttons` and are
editable from the admin panel, because the right feel depends on the child and on the switches. The
values below are the shipped defaults.

### Sending a message

1. The child holds a button. The lamp goes **solid on immediately**, so acknowledgement is instant.
   Audio capture starts at the same moment, so nothing said is lost.
2. At `recordThresholdMs` (500 ms) the press is unambiguously a recording, and the short high
   **"pop"** plays.

   > **Deliberate deviation.** The original spec played the pop the instant the button was held. But
   > a tap on a blinking button plays that contact's queue (§1, receiving), and at press time a tap
   > and a hold are indistinguishable — so popping immediately meant every tap-to-play began with a
   > spurious recording chime. The cue is deferred; the lamp is not.

3. The child speaks.
4. The child releases. **The recording is not sent yet.** It stays open for a **carry-on window**
   (`resumeGraceMs`, 400 ms) with the lamp still **solid on**. Pressing the *same* button again
   inside that window continues the same message rather than starting a new one, so a grip that
   slips mid-sentence costs nothing. Nothing new has to be learned: solid means "still listening".
5. The window expires. The upward **"whoosh"** plays, the lamp flashes 3× rapidly, and the audio is
   converted to `.ogg` (Opus, `ptt: true`) and sent to WhatsApp.

   The cue plays *after* the capture is finalised, deliberately: the speaker sits next to the
   microphone, and playing it first recorded it into the tail of every message.

6. A press released before `recordThresholdMs` sends nothing. With messages waiting it plays them
   (below); with nothing waiting it produces the low **"oops"** double-beep. A tap never opens a
   carry-on window.
7. A press shorter than `debounceMs` (150 ms) is ignored entirely, silently — that is a toddler
   brushing past.

Bounds:

- A recording is capped at `audio.maxRecordingSeconds` (30 s), and **carrying on does not restart
  that ceiling** — pumping the button cannot grow a file in the RAM disk.
- A committed recording carrying less than `minRecordingMs` (500 ms) of **actual audio** is
  discarded rather than sent. Hold duration and captured duration differ: a slow microphone start
  can leave a long hold nearly empty.
- **A send that fails is dropped, not retried** — see §7 and the watch item in `PENDING.md`. There
  is no outbound queue, on purpose.

### Receiving a message

1. A voice note arrives from a **whitelisted** contact (§4). Anything else is dropped before it is
   downloaded.
2. In audible mode a soft **"notify"** chime plays. The assigned lamp starts **blinking slowly**
   (0.8 s on / 0.8 s off).
3. The child taps that button once. Every pending note from that sender plays **sequentially, oldest
   first**, separated by a short soft chime, and the lamp goes out once the queue finishes.
4. If read receipts are enabled (`whatsapp.markPlayedAsRead`, on by default), playing a note marks
   it read upstream, so the person who recorded it sees their two ticks turn blue. It is optional
   because it also reports *when* a small child is at the box.

A played note's file is deleted immediately, which is what makes *present on disk* mean *unread*.

### Silent mode

Holding **Button 1 + Button 3** together for `silentComboMs` (3 s) toggles silent mode, confirmed by
a single slow left-to-right chase. Both presses are swallowed the instant the chord forms, so a
child mashing the outer buttons can never send two voice notes; released early, nothing at all
happens.

It can also be scheduled — see §7.

---

## 2. Hardware

Full bill of materials, wiring, GPIO assignments and the ALSA notes are in
[`hardware.md`](./hardware.md). The shape of it:

```
┌────────────────────────────────────────────────────────────────────────┐
│                     ENCLOSURE (WOOD / 3D PRINT)                        │
│                                                                        │
│   ┌─────────────┐       ┌─────────────┐       ┌─────────────┐          │
│   │ [ MOM ] LED │       │ [ DAD ] LED │       │ [GRANDMA]LED│          │
│   └──────┬──────┘       └──────┬──────┘       └──────┬──────┘          │
│          │ switch              │ switch              │ switch          │
│          ▼                     ▼                     ▼                 │
│   ┌─────────────────────────────────────────────────────────┐          │
│   │                  Raspberry Pi Zero 2 W                  │          │
│   └───────┬────────────────────┬────────────────────┬───────┘          │
│           │                    │ GPIO               │ USB              │
│           │                    ▼                    ▼                  │
│           │             ┌─────────────┐      ┌─────────────┐           │
│           │             │   ULN2003   │      │ USB Audio   │           │
│           │             │   Drivers   │      │ Combo / Mic │           │
│           │             └──────┬──────┘      └─────────────┘           │
│           │                    │ 5 V lamp power                        │
│           └───────────────────►│                                       │
│                          Arcade LEDs (1 / 2 / 3)                       │
└────────────────────────────────────────────────────────────────────────┘
```

| Component      | Selected spec                          | Purpose                                                        |
| -------------- | -------------------------------------- | -------------------------------------------------------------- |
| **Brain**      | Raspberry Pi Zero 2 W                  | Runs Linux and three units: two Node daemons plus a root network agent |
| **Buttons**    | 3× 60 mm illuminated arcade buttons    | Button 1 left, 2 centre, 3 right                                |
| **LED driver** | ULN2003 driver board / chip            | Amplifies 3.3 V GPIO to drive the 5 V arcade lamps              |
| **Audio I/O**  | USB mini speakerphone OR USB soundcard | One USB connection for microphone and speaker                   |
| **Power**      | 5 V 2.5 A micro-USB                    | Steady wall power — no power button, no battery                  |

Buttons are on BCM `GPIO17 / 27 / 22` with **firmware** pull-ups; LED drive lines are on
`GPIO23 / 24 / 25`. The OS target is **Raspberry Pi OS Trixie 64-bit**, forced by the GPIO addon's
libgpiod v2 requirement.

**None of the GPIO or ALSA paths have run on real hardware.** See `hardware.md`.

---

## 3. Configuration lifecycle (`/data/config.json`)

Source code stays immutable; device settings are generated during onboarding and stored in writable
storage.

```
[ First boot / factory reset ]
              │
              ▼
  /data/config.json missing or invalid? ──► load config.default.json in RAM
              │                             (never crash the daemon)
              ▼
  No network after the grace period ──► raise the open setup hotspot
              │                          + serve the captive portal
              ▼
  Parent picks a Wi-Fi network, enters its passphrase,
  and sets the settings password
              │
              ▼
  [ SAVE ] ──► atomic write to /data/config.json  (tmp → fsync → rename)
              │
              ▼
  Daemon exits 0 ──► systemd restarts it ──► the new config is read at boot
              │
              ▼
  On the home LAN: link WhatsApp and assign the three buttons in the admin panel
```

### First Boot

A device that cannot reach a network raises an **open** access point named `bloopbox-XXXX` (the
last four of the Pi's serial) and serves a captive portal on it.

- **Unconfigured:** after **10 s** of no association. It then stays up until somebody uses it —
  there is no known network to step aside for.
- **Configured:** after **3 min**. A flat 30 s would pop a hotspot into the house every time the
  router reboots, which is both alarming and useless. While it is up, every **60 s** the hotspot
  steps aside for a **30 s** attempt at the real network — one radio, so this cannot be a background
  scan.

The AP is open, with no passphrase: a fixed one would be published in this repository, so its
security value is zero while its UX cost is real. The accepted consequence is that while the hotspot
is up on an *unconfigured* device, anyone in radio range could complete onboarding. The window is
short and the device holds nothing yet. On a *configured* device the settings password is required
even over the hotspot.

Wi-Fi can also be supplied without the hotspot at all, and that is the recovery path when even the
hotspot cannot be reached: write `bloopbox-wifi.txt` (`ssid=` / `psk=` / `country=`) on the FAT32
boot partition, which any laptop can read. It is applied on the next boot and then **deleted**, so
the passphrase does not sit in clear text.

### The config schema

Inferred from the Zod schema in [`../src/config/schema.ts`](../box/software/src/config/schema.ts), which is the
single source of truth — there is no hand-written parallel interface.

```json
{
  "version": 1,
  "system": {
    "hostname": "bloopbox",
    "adminPasswordHash": "$2b$10$e8...",
    "configured": true
  },
  "wifi": {
    "ssid": "Home-Network",
    "password": "SecretWifiPassword123"
  },
  "contacts": {
    "button1": { "name": "Mom", "target": "15551234567", "enabled": true },
    "button2": { "name": "Family", "target": "1234567890-1600000000@g.us", "enabled": true },
    "button3": { "name": "Grandma", "target": "15555555555", "enabled": true }
  },
  "audio": {
    "speakerVolumePercent": 70,
    "maxVolumeCapPercent": 85,
    "micGainPercent": 80,
    "maxRecordingSeconds": 30
  },
  "quietHours": {
    "enabled": true,
    "startTime": "20:00",
    "endTime": "07:00"
  },
  "buttons": {
    "debounceMs": 150,
    "recordThresholdMs": 500,
    "minRecordingMs": 500,
    "resumeGraceMs": 400,
    "silentComboMs": 3000
  },
  "whatsapp": {
    "markPlayedAsRead": true
  }
}
```

`contacts.*.target` is either a **phone number** with its country code (bare digits after
normalisation; `+`, `00`, spaces and dashes are accepted and stripped) or a **group JID** ending in
`@g.us`. A number left with a national trunk prefix and no country code is **rejected**, not guessed
at. The field was called `phone` in earlier versions and is migrated automatically.

Cross-field rules, enforced against the **merged** config on every save:

- `speakerVolumePercent` ≤ `maxVolumeCapPercent`
- `debounceMs` < `recordThresholdMs` — without a gap there is no tap, so playing a received message
  becomes unreachable
- an enabled contact must have a target

`buttons` and `whatsapp` were added after devices already had a `config.json`, so both use Zod's
`.prefault({})` and an absent or partial section fills in from field defaults rather than failing
validation and wiping the parent's contacts.

`PUT /api/config` accepts **any subset of any section, to any depth**.

---

## 4. Process model

Built entirely in **TypeScript 7** on Node.js, split into **three systemd units**. Physical I/O is
isolated behind a Hardware Abstraction Layer.

```
┌──────────────────────── RASPBERRY PI ZERO 2 W ───────────────────────────┐
│                                                                          │
│  ┌────────────────────────────┐   Socket.io    ┌───────────────────────┐  │
│  │ 1. bloopbox-hardware       │  (localhost,   │ 2. bloopbox-whatsapp  │  │
│  │    hardware-server.ts      │ ◄──────────►   │    whatsapp-bridge.ts │  │
│  │                            │  /bridge,      │                       │  │
│  │ • Express + Socket.io      │  token-gated)  │ • Baileys engine      │  │
│  │ • HAL: buttons, LEDs, audio│                │ • Media up / download │  │
│  │ • LED animation            │                │ • Contact whitelist   │  │
│  │ • Record / play / purge    │                │ • Read receipts       │  │
│  │ • Config, admin API, portal│                │                       │  │
│  └─────────────┬──────────────┘                └───────────────────────┘  │
│                │ files in /run                                            │
│                ▼                                                          │
│  ┌────────────────────────────┐                                           │
│  │ 3. bloopbox-net (root)     │  nmcli: Wi-Fi state, AP up / down, join    │
│  │    deploy/net-agent.sh     │                                           │
│  └────────────────────────────┘                                           │
└──────────────────────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Hardware Abstraction Layer (HAL)     │
│  ├── gpioDriver     ─► opengpio (libgpiod v2), arecord / aplay / amixer
│  ├── simulatorDriver ─► browser canvas over Socket.io
│  └── mockDriver     ─► tests; records every setLed with a timestamp
└─────────────────────────────────────┘
```

**Process 1 — `hardware-server.ts`**

- Web server and REST API: the admin panel, the onboarding captive portal, and the simulator.
- HAL and audio pipeline: button intents, LED patterns, recording, sequential playback queues.
- Config and housekeeping: reads `/data/config.json` at boot, runs the 48-hour audio purge, applies
  quiet hours, rebuilds the unread queue after a restart.

**Process 2 — `whatsapp-bridge.ts`**

- Maintains the Baileys WhatsApp connection and its credentials in `/data/auth_info`.
- Downloads inbound voice notes to the RAM disk and notifies process 1 over the IPC contract.
- Enforces the **whitelist** before downloading anything.

It is deliberately not bound to process 1: WhatsApp is an unofficial API on a release candidate, and
a crash there must not take the buttons and lights with it.

**Process 3 — `net-agent.sh`**, as root. The daemons run unprivileged under `ProtectSystem=strict`
and cannot talk to NetworkManager. The agent polls `nmcli` every 5 s and publishes one JSON document
the daemon reads; the daemon writes back a strictly enum-validated action (`ap-up` / `ap-down` /
`join`). One writer per directory. **A missing or stale reading means *unknown*, and unknown is
reported as "not down"** — an outage is never invented from silence.

> Earlier drafts of this document said the processes were managed by `pm2` and that GPIO went
> through `rpio`/`pigpio`. Both are wrong: it is systemd and `opengpio`, and there is a third unit.

### The safety boundary

[`../src/whatsapp/whitelist.ts`](../box/software/src/whatsapp/whitelist.ts) accepts **only** the configured
JIDs. Unknown numbers, groups nobody assigned, status broadcasts, newsletters and the device's own
echoed sends are all dropped, **before download**, so a stranger's audio never reaches the disk.
JIDs are normalised first, so a contact is recognised whichever of their linked devices they send
from.

For a group target, **membership is the permission**: assigning "the family chat" accepts everyone
in it. The speaker is logged but not gated on.

---

## 5. The simulator and the test suite

### Web hardware simulator (`/simulator/`)

`SIMULATOR_MODE=true` selects a virtual device rendered on a browser canvas. It is how essentially
all of this was developed, and it is a first-class target rather than a toy.

- **Virtual buttons.** Click-and-hold, or hold <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd>. Release
  runs the real send pipeline.
- **Real-time lamps.** Every pattern in §6, driven by the same `LedAnimator` the GPIO driver uses.
  The canvas reads its colours from the design tokens rather than holding its own.
- **Browser audio I/O.** `getUserMedia` for capture, `MediaRecorder` → WebM/Opus → upload → ffmpeg →
  Ogg/Opus for the send path; queued inbound notes play back through the page.
- **Event injector.** Reboot (replays the boot chase), WhatsApp connected, inbound notes on each
  button, Wi-Fi down and restored, setup hotspot up and down, WhatsApp session expired.

Injected notes are synthesised 1.4 s tones with a distinct pitch per button (G4 / C5 / E5), so both
*that* playback worked and *which* contact it came from are audible.

### Test suite (Vitest)

| Suite                                  | Verifies                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `hal.test.ts`                          | Driver selection and the mock's recorded LED output                       |
| `ledAnimator.test.ts`                  | Every §6 pattern's digital output, on fake timers                        |
| `ledPriority.test.ts`                  | The per-LED priority ladder where §6's patterns collide                   |
| `button.test.ts`                       | Debounce, tap-versus-hold, the carry-on window, the silent chord          |
| `deviceState.test.ts`                  | The observable state machine and its change events                        |
| `deviceController.test.ts`             | The wiring: cues, capture commit, the lamp going out when a queue drains  |
| `audioQueue.test.ts`                   | FIFO ordering when several notes arrive from one contact                  |
| `purge.test.ts`                        | Auto-deletion of audio older than 48 h                                   |
| `recovery.test.ts`                     | Rebuilding the unread queue from the recordings directory after a restart |
| `quietHours.test.ts`                   | The schedule, including a window that wraps past midnight                 |
| `config.test.ts`, `configDefault.test.ts` | Validation, atomic writes, the fallback, and the `phone` → `target` migration |
| `whitelist.test.ts`                    | The safety boundary, written from "anything not assigned must not get through" |
| `whatsappClient.test.ts`               | Disconnect-reason handling, the pairing-code lock, and the deferred-connect gate — all via a mocked socket |
| `offlineDelivery.test.ts`              | Notes sent while the box was off arriving on reconnect                    |
| `routes.test.ts`, `adminAuth.test.ts`  | The REST surface and the auth boundary, against a real Express app        |
| `bridgeLink.test.ts`                   | The token gate, against a real Socket.io server and client                |
| `captivePortal.test.ts`                | Probe redirection while the hotspot is up, and silence when it is not     |
| `netState.test.ts`, `networkSupervisor.test.ts` | Reading the agent's document, and when the hotspot goes up      |
| `payload.test.ts`                      | Narrowing untrusted request bodies                                        |

Timing-sensitive suites run on **fake timers**; no test sleeps. Coverage thresholds of 80% are
declared but **not currently met** (~77% statements / 68% branches) and `npm run check` does not run
them — `src/whatsapp/` is the large remaining hole. See `PENDING.md`.

---

## 6. LED signal matrix

All lighting is binary (on/off) with spatial meaning: **Button 1 (left), Button 2 (centre), Button 3
(right)**. Timings are exported as `LED_TIMINGS` in
[`../src/core/ledAnimator.ts`](../box/software/src/core/ledAnimator.ts), so the tests assert against the same
numbers the runtime uses.

| Device state | Pattern (1 / 2 / 3) | Animation and timing | Meaning |
| ------------ | ------------------- | -------------------- | ------- |
| **Booting** | `[1] ➔ [2] ➔ [3]` | Sequential chasing loop, 0.2 s per step | Services starting. Held for 2.6 s on purpose — status resolves instantly, so it would otherwise never be seen |
| **Connecting** | `[1]+[2]+[3]` | Synchronised blink, 0.5 s on / 0.5 s off | Joining Wi-Fi and establishing the WhatsApp socket |
| **Ready / audible** | `[ ][ ][ ]` | All off | Online, connected, normal mode. The usual state |
| **Ready / silent (idle)** | `[1] [ ] [3]` | Outer pair pulse 0.1 s every 4 s | Silent mode is on. Confirms it without being distracting at night |
| **Silent mode transition** | `[1] ➔ [2] ➔ [3]` | One slow left-to-right pass, 0.5 s per step | Immediate feedback on entering or leaving silent mode |
| **Setup hotspot up** | `[1]+[2]+[3]` | Double-pulse: on 0.15 s, off 0.15 s, on 0.15 s, then dark for the rest of a 2 s period | The open `bloopbox-XXXX` network is up and the portal is waiting. A rhythm rather than another rate, because it has to be told from Connecting across a room. **No cue** — it can happen at 3am |
| **Wi-Fi error** | `[1] [2] [3]` | All three **solid** | No network, and no hotspot up yet |
| **WhatsApp error** | `[1] [2] [ ]` | Lamps 1 and 2 **solid** | Network is fine; the WhatsApp session is unlinked or waiting for a scan |
| **Unread message** | `[X]` (that contact) | Blink 0.8 s on / 0.8 s off | Voice note(s) queued from that family member |
| **Recording** | `[X]` (pressed button) | **Solid on** | Capture in progress — including the carry-on window after release |
| **Message sent** | `[X]` (pressed button) | 3 fast flashes, 0.1 s on / 0.1 s off | Delivered to WhatsApp |

Two things this table cannot express on its own:

- **Solid always means something is wrong**, except on the single button being held. That is why the
  hotspot got a rhythm instead of a fourth blink rate.
- **These patterns collide.** A silent-mode heartbeat wants lamp 1 at the same moment an unread
  message does. They are resolved **per lamp, first match wins**, by a fixed priority ladder — see
  [`architecture.md`](./architecture.md#the-led-priority-ladder). The setup hotspot deliberately
  outranks the Wi-Fi error: with the hotspot up, "the network is gone" is the cause and "setup is
  waiting for you" is the part a parent can act on.

---

## 7. Audio cues and silence

### The cues

| Cue           | Sound                                | Source    | When                                          |
| ------------- | ------------------------------------ | --------- | --------------------------------------------- |
| `boot.wav`    | Designed startup sound (825 ms)       | Recorded  | The device has come up                         |
| `pop.wav`     | High, ultra-short (< 200 ms)          | Tones     | A press has passed `recordThresholdMs`         |
| `whoosh.wav`  | Upward sweep                          | Tones     | A recording has been committed                 |
| `swoosh.wav`  | Designed success sound (456 ms)       | Recorded  | Delivered to WhatsApp                          |
| `oops.wav`    | Low double-beep                       | Tones     | A tap that sends nothing, or a failed send      |
| `chime.wav`   | Short soft chime                      | Tones     | Separator between queued notes during playback |
| `notify.wav`  | Designed arrival sound (318 ms)       | Recorded  | A voice note arrived                           |

Two cues are **beyond the original cue list**. `notify.wav`: §7 never named an inbound chime but
stated that silent mode suppresses one, which implies it exists. `boot.wav`: §6 defines a boot LED
pattern but names no sound, and on a box with no screen the noise it makes when power returns is the
only way a parent across the room learns it came back.

**The WAVs are generated, not committed** — `npm run sounds` builds all seven, and a fresh clone has
none. Three of them are **designed recordings**, committed as MP3 under `box/software/src/audio/samples/`
and mastered by that script; the rest are synthesised from tone recipes in it. Both halves write one
WAV per cue into the same directory under the cue's own name, so nothing downstream — the HAL, the
`/sounds` route, the simulator — can tell which kind a cue is. `aplay` on the device reads WAV and
nothing else, which is why even the designed sounds are transcoded rather than shipped as authored.

Mastering is a decision in `scripts/generate-sounds.ts`, not a filter's side effect:

- **Every cue is trimmed to its audible span.** The three sources arrive padded out to a round two or
  three seconds of silence, and a cue file's length is dwell time on the audio device — untrimmed,
  "delivered" would hold the speaker for 2 s to say something that takes 400 ms, and the chime
  separating two queued notes would land on top of it.
- **Peak level is declared per cue on one 0–1 scale**, shared with the synthesised tones' `gain`. The
  designed sounds and the beeps come out of the same small speaker next to a child's ear, so a cue
  twice as loud as its neighbour is a defect however good it sounds alone.

### Silence and quiet hours

- **Manual toggle:** hold Button 1 + Button 3 together for `silentComboMs` (3 s).
- **Scheduled quiet hours:** a start and end time from the admin panel, 20:00 → 07:00 by default.
  The window **wraps past midnight**, which is the normal case for a child's bedroom rather than an
  edge case, and is half-open — quiet at exactly 20:00, audible at exactly 07:00.
- The chord toggles the **effective** state, so during scheduled quiet hours a parent can force
  audio back on without editing the schedule.

Behaviour while silent:

| Path                       | Silent mode                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| Inbound notification chime | **Suppressed.** The lamp blinks silently                            |
| Boot sound                 | **Suppressed.** Power returns at whatever hour the grid decides; the boot LED chase still runs |
| Record start / stop cues   | **Suppressed**                                                     |
| Sent / oops cues           | **Suppressed**                                                     |
| **Playback of a voice note** | **Not suppressed.** Always plays at the configured volume         |
| LED patterns               | Unaffected, plus the outer-pair heartbeat                           |

Playback is never silenced because a child who taps a light expects to hear something. Volume is
always clamped to `audio.maxVolumeCapPercent` — this sits next to a small child's ears.

One consequence worth knowing: `oops` is suppressed too, so **during quiet hours a failed send
produces no sound at all**, and the LED error pattern is the only indication.

---

## 8. OS protection and storage safety

| Measure | Status |
| ------- | ------ |
| **RAM disk for audio (`tmpfs`)** | **Built.** Recordings, ffmpeg conversion and playback buffers live in `/run/bloopbox`, via `RuntimeDirectory=` in both units. `/run` is already a tmpfs, so audio never touches the card, cannot survive a power cut and cannot fill the SD card |
| **Automatic purge (TTL)** | **Built.** Audio is deleted 48 h after creation whether it has been heard or not, swept hourly. Playback deletes a note immediately |
| **Atomic config writes** | **Built.** Temp file → `fsync` → `rename`. A half-written config during power loss would brick the device |
| **Fallback on invalid config** | **Built.** A missing or corrupt `/data/config.json` falls back to `config.default.json` **in RAM** and boots into onboarding. It never crashes the daemon |
| **Hardware watchdog** | **Built.** BCM watchdog plus its systemd half, 15 s, so a wedged device reboots itself |
| **Read-only root filesystem (`overlayfs`)** | **Specified, not built.** `/data` currently lives *on* the root filesystem, so enabling the overlay would send every setting and the WhatsApp credentials into a RAM overlay, to vanish on reboot — a worse failure, and a silent one. It needs `/data` on its own partition first. See `PENDING.md` |

Recordings are additionally **rebuilt into the unread queue after a daemon restart**, within an
8-hour window, by scanning the recordings directory. A *power cycle* still loses them, because the
directory is a tmpfs — surviving that would mean writing a child's voice to the SD card, which is a
different decision with a privacy cost and a wear cost.

---

## 9. Directory layout

```text
bloopbox/
├── package.json                    # "type": "module" — ships in the release, load-bearing
├── tsconfig.json                   # src/ + scripts/: node libs, no DOM
├── tsconfig.web.json               # public/: DOM libs, whitelisted shared imports
├── tsconfig.build.json             # emit config
├── vite.config.ts                  # four UI entries, bundled with Rolldown
├── vitest.config.ts
├── config.default.json             # fallback, resolved relative to dist/
├── src/
│   ├── config/
│   │   ├── schema.ts               # Zod schema — the source of truth for every config type
│   │   └── configManager.ts        # atomic load / validate / merge / write
│   ├── core/                       # pure, I/O-free domain logic
│   │   ├── buttonInterpreter.ts    # edges → intents: tap, record, carry on, chord
│   │   ├── ledAnimator.ts          # state → LED frames, and the priority ladder
│   │   ├── deviceState.ts          # the observable state, in one place
│   │   ├── networkSupervisor.ts    # when the setup hotspot goes up
│   │   ├── quietHours.ts           # the schedule, wrapping past midnight
│   │   └── deviceController.ts     # the wiring, and the only place I/O appears
│   ├── hal/
│   │   ├── types.ts                # the interface: buttons, LEDs, audio in and out
│   │   ├── index.ts                # factory; loads opengpio via dynamic import()
│   │   ├── gpioDriver.ts           # the real Pi. UNVERIFIED
│   │   ├── simulatorDriver.ts      # browser canvas over Socket.io
│   │   └── mockDriver.ts           # tests; records every setLed with a timestamp
│   ├── audio/
│   │   ├── sounds/                 # generated cue WAVs — not committed
│   │   ├── cues.ts                 # the cue vocabulary; shared with the browser
│   │   ├── ffmpeg.ts               # the Opus/ogg pipeline both ways
│   │   ├── queueManager.ts         # sequential per-contact playback
│   │   ├── purge.ts                # the 48 h TTL sweep
│   │   └── recovery.ts             # rebuild the unread queue after a restart
│   ├── whatsapp/
│   │   ├── client.ts               # Baileys socket, reconnect ladder, send path
│   │   └── whitelist.ts            # THE SAFETY BOUNDARY
│   ├── server/
│   │   ├── routes.ts               # the REST surface
│   │   ├── auth.ts                 # HTTP Basic against a bcrypt hash
│   │   ├── bridgeLink.ts           # the token-gated /bridge namespace
│   │   ├── captivePortal.ts        # probe redirection while the hotspot is up
│   │   └── simulatorTransport.ts   # the browser end of the simulator
│   ├── net/netState.ts             # reads what the root agent publishes
│   ├── ipc/events.ts               # the IPC contract — edit this first
│   ├── processes/
│   │   ├── hardware-server.ts      # daemon 1
│   │   └── whatsapp-bridge.ts      # daemon 2
│   └── tests/                      # Vitest, node environment
├── public/                         # outside src/, built by Vite
│   ├── shared/                     # tokens.css, base.css, dom.ts, theme.ts, the mark
│   ├── admin/                      # parent settings
│   ├── simulator/                  # the virtual device
│   ├── portal/                     # first-boot setup, over the hotspot. No Socket.io
│   └── brand/                      # the living brand kit
├── deploy/                         # systemd units, install.sh, net-agent.sh, the debug kit
├── packaging/                      # Dockerfile.release, versions.env, fake-nmcli.sh
├── scripts/                        # dev server, sounds, doctor, release and image builders
├── docs/                           # this file, architecture, hardware, deployment, bring-up, brand
└── /data/                          # persistent, gitignored, on the device
    ├── config.json                 # generated during onboarding
    └── auth_info/                  # Baileys credentials
```
