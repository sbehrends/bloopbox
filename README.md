# bloopbox

A screenless WhatsApp voice messenger for children aged 2–5. Three illuminated arcade buttons,
each assigned to one family member. **Hold to send a voice note, tap to play what arrived.**

No screen, no menus, no scrolling, and nothing for a toddler to get lost in. A parent sets the
device up once from a phone or laptop; after that the child's entire interface is three buttons
and three lights.

It runs on a Raspberry Pi Zero 2 W as two Node.js daemons and speaks to WhatsApp as an ordinary
linked device, so the people at the other end need nothing but WhatsApp.

## Status

Under active development. Everything is built and tested against a **browser-based hardware
simulator**, so no Pi is needed to work on it — and the physical device does not exist yet.

- [x] Project foundation, tooling, validation gate
- [x] Hardware server: config, LED state machine, HAL, audio pipeline, simulator
- [x] WhatsApp bridge (Baileys), people and groups as targets
- [x] Setup hotspot and captive portal for first boot
- [x] Packaging: arm64 release builds, an installer, systemd units, a flashable SD card image, CI
- [ ] Hardware bring-up: the GPIO driver, audio and WhatsApp pairing against real hardware
      (waiting on the parts)

The build pipeline is verified against arm64 Debian Trixie containers, up to booting both daemons
out of a mounted SD card image, and WhatsApp has been exercised in both directions against a real
account. What has **never** run is any of it on a Pi with buttons and a speaker attached — pin
numbers, LED polarity, ALSA device names and the hotspot are all unproven. See
[`PENDING.md`](./PENDING.md) for the honest list.

## Repository layout

A monorepo. The box is what exists; the rest is scaffolding for what comes next.

```
box/
├── software/     the two daemons, the four browser UIs, packaging, deploy  ← the project today
└── hardware/     enclosure models and PCB. Empty; docs/hardware.md is the reference
website/          the site: a statically exported Next.js home page and build manual
docs/             all documentation, for every package
```

There is no root `package.json` and no npm workspaces. **Each package's npm commands run from its
own directory** — `box/software/` for the device, `website/` for the site. See
[`box/software/README.md`](./box/software/README.md) and [`website/README.md`](./website/README.md).

## What you need

| Component  | Part                                    |
| ---------- | --------------------------------------- |
| Brain      | Raspberry Pi Zero 2 W                   |
| Buttons    | 3× 30 mm illuminated arcade buttons, 3 V lamps |
| Audio      | Waveshare WM8960 audio HAT              |
| Speakers   | 1–2× small 8 Ω, 2–5 W — often bundled with the HAT |
| Power      | 5 V 2.5 A micro-USB                     |
| Storage    | 8 GB+ microSD card                      |

Wiring, GPIO pins and the enclosure layout are in [`docs/hardware.md`](./docs/hardware.md).

