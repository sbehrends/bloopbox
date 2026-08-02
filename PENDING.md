# Pending

Work identified but not yet done. Add items here as they come up rather than losing them in
conversation; move them out when they ship.

Ordered roughly by priority within each group.

---

## Features

### AP hotspot / captive portal for onboarding

**Problem.** `PRODUCT.md` §3 (First Boot) has the device come up as an access point serving a captive
portal, and §6 gives Wi-Fi Error an "opens AP hotspot after 30s" behaviour. Milestones 1–3 below are
now **built** — agent, supervisor, LED rung, portal UI, captive redirect, join — leaving milestone 4
(packaging) and, more importantly, the fact that **none of it has run on a radio** (see the
verification gap below).

Before that work, the whole first-boot story was: the parent supplies Wi-Fi **before** first boot by
editing `bloopbox-wifi.txt` on the boot partition, or the image is built with `--wifi-ssid`. That
path still exists and is now the **recovery** route — a device that cannot reach the network and
whose hotspot cannot be reached either is only recoverable through the boot partition.

It used to be worse: `wifiDown` was never computed at all — initialised to `false` with the
simulator's injector as its only writer, so the Wi-Fi Error rung of the LED ladder could not fire
on a real device. Milestone 1 below fixed that; the rest of this item is still open.

**Agreed design.**

_NetworkManager's own AP mode, not `hostapd` + `dnsmasq`._ NM is already installed and is already
what `deploy/wifi-apply.sh` drives; `hostapd` means marking `wlan0` unmanaged and handing it back,
which is the part of every Pi captive-portal recipe that breaks. An NM profile with
`802-11-wireless.mode ap` + `ipv4.method shared` gives DHCP, DNS and `10.42.0.1` for free, and
teardown is `nmcli con down`. `shared` needs `dnsmasq-base` — one more entry in
`RUNTIME_PACKAGES`.

_Root does networking, the daemon does UI, they talk through files in `/run`._ **Built** — see
`deploy/net-agent.sh`, `bloopbox-net.service` and `src/net/netState.ts`. The hardware daemon runs
unprivileged under `ProtectSystem=strict`, so it cannot run `nmcli` and should not be able to. The
root agent polls every 5 s and publishes `/run/bloopbox-net/net-state.json`, including the scan
list and the last join error. The other direction is built too: `/run/bloopbox/net-request.json`,
written by `requestNetAction()` in `src/net/netState.ts`, carrying a **strictly enum-validated**
action (`ap-up` | `ap-down` | `join {ssid, psk}`), never evaluated as shell. One writer per
directory, so the agent can never end up owning the recordings tmpfs. Still to come: the agent
keeping a fallback of its own — unassociated, unconfigured and no requests for ~5 min raises the AP anyway —
so a crashed daemon cannot strand the device.

_Decision logic in TS._ `src/core/networkSupervisor.ts`: pure, takes observations plus timings,
emits intents, tested on fake timers like `buttonInterpreter`. Bash stays a dumb executor.

_When the AP comes up._ Unconfigured: 20 s of no association. Configured: 3 min — a flat 30 s
would pop a hotspot into the house every time the router reboots. While it is up, rescan every
60 s and drop the AP to rejoin if the known SSID reappears. This deliberately deviates from §6's
"opens AP hotspot after 30s"; the LED row records the behaviour, this records the why.

_The AP is open, with no passphrase and no confirmation step._ A fixed passphrase would be
published in this repo, so its security value is zero while its UX cost is real; deriving one from
the CPU serial is worse, because the SSID has to carry the same serial to be identifiable and
would therefore hand out the passphrase. Accepted risk: while the AP is up on an **unconfigured**
device the admin guard is already standing aside (by design — onboarding has to be able to set the
first password), so anyone in radio range can complete onboarding. The window is short, the device
holds nothing yet, and hardening is deferred. If it needs hardening later, the answer is physical
presence — require a button press within N seconds to accept `POST /api/onboard` and
`POST /api/wifi/join` — not a shared secret. Note that path depends on the buttons, which is the
one subsystem never run on hardware, so it should not gate setup until bring-up proves a press
registers.

