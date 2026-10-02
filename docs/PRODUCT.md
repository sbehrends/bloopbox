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
   Nothing is captured yet.
2. At `recordThresholdMs` (150 ms) the short high **"pop"** plays, and **the microphone opens once
   it has finished**. The bip is the invitation to speak, not a report that recording began.

   > **Why capture waits for the bip.** The speaker sits centimetres from the microphone, so a bip
   > played over an open microphone is recorded into the head of every message. Opening capture
   > behind the cue keeps it out — at the price of anything said before the bip, which is the point
   > of making the bip prompt.
   >
   > It also means this threshold cannot be the tap/hold boundary, since the bip has to play long
   > before a tap and a hold are distinguishable. See step 6.

3. The child speaks.
4. The child releases. **The recording is not sent yet.** It stays open for a **carry-on window**
   (`resumeGraceMs`, 400 ms) with the lamp still **solid on**. Pressing the *same* button again
   inside that window continues the same message rather than starting a new one, so a grip that
   slips mid-sentence costs nothing. Nothing new has to be learned: solid means "still listening".
5. The window expires. The audio is converted to `.ogg` (Opus, `ptt: true`), the upward **"whoosh"**
   plays, and it is sent to WhatsApp. Once WhatsApp accepts it the lamp flashes 3× rapidly.

   The cue plays *after* the capture is finalised, for the same reason as step 2: played first, it
   would be recorded into the tail of every message.

   **One sound, not two.** There is no separate "delivered" sound: back to back with the whoosh,
   two cues read to a child as one confused noise rather than as two facts. Delivery is reported by
   the lamp alone. Only a *failure* adds a second sound — the "oops" — which is the case worth
   interrupting a child for.

6. **A press that never held the microphone open long enough to carry a message is a tap**, whether
   or not the bip played. With messages waiting it plays them (below); with nothing waiting it
   produces the low **"oops"** double-beep. A tap never opens a carry-on window, so the queue it
   asks for is not delayed by one.

   The boundary is `recordThresholdMs + minRecordingMs` — **1150 ms** with the shipped defaults. On
   a button with nothing waiting, a tap over 150 ms is preceded by the bip and opens a microphone
   that catches nothing, which is the accepted cost of a prompt bip; on a blinking one no
   microphone opens at all, so there is no bip either (see "Listening comes first").

   `minRecordingMs` is a full second because half a second is well inside what a toddler produces
   just by pressing things — a child playing with the buttons once sent a run of empty notes at
   500 ms, and every one of those arrives on a parent's phone as a real message. A second has to be
   held on purpose, and still fits a one-word "hola". The cost is that a very short word is a tap
   and answers "oops" — a refusal the child can hear and repeat, where a silent empty send is one
   nobody notices.

7. A press shorter than `debounceMs` (60 ms) is ignored entirely, silently — that is a toddler
   brushing past.
8. **One button at a time.** While a button is held, or its message is waiting out the carry-on
   window, the other two do nothing at all — no lamp, no sound, no second message — and a button
   that went down during that time stays ignored until it is let go, even if it is still held after
   the first one finishes. A child clutching one button while grabbing at the others keeps the
   message they are speaking. The one exception is the silent-mode chord (below): the other outer
   button can still join, but only within the tap boundary of step 6. Past it the child is sending,
   and the chord cannot cut them off.

   **The same holds while messages are playing.** Until the last note of the queue has finished,
   the other two buttons do nothing — the child is listening, and a bip, an "oops" or an open
   microphone beside the speaker would all land on top of the message. The chord waits too.

Bounds:

- A recording is capped at `audio.maxRecordingSeconds` (30 s), and **carrying on does not restart
  that ceiling** — pumping the button cannot grow a file in the RAM disk.
- Held time decides whether a press was a message; the finished file then has to contain *something*
  or the take is a failed capture and answers "oops". That floor is 150 ms and is not configurable —
  it separates "the microphone produced audio" from "the microphone produced nothing", which is not
  a feel judgement.
- **A send that fails is dropped, not retried.** There is no outbound queue, on purpose. Inbound is
  worth recovering because the sender was told it was delivered and nobody in the house knows it is
  missing; outbound is different — the person who recorded it is standing at the box, and a
  restarting box or its error lights are visible. Retrying would also mean writing a child's voice
  somewhere more durable than a RAM disk. The failure is logged as a `device fault` of kind `send`
  and shows in the health card's "Recently" list.

### Receiving a message

1. A voice note arrives from a **whitelisted** contact (§4). Anything else is dropped before it is
   downloaded. A chat with **disappearing messages** on is an ordinary chat here — its notes arrive
   like any other. A **view-once** note is ignored, by decision: only ordinary voice notes play. A
   note meant to be heard once does not fit a box that replays until the queue drains.
2. In audible mode a soft **"notify"** chime plays — **unless a note is already playing, or the
   child is recording**, when there is no chime at all. The assigned lamp starts **blinking slowly**
   (0.8 s on / 0.8 s off) either way. While a child records, the speaker is centimetres from the
   microphone and a chime would end up in their message, so the lamp alone says a note is waiting.

   > **Nothing plays over a note** — not the chime, the whoosh or the "oops". The speaker is one
   > output, so a cue cuts off whatever is playing, and a note cut off that way would be counted as
   > heard, deleted and reported read. The admin panel's speaker test is the one sound allowed to
   > interrupt, and a note it cuts off goes back to the front of its queue, still unread.

