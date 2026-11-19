# bloopbox

A screenless WhatsApp voice messenger for children aged 2–5. Three illuminated arcade buttons,
each assigned to one family member or one group chat. **Hold to send a voice note, tap to play
what arrived.**

No screen, no menus, no scrolling, and nothing for a toddler to get lost in. A parent sets the
device up once from a phone or laptop; after that the child's entire interface is three buttons
and three lights.

It runs on a Raspberry Pi as two Node.js daemons and speaks to WhatsApp as an ordinary linked
device, so the people at the other end need nothing but WhatsApp.

## Status

Under active development, and everything can be worked on without a Pi: the software is built and
tested against a **browser-based hardware simulator**.

One real device exists, the **reference board**: a Pi 3B+ with the WM8960 audio HAT, three buttons
and three lamps. On 2026-09-30 a card flashed from a locally built image ran it end to end — first
boot, the setup hotspot, WhatsApp linking, all three buttons and lamps, audio in both directions,
silent mode and the one-button-at-a-time lockout. A Raspberry Pi 4 Model B (1 GB) has also been
confirmed working (2026-11-19).

**The Pi Zero 2 W the product targets has never run any of it.** [`PENDING.md`](./PENDING.md) is
the honest list of what is and is not proven.

## Repository layout

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

A Raspberry Pi (the Zero 2 W is the target; the reference board is a 3B+, and a Pi 4 Model B
1 GB is confirmed working), a **Waveshare WM8960
audio HAT** with one or two small speakers, three 30 mm illuminated arcade buttons with 3 V lamps,
a 5 V 2.5 A supply and an 8 GB+ microSD card. The bill of materials, the wiring and the GPIO pins
are in [`docs/hardware.md`](./docs/hardware.md).

**The audio HAT is the one part that changes the install command:** it needs `--audio-hat wm8960`.

The OS target is **Raspberry Pi OS Trixie, 64-bit**, and that is a constraint rather than a
preference: the GPIO addon compiles against the libgpiod v2 API, which Bookworm does not have.

## Install

> **Building one for the first time?** The website carries a step-by-step manual written for a
> parent rather than for this repository — the parts, the pin map as a picture, and the Wi-Fi and
> WhatsApp setup. It is `website/app/manual/`, served at `/manual/`. What follows is the terse
> version; [`docs/deployment.md`](./docs/deployment.md) is the full reference.

### A ready-to-run SD card

The easiest route is a card that needs no install step at all. On a Linux machine with Docker and
root (on macOS, see the container one-liner in `docs/deployment.md`):

```bash
cd box/software
npm install
npm run release                                      # the arm64 tarball, built in Docker
sudo ./scripts/build-sd-image.sh --audio-hat wm8960  # -> release/bloopbox-*-wm8960.img.xz
```

Flash the image with Raspberry Pi Imager (**Use custom**) or `dd`, put the card in, and power up.
First boot expands the card and reboots once. `--wifi-ssid` / `--wifi-psk` / `--wifi-country` bake
your network in; without them the device raises its own setup hotspot (below).