_The portal is its own UI._ **Built** — `public/portal/`, a third Vite entry: pick a network →
passphrase → admin password → "joining". Not the admin panel: iOS/Android captive browsers are
stripped webviews with unreliable WebSocket and ephemeral storage. Everything else (WhatsApp QR,
contacts, timings) happens afterwards on the home LAN, which is fine because pairing needs
internet anyway.

Mechanics, all in place: port 80 via `AmbientCapabilities=CAP_NET_BIND_SERVICE` and a second
listener on the same Express app (3000 stays the API/bridge port), which fails softly with EACCES
off-device; a catch-all that 302s anything it does not own to the portal **while the hotspot is
up and never otherwise**, deliberately failing Android's `generate_204` and Apple's
`hotspot-detect.html` because answering them correctly is what suppresses the sign-in popup; and
wildcard DNS through `/etc/NetworkManager/dnsmasq-shared.d/bloopbox.conf` (`address=/#/10.42.0.1`),
installed by `install.sh`.

⚠️ **That DNS directory is the one unverified assumption.** If NetworkManager on Trixie does not
read `dnsmasq-shared.d`, names will not resolve on the hotspot and the portal will not pop up by
itself — the parent would have to type `10.42.0.1`. Fallback is `hostapd` + `dnsmasq` with `wlan0`
unmanaged. Check `31-nm-conf.txt` in a diagnostics bundle first.

_Handoff._ One radio, so AP and STA are sequential — no concurrent AP+STA on `brcmfmac`. A join
writes `config.wifi` and calls `requestRestart()`, so `wifi-apply.sh` stays the single place
credentials become a connection. The parent's page dies when the AP drops, so the portal must say
so first, and the LEDs (AP double-pulse → `CONNECTING` blink → `READY`) are the only feedback
channel across the switch. On failure the agent re-raises the AP within ~30 s with `lastError` in
the state file.

**Milestones.** ~~(1) observation only — net-agent, state file, real `wifiDown`, doctor checks~~
**done**. ~~(2) AP up/down — profile, `networkSupervisor.ts`, tests, the LED rung~~ **done**,
including `dnsmasq-base` in `RUNTIME_PACKAGES` and a simulator injector for the pattern. What is
left of it: nothing is *proven* on a radio (see below). ~~(3) portal — `public/portal/`, port 80,
probe catch-all, join and fallback~~ **done**, along with the scan list and `lastError` in the
state document and `requestNetAction()` writing the other direction.
(4) packaging — boot README, `smoke-test-release.sh` with a stubbed `nmcli` on PATH.

**Why it matters.** It is the difference between a device a parent can set up and one that needs
a laptop and a card reader. The physical path — pull the card, write `bloopbox-wifi.txt` — stays
as the recovery route when even the hotspot cannot be reached.

Radio behaviour cannot be tested in a container, so milestones 2 and 3 have landed as a single
verification gap (below).

### Unread notes are recovered at boot — but only within 8 h, and not across a power cut

**Built** on 2026-08-01, in `src/audio/recovery.ts`. No read-state store was needed: playback
deletes a note's file, so *present on disk* already means *unread*, and the recordings directory is
the ledger. The missing piece was never time, it was the **button index**, which now rides in the
filename (`wa-<index>-<messageId>.ogg`); `receivedAt` comes from mtime and `durationMs` from
ffprobe. Recovery is a scan, so nothing can disagree with the directory.

The window is **8 h** (`RECOVERY_MAX_AGE_MS`), a product decision rather than a technical limit: a
note from this morning is worth hearing when the box comes back, one from yesterday is a confusing
thing to hand a small child. Recovered notes are restored silently — `restoreUnread` skips the
notify cue, because nothing has arrived and a box that chimed through its backlog on every restart
would teach a parent to distrust the sound.

What remains open, in the order it will bite:

1. _A power cycle still wipes everything._ `RECORDING_DIR` is `/run/bloopbox`, a tmpfs, and
   someone unplugging the box is the most likely restart in a child's room. Only daemon restarts —
   config saves, crashes, updates — are covered. Surviving a power cut means writing a child's
   voice notes to the SD card: a different decision, with a privacy cost and a wear cost.
2. _A recovered note still cannot be marked read upstream_, because the bridge's `pendingReads` is
   memory too (below). It plays, and the sender still never sees a receipt. These two want solving
   together.
3. _Notes written before this change are unattributable_ and are skipped rather than guessed at —
   verified live, four orphans reported as `unattributable: 4`. Deliberate: putting one contact's
   voice on another contact's button is the outcome the whitelist exists to prevent, and a guess
   would arrive with none of the evidence that produced it. Self-clearing as the purge catches
   them.
4. _Nothing above the window is deleted here._ The purge owns deletion and one owner is worth more
   than reclaiming a few kilobytes early, so an 8-to-48-hour-old note lingers unreferenced. Bounded
   by `RuntimeDirectorySize=64M`.

Whether a 40-hour-old note should play at all is a real product question, but it is not this one —
it is already true today without any restart, and belongs to the queue as a whole.

### Read-only root filesystem needs /data on its own partition

**Problem.** `PRODUCT.md` §8 wants the root filesystem mounted read-only through overlayfs so an
abrupt power cut cannot corrupt the OS. `scripts/build-sd-image.sh` deliberately does not enable
it, because `/data` currently lives **on** the root filesystem: with the overlay active, every
config write and the WhatsApp credentials would land in a RAM overlay and vanish on reboot. That
is a worse failure than the one it prevents, and a silent one.

**Proposed work.** Give `/data` a third ext4 partition (label `bloopdata`, mounted from fstab),
then `raspi-config nonint do_overlayfs 0` becomes safe. The catch to design around: Pi OS expands
the **last** partition on first boot, so a naive third partition after the rootfs breaks
auto-expand. Either put `/data` before the rootfs, or size the rootfs at build time and do the
expansion in the image builder rather than on the device.

**Acceptance.** A built image where pulling power during a settings save leaves both the OS and
the previous config intact, and `sudo bloopbox-doctor` reports `/data` writable with `/`
read-only.

### On-device doctor duplicates the tsx one

`npm run doctor` (`scripts/doctor.ts`) cannot run on the device: it is a tsx script and the
release carries no devDependencies. `deploy/doctor.sh` covers the same ground in bash, plus the
things that only exist once installed. Two implementations of one idea will drift — the cue list
already had to be read out of `dist/audio/soundFiles.js` at runtime to stop it drifting once.

Worth considering: compile the checks into `dist/` (a `dist/doctor.js` the bash wrapper calls) so
there is one implementation and the device runs the same code CI does.

### The display face is a system stack, not the brand's own letterform

`docs/BRAND.md` asks for a custom ultra-bold rounded geometric sans. `--font-display` starts with
`ui-rounded`, which is SF Pro Rounded on Apple platforms — that letterform for zero bytes — and
falls back to Nunito / Quicksand / Varela Round / `system-ui`. **On a plain Android phone or a
Linux desktop, the brand's most distinctive typographic asset is absent** and the headings render
in the system UI face.

Deliberate for now: the portal is served from a Pi over its own hotspot, and a font that arrives
late is a page a parent stares at. Revisit only with a subsetted self-hosted WOFF2 (Latin, the two
weights actually used), `font-display: swap`, and a before/after measurement of the portal's first
paint on a real phone over the hotspot — not on localhost, where the cost is invisible.

### Coverage still fails its own thresholds

`npm run test:coverage` reports 77% statements / 68% branches against declared thresholds of 80,
and `npm run check` does not run it. What is left, in order of size:

- **`src/whatsapp/` at 24%** — the Baileys client. The largest hole by far, and the hardest to
  test honestly: most of it is an unofficial API surface that can only be exercised against a real
  account. `whitelist.ts` (the safety boundary) is already well covered; what is not is the media
  download, the reconnect ladder and the send path.