3. The child taps that button once. Every pending note from that sender plays **sequentially, oldest
   first**, separated by a short soft chime, and the lamp goes out once the queue finishes — or
   keeps blinking if another note arrived while it played.

   The note is **decoded to WAV when it arrives**, not when it is tapped. `aplay` reads no other
   container, and paying for an ffmpeg process at the tap would put a visible pause between a child
   pressing a blinking button and hearing anything. Arrival is the moment nobody is waiting.
4. If read receipts are enabled (`whatsapp.markPlayedAsRead`, on by default), playing a note marks
   it read upstream, so the person who recorded it sees their two ticks turn blue. It is optional
   because it also reports *when* a small child is at the box. A receipt still goes out if the
   WhatsApp bridge restarted in between (§8).

A played note's file is deleted immediately, which is what makes *present on disk* mean *unread*.

**"Delete for everyone" is honoured.** If the sender deletes a note the box is still holding, it
comes off the button and off the card, and the lamp follows what is left — out if that was the only
one. Nothing is marked read. Only the chat that sent it can take it back: the revoke goes through
the same whitelist, and must name a note queued on that chat's own button. A note that has
**already started playing is left to finish** — cutting a voice off mid-word is a stranger thing
for a child than hearing the end of it — and is then deleted as heard, like any other. A note later
in the same run is skipped.

### Listening comes first

**A button with notes waiting takes no message until they have been heard.** While its lamp is
blinking, that button only plays: a tap plays the queue, and a hold is refused with the "oops".

The reason is that the child cannot read a screen. The blinking lamp is the entire notice that
somebody spoke to them, and a hold straight through it sends a reply to something they never heard —
which the sender then reads as an answer. Holding the send gesture back until the queue has drained
is what keeps the exchange in order, and it costs nothing a child would miss: the thing standing in
the way is a message from someone they love.

The details, all of which are the difference between a rule and an annoyance:

- **No microphone opens, and no bip plays.** The capture is withheld at `recordThresholdMs`, where
  the bip would have been. Nothing is recorded and nothing is discarded — and a tap on a blinking
  button reaches the message with no bip in front of it.
- **The refusal waits for release.** At the threshold a press is not yet a hold: the boundary is
  `recordThresholdMs + minRecordingMs` and is only knowable when the button comes up. Answering at
  the threshold instead would turn every press over 150 ms into "that did not send" and make a
  blinking button impossible for a small child to play at all — a toddler's tap is often 300 ms.
- **It is per contact, not per box.** A note waiting from mama does not stop a message to papa.
- **It never takes away a message already being spoken.** The rule is read once, at the threshold,
  so a note landing mid-sentence cannot cancel the take in progress.
- **Nothing is said over a note that is playing.** A hold while the queue plays gets no "oops":
  cues and playback share the one output, so it would talk across the message. The lamp under the
  finger is the whole answer.
- **The block lifts when the queue drains**, which is the same instant the lamp goes out (§6). The
  lamp is therefore an exact statement of the rule: blinking means "listen first".
- Like every other refusal it is the "oops", so it is **suppressed in silent mode** (§7).

### A button with no contact

A button with no contact assigned (or a disabled one) takes no message, and says so the way
read-only does: a hold is refused with the "oops" at the moment the bip would have played, and
**the microphone never opens**, so a child's voice is never captured for a message that could not be
sent. A quick tap answers "oops" as any empty button does, and notes still waiting on it — assigned
before a contact was removed — still play with a tap. The unread rule above is checked first, so a
button still holding notes stays playable.

### Read-only mode

`mode.readOnly` switches the sending half off and leaves receiving untouched. Notes still arrive,
the lamp still blinks, tapping still plays them — only the hold-to-send gesture is gone. It is for
the box on a grandparent's sideboard, and for a child who should be able to hear everyone without
being able to reach them; the point is that the gesture is *structurally* unavailable, not that
somebody remembers not to use it.

A hold is **refused out loud, not ignored**. At `recordThresholdMs` — exactly where the "pop" would
have played — the low **"oops"** double-beep sounds instead and the microphone never opens. A box
that answered a hold with silence would look broken, and a small child's response to a box that
looks broken is to press harder.

The refusal is the whole answer to that press: releasing afterwards does nothing at all, and in
particular does **not** fall through to playing the waiting queue. Rewarding the gesture that was
just refused with the sound the child wanted is how a rule stops being a rule.

It is the existing "oops" rather than a cue of its own. To a child this is the same fact the
double-beep already carries — *that did not send* — and a second negative sound is one more thing to
learn for no extra information. Being the "oops" it is also **suppressed in silent mode**, so during
quiet hours a hold produces no sound at all and the lamp under the finger is the only feedback
(§7).

Read receipts are a separate decision. Whether playing a note reports back upstream is
`whatsapp.markPlayedAsRead` — a judgement about privacy, not about what the buttons do — so a
read-only box still sends them if that is switched on.