**The audio HAT is the one part that changes the install command.** It needs
`--audio-hat wm8960`, and there is no sound card at all until the reboot that follows — see
[Install](#install) below. A USB speakerphone works in its place in principle, and the code still
supports it, but nothing about that path has been measured on hardware; the HAT has.

The OS target is **Raspberry Pi OS Trixie, 64-bit**, and that is a constraint rather than a
preference: the GPIO addon compiles against the libgpiod v2 API, which Bookworm does not have.

## Install

> **Building one for the first time?** The website carries a step-by-step manual written for a
> parent rather than for this repository — the parts with links, what is on the back of an arcade
> button, the pin map as a picture, and the Wi-Fi and WhatsApp setup with screenshots. It is
> `website/app/manual/`, served at `/manual/`. What follows here is the terse version.

### On a Raspberry Pi

The easiest route is a card that needs no install step at all. On a Linux machine with root:

```bash
cd box/software
npm install
sudo ./scripts/build-sd-image.sh --audio-hat wm8960 \
  --wifi-ssid Home --wifi-psk secret --wifi-country DE
```

Flash the resulting `release/bloopbox-*-sd.img.xz` with Raspberry Pi Imager (**Use custom**) or
`dd`, put the card in, and power up. The Wi-Fi flags are optional — without them the device raises
its own setup hotspot on first boot (below).

**Match the flags to the board you actually built.** `--audio-hat wm8960` writes the codec's
overlay and its ALSA settings; add `--no-leds` for a board with no lamps wired. Both are baked into
the image, so an image for one board is not an image for another.

If the Pi is already running Raspberry Pi OS Trixie and reachable over ssh, install a release
tarball instead:

```bash
cd box/software
npm run release                                    # arm64 tarball, built in Docker
scp release/bloopbox-*-linux-arm64.tar.gz pi@bloopbox.local:
ssh pi@bloopbox.local 'tar xzf bloopbox-*.tar.gz \
  && sudo ./bloopbox-*/install.sh --audio-hat wm8960 && sudo reboot'
```

The Pi compiles nothing — the tarball carries its own `node` binary and a `node_modules` built for
arm64. Re-running `install.sh` is an upgrade and leaves settings and the WhatsApp pairing alone.

> **The reboot is not optional, and it is not just for the audio.** `--audio-hat wm8960` adds the
> codec's device-tree overlay, and `install.sh` adds the button pull-ups (`gpio=17,27,22=ip,pu`) —
> both are firmware settings applied before userspace starts. Until that reboot there is **no sound
> card**, and the buttons read garbage. That is the usual explanation for a fresh install where
> "nothing works".

Once it is back up, confirm the sound card exists before anything else:

```bash
sudo bloopbox-audio-test
```

Then check it over ssh:

```bash
sudo bloopbox-doctor
```

For a **first** device, follow [`docs/hardware-bringup.md`](./docs/hardware-bringup.md) rather than
improvising: it sequences the gates so only one unverified subsystem is in play at a time.
[`docs/deployment.md`](./docs/deployment.md) is the full deployment reference.

### On your computer

No hardware needed — see [Developing](#developing).

## Setting it up

### First boot

A device that cannot reach a network raises its own **open Wi-Fi hotspot** called
`bloopbox-XXXX` (the last four of the Pi's serial), after 20 seconds on a device that has never
been set up. The three lights double-pulse together while it is up.

Join that network from a phone. The setup page should open by itself, the way a hotel Wi-Fi
sign-in page does; if it does not, open `http://10.42.0.1`. It asks for:

1. Your home Wi-Fi network, from a list, and its passphrase.
2. A **settings password**, at least 6 characters. This is what protects the admin panel
   afterwards — the child never needs it.

Accepting those tears the hotspot down and joins your network, so the page you are looking at
dies. That is expected; the lights are the only feedback across the switch (double-pulse →
blinking together → dark).

If you built the card with `--wifi-ssid`, or wrote `bloopbox-wifi.txt` on the boot partition, the
device joins your network directly and never raises a hotspot. Open the admin panel and set the
settings password there instead.

### The admin panel

```
http://bloopbox.local
```

That is the whole address — no port, no path. `/admin/` still answers, for links and bookmarks
already written down, and `:3000` still answers alongside `:80` for a box where the privileged
bind did not happen.

Sign in with the settings password (any username). Seven sections:

| Section        | What it does                                                            |
| -------------- | ----------------------------------------------------------------------- |
| Contacts       | Who each of the three buttons talks to, and whether it is enabled       |
| Audio          | Speaker volume, the amplifier stages, mic gain, maximum recording length |
| Quiet hours    | A nightly window where the device stops making cue noises, and its timezone |
| Button timings | Tap-vs-hold thresholds, debounce, the carry-on window, the silent chord |
| Wi-Fi          | Which network the device joins                                          |
| WhatsApp       | Pairing, unlinking, the group picker, and read receipts                 |
| Factory reset  | Wipes settings and the WhatsApp pairing, back to a fresh box            |

**Audio** and **Button timings** are collapsed by default — the settings inside them are the ones a
parent sets once. Audio carries four output controls, not one: `speakerVolumePercent` is the day-to-day
knob, and below it `ampVolumePercent` plus the two class-D boosts drive the amplifier stages. On the
WM8960 those lower stages power up **26 dB down**, so a box that sounds weak at full volume is
almost always this rather than a broken speaker. **Test speaker** plays the boot cue so the result
can be heard; the settings are read at boot, so a change is only audible after the save restarts the
daemon.

**Read receipts** lives inside the WhatsApp section: whether the child playing a message turns the
sender's two ticks blue. On by default, because on a screenless device it is the only way the person
who recorded it learns it was heard — and off for parents who would rather not broadcast when a
small child is at the box.

**Saving anything restarts the device.** Configuration is read once at boot rather than watched,
so a save exits the daemon cleanly and systemd brings it straight back with the new values. The
panel shows "restarting", polls, and reloads itself after a couple of seconds.

### Linking WhatsApp

Sending and receiving need a linked WhatsApp account. In the admin panel's **WhatsApp** section
there are two routes:

- **Scan the QR.** On your phone: WhatsApp → Settings → Linked devices → Link a device.
- **Link with a phone number.** Enter your number, press _Get a pairing code_, then on your phone
  choose "Link with phone number instead" and type the 8-character code. Usually easier than
  pointing a camera at a laptop.

Codes expire after about 20 seconds and the panel rotates them automatically.

> The account you link becomes the identity the device sends as. Use a spare number if you would
> rather not have a toddler's device speaking as you.

### Assigning the three buttons

Under **Contacts**, give each button a name and a target. A target is either:

- **a phone number**, with its country code — `+54 9 11 5555 5555`, `005491155555555` and
  `5491155555555` are all the same person, and all accepted. A number written with a national
  trunk prefix and no country code is **rejected** rather than guessed at, because guessing would
  reach a stranger.
- **a group**, chosen from the picker. Group ids cannot be typed from memory, so the picker is fed
  by the linked account and only appears after pairing.

Assigning a group means **everyone in that group** can send to the child, and everyone in it hears
what the child sends. That is the deliberate reading of "put the family chat on button 2".

Only the assigned targets can reach the device. Unknown numbers, groups nobody assigned, status
broadcasts and newsletters are all dropped before any audio is downloaded.

Save, wait for the restart, and the lights go dark — which means ready.

## Using it

### Hold to send, tap to play

| What the child does                | What happens                                                     |
| ---------------------------------- | ---------------------------------------------------------------- |
| Holds a button                     | The light goes solid at once, then a "pop" invites them to speak  |
| Lets go                            | A "whoosh", three quick flashes, and the note is on its way       |
| Lets go by accident, presses again | The **same** message carries on — see below                      |
| Taps a blinking button             | Plays everything waiting from that person, oldest first           |
| Taps a dark button                 | A low "oops" double-beep. Nothing was sent                        |
| **Holds a blinking button**        | A low "oops". **That button listens first** — see below           |
| Brushes a button                   | Nothing at all                                                   |

**The bip is an invitation, not a receipt.** The microphone opens only once the pop has finished
playing, because the speaker sits centimetres from the microphone and a bip that plays over an open
mic ends up recorded into the head of every message. The cost is that whatever is said before the
bip is lost — which is exactly why the bip is prompt.

The boundaries between those are all configurable under **Button timings**, because the right feel
depends on the child and on the switches. Shipped defaults:

| Setting             | Default | Means                                                            |
| ------------------- | ------- | ---------------------------------------------------------------- |
| `debounceMs`        | 60 ms   | Shorter than this is a brush, and is ignored entirely            |
| `recordThresholdMs` | 150 ms  | How long the child waits for the bip before the microphone opens |
| `minRecordingMs`    | 1000 ms | The least audio a take must carry to be a message rather than a tap |
| `resumeGraceMs`     | 400 ms  | How long a released recording stays open, waiting to carry on    |
| `silentComboMs`     | 3000 ms | How long buttons 1 + 3 must be held together to toggle silence   |

**Nothing here is the tap/hold boundary on its own.** That boundary is `recordThresholdMs +
minRecordingMs` — **1150 ms** with the shipped defaults — so a press under it plays the waiting
queue and one over it sends. The minimum was doubled on purpose: at half a second, a child playing
with the buttons sent a run of empty notes, and every one of those lands on a phone as a real
message. A full second has to be held on purpose. `recordThresholdMs` sits *inside* the tap window: crossing it opens
the microphone, but a take that never reaches `minRecordingMs` is still treated as a tap and
thrown away. That split is what lets the bip be prompt without making every short press a
message. See [`docs/architecture.md`](./docs/architecture.md) for the full ladder.

**A button with messages waiting will not record.** While a light is blinking, that button only
plays: tap it and you hear what arrived, hold it and you get the "oops" instead of sending. The
child cannot read a screen, so that blinking light is the only notice that somebody spoke to them —
and holding straight through it would send a reply to something they never heard. The light going
out is also the block lifting, so there is one thing to learn: **blinking means listen first.** It
is per person, not per box; the other two buttons still send.

**The carry-on window is the one worth knowing about.** A toddler's grip slips. Releasing the
button does not send the message immediately — it stays open for `resumeGraceMs`, and pressing the
**same** button again inside that window continues the same recording instead of starting a new
one. Nothing new to learn: the light stays solid the whole time, so **solid means "still
listening"** and the whoosh still means "gone".

Recordings are capped at `maxRecordingSeconds` (30 by default), and pressing the button again
cannot extend a message past that ceiling.

### Silent mode

Holding **buttons 1 and 3 together for three seconds** toggles silent mode, confirmed by a slow
left-to-right chase. That chase is the only thing you ever see of it: once it has passed, a silent
box looks exactly like an audible one — no light of its own, because a box being quiet in a dark
bedroom should look quiet too. It can also be scheduled — **Quiet hours**, 20:00 to 07:00 once you
switch it on, which wraps past midnight as you would expect.

It ships **off**, and the admin panel asks for a timezone alongside the times. A fresh image runs
on whatever Raspberry Pi OS picked — Europe/London — so a schedule enabled before you say where you
live would go quiet at the wrong hours, which on a device with no screen looks exactly like a
broken one.

Silent mode suppresses the *cue noises*: the inbound chime, the record start and stop cues, the
"oops". It does **not** suppress playback — tapping a blinking button always plays at the
configured volume, because a child who taps a light expects to hear something.

Volume is always clamped to the configured cap, whatever else is set. This sits next to a small
child's ears.

### What the lights mean

Three lights are the device's entire vocabulary. **Solid always means something is wrong.**

| Lights                                        | Means                                                    |
| --------------------------------------------- | -------------------------------------------------------- |
| Chase left to right, 0.2 s a step             | Starting up                                              |
| All three together, 0.5 s on / 0.5 s off      | Joining Wi-Fi and linking WhatsApp                       |
| All off                                       | Ready and idle, silent mode or not. The normal state      |
| One button blinking, 0.8 s on / 0.8 s off     | A voice note is waiting from that person — tap it        |
| One button solid                              | That button is recording right now                       |
| One button, three quick flashes               | That message was delivered                               |
| A slow left-to-right pass, once               | Silent mode just went on, or just came off               |
| All three double-pulse: on-off-on, then dark  | The setup hotspot is up and the setup page is waiting    |
| **All three solid**                           | No network, and no hotspot yet                           |
| **Buttons 1 and 2 solid**                     | Network is fine; WhatsApp is unlinked or waiting for a scan |

The double-pulse is a rhythm rather than another blink rate on purpose: people tell a heartbeat
from a blink across a room far more reliably than they tell 0.5 s blinking from 1.5 s blinking.
And it deliberately makes **no sound** — the hotspot can come up at 3am because the router died,
and a chime in a child's bedroom is the worse failure.

When two of these could apply to the same light at once, the device resolves it per-light with a
fixed priority ladder — see [`docs/architecture.md`](./docs/architecture.md#the-led-priority-ladder).

### When something is wrong

On the device, over ssh:

```bash
sudo bloopbox-doctor        # is everything present and running?
sudo bloopbox-debug on      # persistent journal, debug logging, a 10s sampler — expires in 24h
sudo bloopbox-diagnostics   # bundle the whole picture into one redacted tarball
```

If the device is offline and the admin panel is therefore unreachable, the way back in is the boot
partition: pull the card, write `bloopbox-wifi.txt` with `ssid=` / `psk=` / `country=`, and boot.
Any laptop can read that partition.

## Safety and privacy

- **Only assigned targets can reach the device.** Filtering happens before download, so a
  stranger's audio never reaches the disk. `src/whatsapp/whitelist.ts` is the boundary, and
  `src/tests/whitelist.test.ts` is written from the position that anything not explicitly assigned
  must not get through.
- **Recordings live in RAM.** `/run/bloopbox` is a tmpfs, so a child's voice is never written to
  the SD card. Unread audio is deleted after 48 hours regardless.
- **Settings writes are atomic** (temp file → `fsync` → `rename`), so losing power mid-save cannot
  corrupt a parent's configuration or brick the device.
- **The admin API is password-protected**, except while the device is still being set up — the
  onboarding flow has to be able to set the first password. See the watch items in `PENDING.md`
  for the accepted risks around that.
- **A read-only root filesystem** (`PRODUCT.md` §8) is specified but **not built**: `/data` still
  lives on the root filesystem, so enabling the overlay would make every setting and the WhatsApp
  pairing evaporate on reboot. It needs a dedicated partition first.

## Developing

Everything is developed against a **browser-based hardware simulator**, so no Raspberry Pi is
needed:

```bash
cd box/software
npm install
npm run sounds      # the cue WAVs are generated, not committed
npm run dev:hw      # terminal 1 — daemon + API on :3000
npm run dev:web     # terminal 2 — the four UIs on :5174
```

Then open <http://localhost:5174/simulator/>.

There is no root `package.json` — every npm command runs from `box/software/`.
[`box/software/README.md`](./box/software/README.md) is the full development guide: the gate, the
simulator's event injector, the tests, every script, and where things live.

## Documentation

| Document                                                   | What it is                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| [`box/software/README.md`](./box/software/README.md)       | Development: the gate, the simulator, the tests, every script     |
| [`box/hardware/README.md`](./box/hardware/README.md)       | What belongs in the hardware folder, and the enclosure's constraints |
| [`website/README.md`](./website/README.md)                 | The site: the home page, the build manual, and the rule keeping it decoupled |
| [`docs/PRODUCT.md`](./docs/PRODUCT.md)                     | The behavioural specification. `§` citations in the source point here |
| [`docs/architecture.md`](./docs/architecture.md)           | How the software is put together, and the decisions behind it    |
| [`docs/hardware.md`](./docs/hardware.md)                   | Bill of materials, wiring, GPIO pins, the enclosure              |
| [`docs/deployment.md`](./docs/deployment.md)               | Releases, the installer, the SD image, systemd, CI               |
| [`docs/hardware-bringup.md`](./docs/hardware-bringup.md)   | The gated plan for the first real device, and the debugging kit   |
| [`docs/BRAND.md`](./docs/BRAND.md)                         | Visual direction and the design system's locked decisions        |
| [`CLAUDE.md`](./CLAUDE.md)                                 | Conventions, toolchain traps, and rules for changing this codebase |
| [`PENDING.md`](./PENDING.md)                               | The backlog: known gaps, unverified claims, watch items          |

The living brand kit is a page rather than a file: `/brand/`, served by the same two stylesheets
the product pages use, so it cannot drift.