- **`src/server/simulatorTransport.ts`** — no tests, and **deliberately not getting any**. It is
  the browser end of a debugging tool: it never runs on a device, and when it breaks the person
  looking at it is the one who broke it. `bridgeLink.test.ts` is the template if that ever stops
  being true. It stays in the coverage denominator, so the 80% thresholds cannot be reached
  without excluding it — worth doing at the same time as any other change to `vitest.config.ts`.
- **`src/audio/` at 75%** — the ffmpeg pipeline's error paths.
- Three timeout paths in `bridgeLink.ts` (send 60s, pairing 20s, groups 10s) are deliberately
  uncovered: they need fake timers, which do not mix with real sockets.

### The mark is drawn twice, and nothing enforces that they agree

`public/shared/bloopbox-mark.svg` (three concentric ring pairs, for 24px and up) and
`public/shared/bloopbox-favicon.svg` (three solid discs, for browser tabs) are separate hand-drawn
files sharing no code. They have to agree on five colours and on the left-to-right button order —
**yellow, coral, teal** — and today the only thing keeping them in step is the comment in each and
`/brand/`, which renders both side by side.

Cheap guard if this ever drifts: a test that parses both SVGs and asserts the `fill` values appear
in the same order, and that both match `--ch-1/2/3` in `tokens.css`. Three assertions, no browser.
Not written yet because `src/tests` has no fixture that reads `public/`.

### The brand kit ships to the device and is not behind the admin gate

`/brand/` is a Vite entry, so it lands in `dist/public/` and is served by the hardware server like
any other page — about 7 KB gzipped of static HTML, no JS. It contains no secrets, so being
ungated is not a leak, but it is a page a parent could stumble into. Options if that ever matters:
drop the entry from `vite.config.ts` for release builds, or move it behind `requireAdmin`. Left
shipping on purpose: a style guide that is not built alongside what it documents rots.

## Verification gaps

These are things built but not proven. Not bugs — just claims that have not been tested.

### The brand implementation has only been seen in headless Chrome on macOS

Every page was screenshotted in both colour schemes and the layouts hold, but that is one engine
on one platform. Unverified: `ui-rounded` resolving anywhere other than Apple (see above), the
in-SVG `prefers-color-scheme` inversion of `bloopbox-mark.svg` in a captive-portal webview (iOS
`SFSafariViewController` and Android's `CustomTabs` both render SVG through the system engine, but
neither has been tried), `ctx.roundRect` on whatever browser a parent has, and the `.choice` row's
`aria-checked` styling under a real screen reader.

None of this blocks anything: the fallbacks are all "looks plainer", not "does not work".

### Browser microphone capture

The **glue** is now proven, the **device** is not. On 2026-08-01 two holds in a real Chrome sent
two voice notes that WhatsApp accepted, so `MediaRecorder` → WebM/Opus → Socket.io upload →
ffmpeg → Ogg/Opus → Baileys works end to end.

But `getUserMedia` was stubbed to reach it: the page was handed a `MediaStreamAudioDestinationNode`
fed by an oscillator, because no real microphone could be held from a driven browser. So a real
capture device — permission prompt, sample rate, channel count, a mic that starts slowly — has
still never been in the path. That last part matters more than it sounds: `minRecordingMs`
discards on *captured* audio rather than hold duration precisely because a slow microphone start
is expected, and nothing has yet exercised a device that does it.

### WhatsApp end to end with a real account

Largely done, on 2026-08-01, against a real linked account. Verified in both directions: pairing
by QR, the group picker returning a real group, a contact assigned by `PUT /api/config` surviving
the daemon restart, the whitelist reaching the bridge, a voice note **sent** to a group and to an
individual (`voice note sent`, kinds `group` and `individual`), a voice note **received** on each
(`voice note accepted`), playback of both from a simulator tap, the unread counts clearing, and
the recordings being purged from the RAM disk afterwards.