### Silent mode

Holding **Button 1 + Button 3** together for `silentComboMs` (3 s) toggles silent mode, confirmed by
a single slow left-to-right chase. That chase is the **only** thing silent mode ever shows: once it
has passed the box looks exactly like an audible idle box, with no lamp of its own (§6). Both
presses are swallowed the instant the chord forms, so a child mashing the outer buttons can never
send two voice notes; released early, nothing at all happens. The second button has to join within
the tap boundary (§1 step 6, 1150 ms by default) — later than that, the first press is a message
being sent and the second button is simply ignored.

It can also be scheduled — see §7.

---

## 2. Hardware

Full bill of materials, wiring diagram, GPIO assignments, the ALSA notes and the record of what has
been proven are in [`hardware.md`](./hardware.md). The shape of it:

| Component      | Selected spec                          | Purpose                                                        |
| -------------- | -------------------------------------- | -------------------------------------------------------------- |
| **Brain**      | Raspberry Pi Zero 2 W                  | Runs Linux and three units: two Node daemons plus a root network agent |
| **Buttons**    | 3× 30 mm illuminated arcade buttons, 3 V lamps | Button 1 left, 2 centre, 3 right                        |
| **Audio I/O**  | Waveshare WM8960 audio HAT             | Codec, mics and speaker amp on one board, over I²S              |
| **Power**      | 5 V 2.5 A micro-USB                    | Steady wall power — no power button, no battery                  |

Buttons are on BCM `GPIO17 / 27 / 22` with **firmware** pull-ups; LED drive lines are on
`GPIO23 / 24 / 25`. **The lamps are 3 V and hang directly off those pins** — no driver board — so
each one goes between its pin and ground and a HIGH lights it. The HAT occupies `GPIO2 / 3` (I²C)
and `18–21` (I²S), which collides with neither. The OS target is **Raspberry Pi OS Trixie 64-bit**,
forced by the GPIO addon's libgpiod v2 requirement.

**The one real device is the reference board** — a Pi 3B+ with the WM8960 HAT, three buttons and
three lamps — and on it every button, every lamp and audio in both directions are proven. **The
Pi Zero 2 W the bill of materials selects has not yet run any of it.** See
`hardware.md` § What is proven, and what is not.

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

### What the admin panel shows, and when

The panel is ordered by what a parent has to do next rather than by how the config is shaped, and
it **hides what cannot be used yet** — an unlinked box has nothing to assign a button to, and a
contact picker with no account behind it is a form that silently cannot work.

- **WhatsApp not linked** — only the WhatsApp card and *Advanced* are shown. Advanced stays
  reachable on purpose: audio and button timings need no account, and are what bring-up wants
  while pairing is still open.
- **While `connecting`** — the link buttons are withheld. Pressing one mid-connect starts a second
  attempt on a session that is still opening, which breaks both.
- **Linked** — Contacts, Sending (read-only mode), Quiet hours, WhatsApp, Wi-Fi, then Advanced
  (Audio, Button timings, Device health, Factory reset). *Read receipts* is a setting for a live
  account, so it appears only once the state is `connected`.
- **Activity sits above everything, in both layouts.** It is the only card that reports rather
  than asks — see below.
- **On the first link of a page's life the panel reloads itself**, because Contacts and its group
  picker were rendered from an account that did not exist yet.
- **Unlink and factory reset are two taps**, the second on a different button, so one stray tap
  cannot undo a family's setup.

### Activity — what each button has carried

The first card on the panel, above the settings. Per button: how many voice notes the box **sent**
and how much audio that was, how many **arrived** and how much audio *those* were, how many of them
the child has **listened to**, and when each direction last happened. Underneath, the totals and the
date counting started.

Three rules decide what the numbers mean, and each exists because the obvious alternative would
mislead:

- **Sent counts deliveries WhatsApp accepted, not presses.** A held button whose send failed already
  answered the child with the "oops"; counting it would tell a parent the button works, which is
  exactly the thing they opened the panel to rule out.
- **Received counts arrivals, not restores.** Every unheard note on the card is put back into its
  queue at boot, and this device restarts on every settings save — a total that counted those would
  climb on its own.
- **A note WhatsApp gave no duration for is counted but not timed**, and the card says how many.
  Treating an unknown as zero would quietly drag the total down with nothing on screen to explain it.

Totals live in `/data/stats.json`, beside the config but deliberately **not inside it**: a counter in
`config.json` would restart the daemon on every button press, and a stats file that fails to parse is
allowed to cost the totals and nothing else. *Reset the counters* zeroes them and restarts the clock.

The card also serves as the panel's only per-button diagnosis: three sends and no receives on one
button is a wrong number or a contact who has not replied, and nothing else on the page shows it.

### Device health, and turning the box off

An *Advanced* card, collapsed until asked for and polling only while it is open. It reports what the
board says about itself — the board model, SoC temperature, how long the machine has been powered
on, how long the *software* has been running (the two diverge on a settings save, and a service
uptime that keeps resetting is a crash loop), processor busy time and load, memory, free space on the
card and in the RAM disk, whether the configured sound card is actually present, the Wi-Fi network
and signal, and whether the **clock** has been set from the network yet ("synced", "not synced yet",
or "unknown" where the box cannot tell — a Pi has no clock battery, and quiet hours read that clock).
Every reading is nullable: a value the box cannot obtain is a dash or "unknown", never a zero or a
"no".

