# Pending

Work identified but not yet done. Add items here as they come up rather than losing them in
conversation; move them out when they ship.

Ordered roughly by priority within each group.

---

## Features

### AP hotspot / captive portal for onboarding

**Problem.** `PRODUCT.md` §First Boot has the device come up as an access point serving a captive
portal, and §6 gives Wi-Fi Error an "opens AP hotspot after 30s" behaviour. None of that exists.
`config.wifi` is written by the admin panel and, since packaging, applied to NetworkManager by
`deploy/wifi-apply.sh` — but only over a network that already works.

So the first-boot story is currently: the parent supplies Wi-Fi **before** first boot by editing
`bloopbox-wifi.txt` on the boot partition, or the image is built with `--wifi-ssid`. A
device that cannot reach the network cannot be configured over the network either.

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
root agent polls every 5 s and publishes `/run/bloopbox-net/net-state.json`. Still to come: the
scan list and last join error in that document, and the other direction —
`/run/bloopbox/net-request.json`, written by the daemon, carrying a **strictly enum-validated**
action (`ap-up` | `ap-down` | `join {ssid, psk}`), never evaluated as shell. One writer per
directory, so the agent can never end up owning the recordings tmpfs. The agent should also keep a
fallback of its own — unassociated, unconfigured and no requests for ~5 min raises the AP anyway —
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
left of it: nothing is *proven* on a radio (see below), and the agent still reports no scan list
or join error. (3) portal — `public/portal/`, port 80, probe catch-all, join and fallback.
(4) packaging — boot README, `smoke-test-release.sh` with a stubbed `nmcli` on PATH.

**Why it matters.** It is the difference between a device a parent can set up and one that needs
a laptop and a card reader. The physical path — pull the card, write `bloopbox-wifi.txt` — stays
as the recovery route when even the hotspot cannot be reached.

Radio behaviour cannot be tested in a container, so milestones 2 and 3 have landed as a single
verification gap (below).

### Read-only root filesystem needs /data on its own partition

**Problem.** `PRODUCT.md` §11 wants the root filesystem mounted read-only through overlayfs so an
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

`getUserMedia` / `MediaRecorder` in `public/simulator/main.ts` has never been exercised.
Headless Chrome has no audio input device and blocks on the permission prompt, so automated
verification was not possible. The ffmpeg leg of that path (WebM/Opus in, Ogg/Opus out) _was_
verified separately against real ffmpeg. What remains unproven is the browser glue: that a hold
produces a valid `.ogg` in the recordings directory.

### WhatsApp end to end with a real account

The bridge connects, produces a pairing QR (verified scannable by decoding it back to the exact
payload), offers phone-number pairing, propagates the whitelist and reports state. What has **not**
run is the part that needs a linked account: completing a pairing, receiving a real voice note, and
sending one that appears as a PTT bubble on a phone. Also unverified: the group picker against real
groups, `markRead`, and `requestPairingCode` actually returning a code.

Worth checking when pairing: that a voice note from a number **not** assigned to a button is
dropped (it should not appear, and the bridge logs `dropped a voice note`), and that a message in
an assigned group arrives on that button whoever in the group sent it.

### The setup hotspot and its portal have never touched a radio or a phone

The whole path is built — agent, supervisor, LED rung, portal UI, captive redirect, join — and
none of it has run on a Pi. What stubs and a container proved: the agent publishes valid JSON for
associated / disconnected / AP-active / no-nmcli, parses a scan list including an SSID with a
colon in it, and creates, raises, lowers and joins profiles with the right `nmcli` arguments; the
daemon walks `WIFI_ERROR` → `SETUP_PORTAL` → `CONNECTING`, writes one `ap-up` after the grace
period rather than one per poll, serves the portal, 302s every captive probe while the hotspot is
up and **nothing at all** when it is down, and a join writes the config, hands the credentials to
the agent and restarts.

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