Also verified, after the fix that made it possible: messages sent while **both** daemons were off
arrive when the bridge reconnects, from WhatsApp's own queue rather than from anything of ours —
which is the only mechanism that survives a power cut, since `/run` is tmpfs. Two notes sent to a
dark box, two `voice note accepted` on reconnect, unread counts `[2,0,0]`.

Still not run: `requestPairingCode` actually returning a code, and a note from a number nobody
assigned being dropped — the negative case, which is the one the safety boundary exists for.
Group membership as permission is also only half-checked: the group note came from the account
that owns the device, not from a third party in that group.

### Read receipts do not survive a bridge restart

`pendingReads` in `whatsapp-bridge.ts` is an in-memory `Map` from message id to the Baileys key
`markRead` needs. A voice note received before a bridge restart is still played and still clears
its unread count — that state lives in the hardware server — but the key is gone, so nothing is
marked read upstream and the sender never sees the receipt.

Observed on 2026-08-01: two notes were waiting, one from before a bridge restart and one from
after; both played, only the newer produced `marked read upstream`.

Small, but it is the visible half of the promise. The sender's evidence that a child heard them is
those two ticks, and a bridge restart is not rare — it happens on update, on crash, and on every
reboot. Fixing it means persisting the pending keys somewhere; `/data` is the writable volume, but
the keys are a privacy consideration of their own, so this needs a decision rather than a patch.

### Baileys cannot draw the waveform on a sent voice note

Every send logs `Failed to generate waveform: Cannot find package 'audio-decode'`. It is optional,
the send succeeds regardless, and the note plays — but the PTT bubble on the recipient's phone
carries no waveform bars. For a product whose entire output is voice notes, the bubble looking
inert is worth the dependency. Not yet confirmed against a real phone screen: check what the
bubbles from 18:45 and 18:46 actually look like before adding it.

### The admin panel feels sluggish during pairing

Reported while pairing on 2026-08-01: the panel "felt a bit unresponsive". Not diagnosed, and no
measurement was taken — this is a note to look, not a conclusion.

First places to look, cheapest first. The pairing block now runs a 500 ms ticker that polls
`/api/whatsapp` every 2 s and every tick once a code has lapsed, so a bridge that is down turns
into two fetches a second, each awaiting a socket round trip to the WhatsApp process. `getJson`
has no timeout, so a slow reply stacks; the `polling` guard drops overlaps but not latency. Each
rotation also refetches `qr.svg`, which re-renders the QR server-side. Separately, every save
rebuilds the whole panel from scratch and the daemon restarts on config writes, which is a couple
of seconds where nothing answers — expected, but indistinguishable from a hang without a spinner.

### The setup hotspot and its portal have never touched a radio or a phone

The whole path is built — agent, supervisor, LED rung, portal UI, captive redirect, join — and
none of it has run on a Pi. What stubs and a container proved: the agent publishes valid JSON for
associated / disconnected / AP-active / no-nmcli, parses a scan list including an SSID with a
colon in it, and creates, raises, lowers and joins profiles with the right `nmcli` arguments; the
daemon walks `WIFI_ERROR` → `SETUP_PORTAL` → `CONNECTING`, writes one `ap-up` after the grace
period rather than one per poll, serves the portal, 302s every captive probe while the hotspot is
up and **nothing at all** when it is down, and a join writes the config, hands the credentials to
the agent and restarts.

Since 2026-08-01 that container half is a script rather than an argument:
`./scripts/test-onboarding.sh` unpacks a built release into a bare Trixie arm64 container,
installs it with the real `install.sh`, and drives the whole flow — agent up, scan published,
`ap-up`, the daemon reaching `SETUP_PORTAL`, the portal served, a captive probe 302'd, a join
refused without an admin password and then accepted — against the **shipped** `net-agent.sh` and
units rather than against the source tree. The one substitution is `nmcli`
(`packaging/fake-nmcli.sh`); the agent cannot tell, so its own logic is genuinely exercised. It is
not wired into `npm run check` or CI, and takes about a minute.

Treat its passing as "the shipped artefact is wired up correctly", not as "onboarding works". The
stub is a model of `nmcli`, and every item below is a way that model could be wrong.