Under the readings, **Recently** lists the warnings and errors the hardware server has logged since
it last started, newest first — or says that nothing has gone wrong. When the box answers with an
"oops" and nothing else, this is the post-mortem a parent can reach without ssh. It is held in
memory, so it empties on every restart, which is also every settings save.

The same information is in `bloopbox-doctor`, which needs SSH — a tool a parent should
never need.

**Restart** and **Shut down** sit at the bottom of it, behind the same two-tap confirm as the factory
reset. The box has no power button, so "shut down, then unplug" is the safe way to move it between
rooms (§8). The daemon is unprivileged and cannot talk to systemd, so the request goes to the root
agent by the same enum-validated file channel a Wi-Fi join uses; the agent stops the units the
ordinary way, which is what flushes the counters and finalises anything mid-write. Where there is no
agent — any development machine — the panel says the box cannot power itself off rather than
reporting a failure.

**SSH access** sits below them: the ssh login this box made for itself on its first boot, shown
only when asked for and hidden again with the same button. A flashed card carries no password of
its own, because one image is copied onto many cards, so this is the one place the password can be
read — for whoever is helping debug the box, never needed for setup. On a box installed by hand, or
from a card built with an explicit password, it says so and shows nothing.
[`deployment.md`](./deployment.md) § The ssh password has the mechanism.

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

**There is no physical trigger** for forgetting the Wi-Fi or resetting the box. Recovery is the
admin panel's factory reset while the box is reachable, and `bloopbox-wifi.txt` or a freshly flashed
card when it is not.

### The config schema