**Match the flags to the board you actually built.** `--audio-hat wm8960` writes the codec's
overlay and ALSA settings; `--no-leds` is only for a board with no lamps wired, so never pass it
for the reference board. The profile is remembered on the device, so a later
`sudo ./install.sh` with no flags keeps it — see
[`docs/deployment.md` § The box remembers which board it is](./docs/deployment.md#the-box-remembers-which-board-it-is).

### Or a tarball, over ssh

If the Pi is already running Raspberry Pi OS Trixie and reachable over ssh:

```bash
cd box/software
npm run release
scp release/bloopbox-*-linux-arm64.tar.gz <user>@bloopbox.local:
ssh <user>@bloopbox.local 'tar xzf bloopbox-*.tar.gz \
  && sudo ./bloopbox-*/install.sh --audio-hat wm8960 && sudo reboot'
```

The Pi compiles nothing — the tarball carries its own `node` binary and a `node_modules` built for
arm64. Re-running `install.sh` is an upgrade and leaves settings and the WhatsApp pairing alone.

> **The reboot is not optional.** The codec overlay and the button pull-ups
> (`gpio=17,27,22=ip,pu`) are firmware settings applied before userspace starts. Until that reboot
> there is **no sound card** and the buttons read garbage — the usual explanation for a fresh
> install where "nothing works".

Once it is back up, check it over ssh:

```bash
sudo bloopbox-audio-test    # speaker out, microphone in, played back
sudo bloopbox-doctor        # is everything present and running?
```

For a **new board**, the Zero 2 W included, follow
[`docs/hardware-bringup.md`](./docs/hardware-bringup.md) rather than improvising: it brings up one
subsystem at a time and carries the debugging kit.

## Setting it up

### First boot

A device that cannot reach a network raises its own **open Wi-Fi hotspot** called
`bloopbox-XXXX` — after ten seconds without one on a device that has never been set up. The three
lights double-pulse together while it is up.

Join that network from a phone. The setup page should open by itself, the way a hotel Wi-Fi
sign-in page does; if it does not, open `http://10.42.0.1`. It asks for your home Wi-Fi network
and its passphrase, and a **settings password** of at least 6 characters, which protects the admin
panel afterwards — the child never needs it.

Accepting those tears the hotspot down and joins your network, so the page you are looking at
dies. That is expected; the lights are the only feedback across the switch.

If the card was built with `--wifi-ssid`, or you wrote `bloopbox-wifi.txt` on its boot partition,
the device joins your network directly and never raises a hotspot. Open the admin panel and set the
settings password there instead.

### The admin panel

```
http://bloopbox.local
```

That is the whole address. Sign in with the settings password. The activity totals sit at the top.
Until WhatsApp is linked the panel shows only the WhatsApp card and *Advanced*; once linked it
shows Contacts, Sending, Quiet hours, WhatsApp and Wi-Fi. *Advanced* holds audio, button timings,
device health (restart, shut down, and the ssh login) and the factory reset.
[`docs/PRODUCT.md` §3](./docs/PRODUCT.md#what-the-admin-panel-shows-and-when) has what each card
does and when it appears.

**Saving anything restarts the device's software.** Configuration is read once at boot, so a save
exits the daemon cleanly and systemd brings it straight back with the new values. The panel shows
"restarting" and reloads itself.

### Linking WhatsApp

In the **WhatsApp** card, either scan the QR (on your phone: WhatsApp → Settings → Linked devices →
Link a device) or press **Get a pairing code** and type it into "Link with phone number instead".
The codes rotate every 20 seconds and the panel keeps up on its own.

> The account you link becomes the identity the device sends as. Use a spare number if you would
> rather not have a toddler's device speaking as you.

### Assigning the three buttons

Under **Contacts**, give each button a name and a target: a **phone number** with its country code
(a number with a national trunk prefix and no country code is rejected rather than guessed at,
because a guess could reach a stranger), or a **group**, chosen from a picker fed by the linked
account. Assigning a group means everyone in it can send to the child and hears what the child
sends.

Only the assigned targets can reach the device. Unknown numbers, unassigned groups, status
broadcasts and newsletters are dropped before any audio is downloaded.

### The ssh login

A flashed card carries no shared password: each device makes its own on first boot. It is shown
under **Advanced → Device health → SSH access**, for whoever is helping debug the box; setup never
needs it. The login user is `bloop` unless the card was built with `--user`.

## Using it

| What the child does                | What happens                                                     |
| ---------------------------------- | ---------------------------------------------------------------- |
| Holds a button                     | The light goes solid at once, then a "pop" invites them to speak  |
| Lets go                            | A "whoosh", three quick flashes, and the note is on its way       |
| Lets go by accident, presses again | The **same** message carries on                                  |
| Taps a blinking button             | Plays everything waiting from that person, oldest first          |
| Taps a dark button                 | A low "oops" double-beep. Nothing was sent                       |
| Holds a blinking button            | A low "oops". **Blinking means listen first**                    |
| Brushes a button                   | Nothing at all                                                   |

A press shorter than about a second (1150 ms with the shipped timings) is a tap; anything longer
sends. The microphone opens only after the "pop", so the box's own sound stays out of the message.
While one button is recording or messages are playing, the other two do nothing. The thresholds
are adjustable under **Button timings**; [`docs/PRODUCT.md` §1](./docs/PRODUCT.md#1-core-user-experience)
is the full behaviour, and
[`docs/architecture.md`](./docs/architecture.md#tap-hold-and-the-carry-on-window) the reasoning.

### Silent mode

Holding **buttons 1 and 3 together for three seconds** toggles silent mode, confirmed by one slow
left-to-right chase; after that a silent box looks exactly like an audible one. It can also be
scheduled under **Quiet hours** (off until you switch it on and pick a timezone). Silent mode
suppresses the cue noises, never the playback of a voice note.
[`docs/PRODUCT.md` §7](./docs/PRODUCT.md#7-audio-cues-and-silence) has the details.

### What the lights mean

Three lights are the device's entire vocabulary. **Solid always means something is wrong**,
except on the button being held.

| Lights                                        | Means                                                    |
| --------------------------------------------- | -------------------------------------------------------- |
| Chase left to right                           | Starting up                                              |
| All three blinking together                   | Joining Wi-Fi and linking WhatsApp                       |
| All off                                       | Ready and idle — the normal state                        |
| One button blinking slowly                    | A voice note is waiting from that person — tap it        |
| One button solid                              | That button is recording right now                       |
| One button, three quick flashes               | That message was delivered                               |
| A slow left-to-right pass, once               | Silent mode just went on, or just came off               |
| All three double-pulse, then dark             | The setup hotspot is up and the setup page is waiting    |
| **All three solid**                           | No network, and no hotspot yet                           |
| **Buttons 1 and 2 solid**                     | Network is fine; WhatsApp is unlinked or waiting for a scan |

Timings and how overlapping patterns are resolved: [`docs/PRODUCT.md` §6](./docs/PRODUCT.md#6-led-signal-matrix).

### When something is wrong

On the device, over ssh:

```bash
sudo bloopbox-doctor        # is everything present and running?
sudo bloopbox-debug on      # persistent journal, debug logging, a 10 s sampler — expires in 24 h
sudo bloopbox-diagnostics   # bundle the whole picture into one redacted tarball
```

If the device is offline and the admin panel is therefore unreachable, the way back in is the boot
partition: pull the card, write `bloopbox-wifi.txt` with `ssid=` / `psk=` / `country=`, and boot.
Any laptop can read that partition.

## Safety and privacy

- **Only assigned targets can reach the device.** Filtering happens before download, so a
  stranger's audio never reaches the disk. `box/software/src/whatsapp/whitelist.ts` is the boundary,
  and its tests are written from the position that anything not explicitly assigned must not get
  through.
- **What the child records stays in RAM.** Outbound audio lives in `/run/bloopbox`, a tmpfs, and is
  never written to the SD card. **Inbound** notes are kept on the card (`/data/notes`) so an unheard
  one survives the box being unplugged; each is deleted the moment it is played, and anything
  unheard is purged after 48 hours.
- **Settings writes are atomic** (temp file → `fsync` → `rename`), so losing power mid-save cannot
  corrupt a parent's configuration or brick the device.
- **The admin API is password-protected**, except while the device is still being set up — the
  onboarding flow has to be able to set the first password. `docs/architecture.md` explains the
  accepted risk around that.
- **A read-only root filesystem** ([`docs/PRODUCT.md` §8](./docs/PRODUCT.md#8-os-protection-and-storage-safety))
  is specified but **not built**: `/data` still lives on the root filesystem, so it needs a
  dedicated partition first.

## Developing

No Raspberry Pi needed:

```bash
cd box/software
npm install
npm run sounds      # the cue WAVs are generated, not committed
npm run dev:hw      # terminal 1 — daemon + API on :3000, simulator HAL
npm run dev:web     # terminal 2 — the four UIs on :5174
```

Then open <http://localhost:5174/simulator/>.
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
| [`docs/audio-quality.md`](./docs/audio-quality.md)         | Measured capture and playback quality, and the filter choices    |
| [`docs/deployment.md`](./docs/deployment.md)               | Releases, the installer, the SD image, systemd, CI               |
| [`docs/hardware-bringup.md`](./docs/hardware-bringup.md)   | The gated plan for a new board, and the debugging kit             |
| [`docs/BRAND.md`](./docs/BRAND.md)                         | Visual direction and the design system's locked decisions        |
| [`CLAUDE.md`](./CLAUDE.md)                                 | Conventions, toolchain traps, and rules for changing this codebase |
| [`PENDING.md`](./PENDING.md)                               | The backlog: known gaps, unverified claims, watch items          |

The living brand kit is a page rather than a file: `/brand/`, served by the same stylesheets the
product pages use, so it cannot drift.

## License

bloopbox is free software under the [GNU General Public License v3.0](./LICENSE). Build it, change
it, give it away or sell it; if you hand someone a box, or an image, running a modified version,
you owe them that version's source under the same terms. The release tarball and the SD image
carry the license beside the code. One of the libraries every image ships, `libsignal`, is itself
GPL-3.0.