What only a radio and a phone can show:

- that `802-11-wireless.mode ap` + `ipv4.method shared` comes up on `brcmfmac` at all
- that a phone gets a DHCP lease from NetworkManager's own dnsmasq
- that `dnsmasq-shared.d` is honoured, without which the portal will not pop up by itself
- that the phone's captive webview reaches `:80` and renders the page
- that dropping the AP and `nmcli con up bloopbox` reliably rejoins — the radio may need a
  settling delay between the two, which would be a change to `ap_down` in the agent
- that an unset Wi-Fi country does not stop the AP from starting

Also unseen: the portal rendered in a browser. It is plain HTML and CSS, built and served
correctly, but nobody has looked at it.

### GPIO driver on real hardware

`src/hal/gpioDriver.ts` is written from datasheets and the opengpio API but has never run on a
Pi Zero 2 W. Pin numbers, ULN2003 polarity and ALSA device names are all unverified. See the
`TODO(hardware)` banner in the driver; `docs/hardware-bringup.md` is the order to prove things
in and what to reach for when one of them does not work.
Contained behind the HAL, so bring-up should be a debugging session rather than a rewrite.

What packaging did settle: the addon **compiles and loads on arm64 Trixie** against `libgpiod3`,
and `RaspberryPi_Zero2W` is a real export of opengpio 2.0.2 — both verified in a container by
`scripts/smoke-test-release.sh`. What no container can show is whether the pins, the polarity and
the ALSA device names are right. First moves are in `deploy/environment.example`:
`LED_ACTIVE_HIGH`, `BUTTON_ACTIVE_LOW`, `ALSA_CAPTURE_DEVICE`, `ALSA_PLAYBACK_DEVICE`,
`ALSA_MIXER_CONTROL`. If something fails with a permission error rather than wrong behaviour,
comment out the hardening block in the systemd unit before suspecting the driver.

### Audio capture and playback on real ALSA devices

`arecord`, `aplay` and `amixer` have never been run by this code against a real sound card. The
`amixer` control name in particular differs across USB adapters (`PCM`, `Speaker`, `Master`), and
`GpioHal` treats a mixer failure as non-fatal — so a wrong name means playback at whatever volume
the adapter booted with, silently, including the volume cap being ignored. Worth an explicit
check during bring-up: set the volume, then read it back.

### Simulator playback timing

In headless Chrome each 140ms clip took ~5s to report `ended`, because there is no audio output
device to drive the media clock. Order and completion were correct. Worth confirming on a real
browser with speakers that playback runs at the right speed.

---

## Watch items

Not work, but things that could bite.