Inferred from the Zod schema in [`src/config/schema.ts`](../box/software/src/config/schema.ts),
which is the single source of truth — there is no hand-written parallel interface. Values shown are
the shipped defaults, except `system`, `wifi` and `contacts`, which show a configured device.

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
    "ampVolumePercent": 100,
    "ampBoostDc": 5,
    "ampBoostAc": 5,
    "micGainPercent": 65,
    "enhanceCapture": true,
    "normalisePlayback": true,
    "maxRecordingSeconds": 30
  },
  "quietHours": {
    "enabled": false,
    "startTime": "20:00",
    "endTime": "07:00",
    "timezone": "UTC"
  },
  "buttons": {
    "debounceMs": 60,
    "recordThresholdMs": 150,
    "minRecordingMs": 1000,
    "resumeGraceMs": 400,
    "silentComboMs": 3000
  },
  "whatsapp": {
    "markPlayedAsRead": true
  },
  "mode": {
    "readOnly": false
  }
}
```

`contacts.*.target` is either a **phone number** with its country code (bare digits after
normalisation; `+`, `00`, spaces and dashes are accepted and stripped) or a **group JID** ending in
`@g.us`. A number left with a national trunk prefix and no country code is **rejected**, not guessed
at. The field was called `phone` in earlier versions and is migrated automatically.

Cross-field rules, enforced against the **merged** config on every save:

- `debounceMs` < `recordThresholdMs` — without a gap the bip could never precede a recording. The
  tap window itself is wider than this rule implies: it runs to `recordThresholdMs + minRecordingMs`
  (§1, sending, step 6)
- an enabled contact must have a target

Anything added after devices already had a `config.json` defaults itself, so a file written before
it still parses rather than failing validation, falling back to defaults and wiping the parent's
contacts. The `buttons`, `whatsapp` and `mode` sections use Zod's `.prefault({})`; the later
`audio` fields and `quietHours.timezone` carry field defaults.

`PUT /api/config` accepts **any subset of any section, to any depth** — except `version`,
`system.adminPasswordHash` and `system.configured`, which are not client-editable (of `system`, only
`hostname` is).

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
│  │ 3. bloopbox-net (root)     │  nmcli: state, AP up/down, join, forget;   │
│  │    deploy/net-agent.sh     │  reboot / poweroff                        │
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

- Maintains the Baileys WhatsApp connection and its credentials in `/data/auth_info`, written
  atomically so a power cut cannot unlink the box.
- Downloads inbound voice notes to the card (`/data/notes`, §8) and notifies process 1 over the IPC
  contract.
- Enforces the **whitelist** before downloading anything.

It is deliberately not bound to process 1: WhatsApp is an unofficial API on a release candidate, and
a crash there must not take the buttons and lights with it.

**Process 3 — `net-agent.sh`**, as root. The daemons run unprivileged under `ProtectSystem=strict`
and cannot talk to NetworkManager or systemd. The agent polls `nmcli` every 5 s and publishes one
JSON document the daemon reads; the daemon writes back a strictly enum-validated action (`ap-up` /
`ap-down` / `join` / `forget`, plus `reboot` / `poweroff` from the health card). One writer per
directory. **A missing or stale reading means *unknown*, and unknown is reported as "not down"** —
an outage is never invented from silence.

### The safety boundary

[`src/whatsapp/whitelist.ts`](../box/software/src/whatsapp/whitelist.ts) accepts **only** the
configured JIDs. Unknown numbers, groups nobody assigned, status broadcasts, newsletters and the
device's own echoed sends are all dropped, **before download**, so a stranger's audio never reaches
the disk. JIDs are normalised first, so a contact is recognised whichever of their linked devices
they send from, and under either of WhatsApp's addressing schemes (the phone number or the LID).

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

The suites that lock the behaviour in this document:

| Suite                                  | Verifies                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `button.test.ts`                       | Debounce, tap-versus-hold, the carry-on window, the lockout, the silent chord (§1) |
| `deviceController.test.ts`             | The wiring: cues, capture commit, refusals, the lamp going out when a queue drains (§1) |
| `deviceState.test.ts`                  | The observable state machine and its change events                        |
| `ledAnimator.test.ts`                  | Every §6 pattern's digital output, on fake timers                        |
| `ledPriority.test.ts`                  | The per-LED priority ladder where §6's patterns collide                   |
| `audioQueue.test.ts`                   | FIFO ordering when several notes arrive from one contact                  |
| `quietHours.test.ts`                   | The schedule, including a window that wraps past midnight (§7)            |
| `soundFiles.test.ts`                   | Every designed cue's source recording is committed (§7)                  |
| `purge.test.ts`, `recovery.test.ts`    | The 48 h TTL, and rebuilding the unread queue after a restart (§8)        |
| `mediaDownload.test.ts`, `readKeys.test.ts` | Bounded downloads, and read receipts surviving a bridge restart (§8) |
| `config.test.ts`, `configDefault.test.ts` | Validation, atomic writes, the fallback, and the `phone` → `target` migration (§3) |
| `networkSupervisor.test.ts`, `netState.test.ts` | When the hotspot goes up, and unknown is not an outage (§3, §4) |
| `whitelist.test.ts`, `bridge.test.ts`  | The safety boundary, written from "anything not assigned must not get through", and "delete for everyone" (§1, §4) |
| `stats.test.ts`                        | What the Activity card counts (§3)                                        |

The rest — the server surface and its auth boundary, the GPIO driver on a mocked opengpio, the
shell scripts, the architecture and documentation checks — and how the suite is run (fake timers,
real Express apps, the coverage ratchet) are in [`architecture.md`](./architecture.md) § Tests. The
decisions table there names the test that locks each design decision.

---

## 6. LED signal matrix

All lighting is binary (on/off) with spatial meaning: **Button 1 (left), Button 2 (centre), Button 3
(right)**. Timings are exported as `LED_TIMINGS` in
[`src/core/ledAnimator.ts`](../box/software/src/core/ledAnimator.ts), so the tests assert against
the same numbers the runtime uses.

| Device state | Pattern (1 / 2 / 3) | Animation and timing | Meaning |
| ------------ | ------------------- | -------------------- | ------- |
| **Booting** | `[1] ➔ [2] ➔ [3]` | Sequential chasing loop, 0.2 s per step | Services starting. Held for 2.6 s on purpose — status resolves instantly, so it would otherwise never be seen |
| **Connecting** | `[1]+[2]+[3]` | Synchronised blink, 0.5 s on / 0.5 s off | Joining Wi-Fi and establishing the WhatsApp socket |
| **Ready** | `[ ][ ][ ]` | All off | Online and connected, **audible or silent alike**. The usual state |
| **Silent mode transition** | `[1] ➔ [2] ➔ [3]` | One slow left-to-right pass, 0.5 s per step | Immediate feedback on entering or leaving silent mode — the single moment the mode is visible |
| **Setup hotspot up** | `[1]+[2]+[3]` | Double-pulse: on 0.15 s, off 0.15 s, on 0.15 s, then dark for the rest of a 2 s period | The open `bloopbox-XXXX` network is up and the portal is waiting. A rhythm rather than another rate, because it has to be told from Connecting across a room. **No cue** — it can happen at 3am |
| **Wi-Fi error** | `[1] [2] [3]` | All three **solid** | No network, and no hotspot up yet |
| **WhatsApp error** | `[1] [2] [ ]` | Lamps 1 and 2 **solid** | Network is fine; the WhatsApp session is unlinked or waiting for a scan |
| **Unread message** | `[X]` (that contact) | Blink 0.8 s on / 0.8 s off | Voice note(s) queued from that family member |
| **Recording** | `[X]` (pressed button) | **Solid on** | Capture in progress — including the carry-on window after release |
| **Message sent** | `[X]` (pressed button) | 3 fast flashes, 0.1 s on / 0.1 s off | Delivered to WhatsApp |

Three things this table cannot express on its own:

- **Solid always means something is wrong**, except on the single button being held. That is why the
  hotspot got a rhythm instead of a fourth blink rate.
- **Silent mode has no idle pattern.** A box being quiet in a dark bedroom should look quiet too.
  Only the transition above shows, including at the scheduled quiet-hours edges (§7).
- **These patterns collide.** A send flash wants lamp 1 at the same moment an unread message
  does. They are resolved **per lamp, first match wins**, by a fixed priority ladder — see
  [`architecture.md`](./architecture.md#the-led-priority-ladder). The setup hotspot deliberately
  outranks the Wi-Fi error: with the hotspot up, "the network is gone" is the cause and "setup is
  waiting for you" is the part a parent can act on.

---

## 7. Audio cues and silence

### The cues

| Cue           | Sound                                | Source    | When                                          |
| ------------- | ------------------------------------ | --------- | --------------------------------------------- |
| `boot.wav`    | Designed startup sound (825 ms)       | Recorded  | The device has come up                         |
| `pop.wav`     | High, ultra-short (90 ms)             | Tones     | A press has passed `recordThresholdMs`. **Plays before the microphone opens** |
| `whoosh.wav`  | Upward sweep                          | Tones     | A recording has been committed — the only sound a send makes |
| `oops.wav`    | Low double-beep                       | Tones     | Nothing was sent: a tap with nothing waiting, an empty capture, a failed send, or a refused hold — read-only, notes waiting, no contact (§1) |
| `chime.wav`   | Short soft chime                      | Tones     | Separator between queued notes during playback |
| `notify.wav`  | Designed arrival sound (318 ms)       | Recorded  | A voice note arrived                           |

`boot.wav` exists because on a box with no screen, the noise it makes when power returns is the only
way a parent across the room learns it came back. `notify.wav` is the audible half of an arrival;
the blinking lamp is the half that stays.

**The WAVs are generated, not committed** — `npm run sounds` builds all six, and a fresh clone has
none. Two of them are **designed recordings**, committed as MP3 under `box/software/src/audio/samples/`
and mastered by that script; the rest are synthesised from tone recipes in it. Both halves write one
WAV per cue into the same directory under the cue's own name, so nothing downstream — the HAL, the
`/sounds` route, the simulator — can tell which kind a cue is. `aplay` on the device reads WAV and
nothing else, which is why even the designed sounds are transcoded rather than shipped as authored.
`samples/` also holds `success.mp3`, the source of the retired "delivered" cue (§1, sending,
step 5): unreferenced, and kept because a checkout can regenerate a WAV but not a recording.

Mastering is a decision in `scripts/generate-sounds.ts`, not a filter's side effect:

- **Every cue is trimmed to its audible span.** The recordings arrive padded with seconds of
  silence, and a cue file's length is dwell time on the audio device — untrimmed, a cue would hold
  the speaker for seconds to say something that takes a few hundred milliseconds, and the chime
  separating two queued notes would land on top of it.
- **Peak level is declared per cue on one 0–1 scale**, shared with the synthesised tones' `gain`. The
  designed sounds and the beeps come out of the same small speaker next to a child's ear, so a cue
  twice as loud as its neighbour is a defect however good it sounds alone.

### Silence and quiet hours

- **Manual toggle:** hold Button 1 + Button 3 together for `silentComboMs` (3 s).
- **Scheduled quiet hours:** a start and end time from the admin panel, 20:00 → 07:00 when switched
  on. The window **wraps past midnight**, which is the normal case for a child's bedroom rather
  than an edge case, and is half-open — quiet at exactly 20:00, audible at exactly 07:00.
- **The window is read in `quietHours.timezone`, an IANA zone name, not on the device's clock.**
  That clock is not neutral: Raspberry Pi OS defaults to **Europe/London** (measured on a real
  device, 2026-08-17), so an unset zone means the schedule silently runs on somebody else's
  afternoon. The admin panel offers a picker and names the browser's own zone underneath it.
- **Quiet hours ship disabled**, because the only zone the device can honestly default to is UTC
  and a window in the wrong zone is worse than no window: the box goes silent at the wrong hours,
  and on a device with no screen that is indistinguishable from a broken one. Switching it on and
  choosing a zone is one visit to the admin panel.
- The chord toggles the **effective** state, so during scheduled quiet hours a parent can force
  audio back on without editing the schedule. **The override lasts until the next boundary**: sound
  stays on for the rest of that window, and the next window starts silent as scheduled. The
  schedule is applied only when it changes its mind, never re-asserted in between — re-asserting it
  would take the sound away again before a parent had finished the bedtime story.

Behaviour while silent:

| Path                       | Silent mode                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| Inbound notification chime | **Suppressed.** The lamp blinks silently                            |
| Boot sound                 | **Suppressed.** Power returns at whatever hour the grid decides; the boot LED chase still runs |
| Record start / stop cues   | **Suppressed**                                                     |
| Oops                       | **Suppressed**                                                     |
| **Playback of a voice note** | **Not suppressed.** Always plays at the configured volume, with the separator chime between notes |
| LED patterns               | **Unaffected, and nothing added.** The mode shows only as the one-off transition chase |

Playback is never silenced because a child who taps a light expects to hear something.

One consequence worth knowing: because the "oops" is suppressed, **during quiet hours a failed send
produces no sound at all**, and the missing send flash is the only indication. The same applies to
every refused hold (§1): at night the child gets the lamp under their finger and nothing else.

**Loudness is four numbers, not one**, because the output chain has four stages and they multiply:
`speakerVolumePercent` is the digital DAC volume, `ampVolumePercent` the analogue output stage, and
`ampBoostDc` / `ampBoostAc` the class-D amplifier boost. Measured on a real WM8960 HAT on
2026-08-17, the last three powered up at −20 dB, 0 and 0 — leaving the box roughly 26 dB quieter
than the hardware allows, with no setting of the first able to reach it. All four are in the admin
panel because the top of the range is not automatically right: the boosts trade headroom for
distortion, which depends on the speaker and the enclosure. **Test speaker**, in the Audio card,
plays the start-up cue on demand so the result can be judged by ear, and is the one sound that
ignores silent mode — someone tuning the box is asking a direct question.

**There is no separate volume cap.** A ceiling a parent sets once, behind the same save button as
the volume it caps, protects nothing — anyone who can raise the volume can raise the cap in the
same click — and all it adds is a save that fails over a field the parent did not touch. A ceiling
only earns a second field if it is harder to change than the thing it caps. The hard ceiling is
`max(100)` on the volume itself.

---

## 8. OS protection and storage safety

| Measure | What it does |
| ------- | ------------ |
| **RAM disk for outbound audio (`tmpfs`)** | Captures, ffmpeg conversion and decoded playback buffers live in `/run/bloopbox`, via `RuntimeDirectory=` in both units. `/run` is already a tmpfs, so **nothing the child records** ever touches the card or can fill it |
| **Inbound notes on the card** | Arriving notes go to `/data/notes` so an unheard one survives a power cut — the most likely restart in a child's room. Bounded by the same 48 h purge, and deleted the moment they are played. See §1 |
| **Inbound downloads bounded** | A note is refused over 2 MB — declared or delivered — and an attempt times out after 60 s, with two retries on a network failure. It is written as `<name>.part`, synced, and renamed into place only when complete, so a power cut mid-download never leaves something boot recovery would take for an unread note |
| **Automatic purge (TTL)** | Audio is deleted 48 h after creation whether it has been heard or not, swept hourly — except a note still queued behind a blinking lamp, which waits for the tap rather than vanishing from under it (the queue itself does not outlive a restart past the 8 h recovery window). Playback deletes a note immediately |
| **Atomic writes** | `config.json`, `stats.json` and the WhatsApp credentials are written to a temp file, `fsync`ed, renamed into place and the directory `fsync`ed, so a power cut leaves the old file or the new one, never neither. A half-written config would brick the device; half-written credentials would silently unlink it |
| **Shut down without pulling the plug** | The box has no power button. *Device health* → **Shut down** stops the units the ordinary way, which flushes the activity counters and finalises anything in flight. See §3 |
| **Fallback on invalid config** | A missing or corrupt `/data/config.json` falls back to `config.default.json` **in RAM** and boots into onboarding. It never crashes the daemon |
| **Hardware watchdog** | BCM watchdog plus its systemd half, 15 s, so a wedged device reboots itself |
| **Read-only root filesystem (`overlayfs`)** | **Specified, not built.** `/data` currently lives *on* the root filesystem, so enabling the overlay would send every setting and the WhatsApp credentials into a RAM overlay, to vanish on reboot — a worse failure, and a silent one. It needs `/data` on its own partition first. See `PENDING.md` |

Notes are **rebuilt into the unread queue at boot**, within an 8-hour window, by scanning the notes
directory. Because that directory is on the card, this survives a **power cycle**, not only a daemon
restart.

The notes have to be on the card for that to work. Playback *deletes* a note's file, which makes
"present on disk" the unread flag itself; there is no second read-state store. A notes directory in
RAM would lose, in one power cut, both the audio and the record that it had ever existed — and
WhatsApp will not re-deliver a message it has already handed over, so the note would be
unrecoverable.

The privacy cost was weighed, not waved through. `/data` already holds `auth_info`, the linked
WhatsApp session — anyone who can take the card can already speak as this account, which is worse
than reading one voice note. Against that, a note is deleted the instant it is played, swept at 48 h
regardless, and **the child's own recordings still never leave RAM**. The promise is "nothing the
child records is ever at rest", not "no audio is ever at rest".

Each inbound note has one small companion on the card, `wa-<i>-<id>.key`: the WhatsApp message key
(the chat's address, the message id) needed to send the sender their read receipt, so the receipt
survives a restart of the WhatsApp bridge. It is kept on the same terms as the audio: deleted when
the receipt is sent or the sender deletes the note, and otherwise purged with the audio at 48 h.

---

## 9. Directory layout

The box software, `box/software/` in the monorepo. The documentation lives in `docs/` at the
repository root; the root [`README.md`](../README.md) has the monorepo layout.

```text
box/software/
├── package.json                    # "type": "module" — ships in the release, load-bearing
├── tsconfig.json                   # src/ + scripts/: node libs, no DOM
├── tsconfig.web.json               # public/: DOM libs, whitelisted shared imports
├── tsconfig.build.json             # emit config
├── vite.config.ts                  # four UI entries, bundled with Rolldown
├── vitest.config.ts                # includes the coverage ratchet
├── config.default.json             # fallback, resolved relative to dist/
├── src/
│   ├── config/
│   │   ├── schema.ts               # Zod schema — the source of truth for every config type
│   │   ├── configManager.ts        # load / validate / merge / write
│   │   └── atomicWrite.ts          # temp file, fsync, rename, fsync the directory
│   ├── core/                       # pure, I/O-free domain logic
│   │   ├── buttonInterpreter.ts    # edges → intents: tap, record, carry on, chord
│   │   ├── ledAnimator.ts          # state → LED frames, and the priority ladder
│   │   ├── deviceState.ts          # the observable state, in one place
│   │   ├── networkSupervisor.ts    # when the setup hotspot goes up
│   │   ├── quietHours.ts           # the schedule, wrapping past midnight
│   │   └── deviceController.ts     # the wiring; I/O only through what it is handed
│   ├── hal/
│   │   ├── types.ts                # the interface: buttons, LEDs, audio in and out
│   │   ├── index.ts                # factory; loads opengpio via dynamic import()
│   │   ├── gpioDriver.ts           # the real Pi; proven on the reference board
│   │   ├── settledLine.ts          # settles switch bounce on a button line
│   │   ├── simulatorDriver.ts      # browser canvas over Socket.io
│   │   └── mockDriver.ts           # tests; records every setLed with a timestamp
│   ├── audio/
│   │   ├── samples/                # the designed cue recordings, MP3
│   │   ├── sounds/                 # generated cue WAVs — not committed
│   │   ├── cues.ts                 # the cue vocabulary; shared with the browser
│   │   ├── soundFiles.ts           # where each cue's WAV and source recording live
│   │   ├── directories.ts          # where audio lives: RAM for captures, the card for notes
│   │   ├── ffmpeg.ts               # the Opus/ogg pipeline both ways
│   │   ├── process.ts              # runs ffmpeg and amixer, each with a deadline
│   │   ├── queueManager.ts         # sequential per-contact playback
│   │   ├── purge.ts                # the 48 h TTL sweep
│   │   ├── recovery.ts             # rebuild the unread queue after a restart
│   │   └── testNote.ts             # the simulator's injected notes
│   ├── whatsapp/
│   │   ├── bridge.ts               # the bridge's decisions: whitelist, download, receipts
│   │   ├── client.ts               # Baileys socket, reconnect ladder, send path
│   │   ├── whitelist.ts            # THE SAFETY BOUNDARY
│   │   ├── authState.ts            # WhatsApp credentials, written atomically
│   │   ├── mediaDownload.ts        # bounded downloads onto the card
│   │   ├── readKeys.ts             # the read-receipt key beside each note
│   │   ├── holdUntilReady.ts       # holds deliveries until the whitelist has arrived
│   │   ├── privacy.ts              # masks addresses in logs
│   │   └── statusCode.ts           # why Baileys closed the socket
│   ├── server/
│   │   ├── routes.ts               # the REST surface
│   │   ├── auth.ts                 # HTTP Basic against a bcrypt hash
│   │   ├── csrf.ts                 # cross-site request and framing defences
│   │   ├── bridgeLink.ts           # the token-gated /bridge namespace
│   │   ├── captivePortal.ts        # probe redirection while the hotspot is up
│   │   ├── socketListeners.ts      # Socket.io on both HTTP listeners
│   │   ├── binary.ts               # binary payloads on the Socket.io transport
│   │   └── simulatorTransport.ts   # the browser end of the simulator
│   ├── net/netState.ts             # reads what the root agent publishes
│   ├── stats/statsStore.ts         # what each button has carried, on the card
│   ├── system/
│   │   ├── systemInfo.ts           # temperature, uptime, load, memory, card space
│   │   ├── recentEvents.ts         # the health card's "Recently" list
│   │   ├── sshAccess.ts            # the first-boot ssh login, for the health card
│   │   └── power.ts                # asks the root agent to reboot or shut down
│   ├── ipc/
│   │   ├── events.ts               # the IPC contract — edit this first
│   │   ├── noteFiles.ts            # how an inbound note is named on the card
│   │   └── payload.ts              # narrowing untrusted payloads
│   ├── processes/
│   │   ├── hardware-server.ts      # daemon 1
│   │   ├── whatsapp-bridge.ts      # daemon 2
│   │   └── shutdown.ts             # an orderly, bounded exit for both
│   ├── types/opengpio.d.ts         # the slice of opengpio the GPIO driver uses
│   ├── logger.ts                   # pino, a child logger per subsystem
│   └── tests/                      # Vitest, node environment
├── public/                         # outside src/, built by Vite
│   ├── shared/                     # tokens.css, base.css, dom.ts, theme.ts, the logo files
│   ├── admin/                      # parent settings
│   ├── simulator/                  # the virtual device
│   ├── portal/                     # first-boot setup, over the hotspot. No Socket.io
│   └── brand/                      # the living brand kit
├── deploy/                         # systemd units, install.sh, net-agent.sh, the debug kit
├── packaging/                      # Dockerfile.release, versions.env, fake-nmcli.sh
└── scripts/                        # dev server, sounds, doctor, release and image builders

/data/                              # persistent, on the device's card
├── config.json                     # generated during onboarding
├── stats.json                      # the Activity card's totals
├── auth_info/                      # Baileys credentials
├── notes/                          # inbound notes and their read-receipt keys
└── ssh-password                    # the first-boot ssh login, when the box made one
```