- **An empty password hash opens the API even when `configured` is true — accepted, on purpose.**
  `requireAdmin` stands aside when `system.configured` is false **or** `adminPasswordHash` is
  empty. The second clause means a config in that half-written state leaves everything under
  `/api` reachable by anyone on the LAN with no password to type. It should be unreachable —
  `POST /onboard` and `POST /wifi/join` each write the hash and the flag in one `config.update()`
  — so getting there takes a hand-edited `config.json`.

  **Decision: leave it.** The alternative is refusing to serve in that state, and the guard cannot
  tell "mid-onboarding" from "corrupted" — so hardening it turns a recoverable device into one
  that needs the SD card pulled, in a house with no screen and possibly no laptop. An open API on
  a family LAN is the smaller failure. Do not "fix" this without a way to recover the device
  first. Pinned by `src/tests/adminAuth.test.ts` ("stands aside when configured is true but no
  hash was ever written"), which is the test to change if that ever exists.

- **A send that fails is dropped, not retried — accepted, on purpose.** `#commitCapture` catches a
  delivery failure, plays the "oops" cue and abandons the file for the purge. There is no outbound
  queue and no retry on reconnect, so a message recorded while the box cannot reach WhatsApp is
  gone. Verified on 2026-08-01 with the bridge stopped: the capture was made (`simrec-1.ogg`,
  10.7 kB) and silently abandoned.

  **Decision: leave it.** Inbound is worth recovering because the sender has already been told it
  was delivered and nobody in the house knows it is missing. Outbound is different — the person
  who recorded it is standing in front of the box, and a box that is restarting or has its error
  lights on is something they can see. Persisting a child's audio across restarts to retry it later
  also means writing their voice somewhere more durable than a RAM disk, which is a cost with no
  matching benefit here.

  Two smaller things this leaves, worth knowing rather than fixing: the failure is **not logged at
  all**, so on a screenless device a lost message leaves no trace even under `bloopbox-debug on`;
  and `Oops` is silenced in silent mode, so during quiet hours a failed send produces no sound and
  no sent-flash — the LED error pattern is the only indication, and it was already on.

- **The carry-on window leaves its own silence in the file.** `resumeGraceMs` keeps the microphone
  open after release, so every message carries up to that much trailing room noise, per gap and at
  the end — and that silence counts toward the `minRecordingMs` check, making it slightly laxer
  than it looks. Both are accepted trade-offs of not stitching segments together (see `CLAUDE.md`).
  Worth revisiting once it has been heard on real hardware: if 400 ms of tail is audible enough to
  annoy, the fix is trimming at encode time, not restructuring the capture.
- **Baileys is pinned to a release candidate** (`7.0.0-rc14`, which is what the `latest` tag
  points at). It is an unofficial WhatsApp API surface and can break from WhatsApp's side at any
  time. `legacy` (6.7.24) is the fallback if the RC proves unstable. See the Baileys 7 notes in
  `CLAUDE.md` for the API differences from the 6.x examples most guides show.
- **A group target trusts every member of that group.** That is the deliberate reading of "assign
  the family chat to a button", but it means adding someone to that group gives them a channel to
  the child without anyone touching the device's settings. If that becomes a concern, the
  extension is a per-group participant allowlist.
- **oxlint has no `--rules` output** in 1.76, so valid rule names have to be read out of
  `node_modules/oxlint/configuration_schema.json`. An unknown name is a hard config error.
- **opengpio 2.0.2 transposes `bias` and `debounce`** when calling its native binding. Worked
  around by not passing options at all; see `CLAUDE.md`. Revisit if a fixed release appears.
- **The Pi OS image is pinned in `packaging/versions.env` and will go stale.** Bumping it means
  updating `PI_OS_RELEASE`, `PI_OS_IMAGE` and `PI_OS_SHA256` together and rebuilding. Watch for
  first-boot mechanisms changing underneath it: the 2026-06 Trixie images use a bare `resize`
  token in `cmdline.txt` (not the old `init_resize.sh`), still ship a `pi` user plus
  `userconfig.service` for `userconf.txt`, and carry inert cloud-init templates
  (`user-data`, `network-config`) on the boot partition that could become live in a future
  release. `scripts/build-sd-image.sh` depends on all three of those facts.
- **`libgpiod` soname churn.** The addon links `libgpiodcxx.so.2` / `libgpiod.so.3` from Trixie's
  `libgpiod3` (upstream 2.2.x). A future Debian bumping to libgpiod 3.x upstream would break it
  the same way Bookworm's 1.6 does today, and the failure is a build error in CI rather than
  anything subtle.
- **`MemoryMax` on the two units is a guess, not a measurement.** 128/192 MB for the hardware
  server and 192/288 MB for the bridge, on a 512 MB device. `bloopbox-debug on` samples
  `MemoryCurrent` for every unit every 10s, so this is now a `jq` one-liner over
  `/var/log/bloopbox/trace.jsonl` rather than a guess — see `docs/hardware-bringup.md`. Worth
  doing especially for the bridge during a media download.
- **Tests that depend on filesystem work must use `waitFor`, not a fixed `flush(n)`.**
  `deviceController.test.ts` runs on fake timers with `setImmediate` left real, because the
  commit path awaits `rm`. A fixed number of yields passed in isolation and failed
  intermittently under parallel load. Anything asserting on post-`rm` state should wait on a
  condition.
