# Pending

Work identified but not yet done. Add items here as they come up rather than losing them in
conversation; move them out when they ship.

Ordered roughly by priority within each group.

---

## Features

### Recover from a broken config

**Problem.** `/data/config.json` can end up invalid — a truncated write on power loss, a
hand-edit over SSH, or a schema change that a future build rejects. Today
`ConfigManager.load()` handles this safely but _quietly_: it falls back to
`config.default.json` in RAM and the device boots into onboarding. Three things are missing.

1. **The bad file stays on disk.** Every subsequent boot repeats the fallback, so the parent's
   real settings — contacts, quiet hours, volume cap — are silently ignored indefinitely.
2. **Nothing tells anyone.** The reason is written to the log (`fallbackReason`) and nowhere
   else. On a device with no screen, a parent sees a messenger that has forgotten who Mom is
   and has no way to find out why.
3. **There is nothing to roll back to.** A config that validated five minutes ago is gone.

**Proposed work.**

- Keep a **last-known-good copy**. After a successful load _and_ after every successful write,
  copy the validated file to `/data/config.json.bak`. On a failed load, try the backup before
  falling back to shipped defaults, so a corrupt write costs the last change rather than
  everything.
- **Quarantine rather than discard.** Move the rejected file to
  `/data/config.broken-<timestamp>.json` so it can be inspected over SSH, and so the fallback
  is not silently repeated forever. Cap how many are kept.
- **Surface it.** Add a `configHealth` field to `/api/status`
  (`ok` | `restored-from-backup` | `using-defaults`) with the validation errors, and show a
  banner in the admin panel. This is the part that turns a silent failure into a fixable one.
- **Signal it on the hardware.** `PRODUCT.md` §6 has no pattern for "config is broken". Pick
  one that cannot be confused with the Wi-Fi or WhatsApp errors, and add it to the LED priority
  ladder in `CLAUDE.md`.
- **Recovery without the network.** If Wi-Fi credentials are among what broke, the admin panel
  is unreachable until the AP hotspot comes up. Consider a hardware factory reset — holding all
  three buttons for ~10s, with an unmistakable confirmation pattern so it cannot happen by
  accident in a toddler's hands.

**Acceptance.** Tests in `src/tests/config.test.ts` covering: corrupt file with a valid backup
restores the backup; corrupt file with no backup falls back to defaults _and_ quarantines the
bad file; the quarantine directory does not grow without bound; `configHealth` reports each
case. Plus a manual pass corrupting `data/config.json` by hand and confirming the admin banner.

**Why it matters.** Every other failure on this device is recoverable by a parent — replug it,
rescan the QR. A broken config is currently the one state that looks like normal operation
while quietly ignoring everything they configured.

---

### AP hotspot / captive portal for onboarding

**Problem.** `PRODUCT.md` §First Boot has the device come up as an access point serving a captive
portal, and §6 gives Wi-Fi Error an "opens AP hotspot after 30s" behaviour. None of that exists.
`config.wifi` is written by the admin panel and, since packaging, applied to NetworkManager by
`deploy/wifi-apply.sh` — but only over a network that already works.

So the first-boot story is currently: the parent supplies Wi-Fi **before** first boot by editing
`kids-messenger-wifi.txt` on the boot partition, or the image is built with `--wifi-ssid`. A
device that cannot reach the network cannot be configured over the network either.

**Proposed work.** A `hostapd` + `dnsmasq` profile (or NetworkManager's own AP mode, which is
already installed) brought up when no known network associates within ~30 s, serving the existing
admin UI as a captive portal, and torn down once real credentials are accepted. The routes exist:
`POST /api/onboard` and the guard that stands aside while `system.configured` is false.

**Why it matters.** It is the difference between a device a parent can set up and one that needs
a laptop and a card reader. Today the recovery path is physical — pull the card, edit a text
file — which is documented but is not what the spec promises.

### Read-only root filesystem needs /data on its own partition

**Problem.** `PRODUCT.md` §11 wants the root filesystem mounted read-only through overlayfs so an
abrupt power cut cannot corrupt the OS. `scripts/build-sd-image.sh` deliberately does not enable
it, because `/data` currently lives **on** the root filesystem: with the overlay active, every
config write and the WhatsApp credentials would land in a RAM overlay and vanish on reboot. That
is a worse failure than the one it prevents, and a silent one.

**Proposed work.** Give `/data` a third ext4 partition (label `kidsdata`, mounted from fstab),
then `raspi-config nonint do_overlayfs 0` becomes safe. The catch to design around: Pi OS expands
the **last** partition on first boot, so a naive third partition after the rootfs breaks
auto-expand. Either put `/data` before the rootfs, or size the rootfs at build time and do the
expansion in the image builder rather than on the device.

**Acceptance.** A built image where pulling power during a settings save leaves both the OS and
the previous config intact, and `sudo kids-messenger-doctor` reports `/data` writable with `/`
read-only.

### On-device doctor duplicates the tsx one

`npm run doctor` (`scripts/doctor.ts`) cannot run on the device: it is a tsx script and the
release carries no devDependencies. `deploy/doctor.sh` covers the same ground in bash, plus the
things that only exist once installed. Two implementations of one idea will drift — the cue list
already had to be read out of `dist/audio/soundFiles.js` at runtime to stop it drifting once.

Worth considering: compile the checks into `dist/` (a `dist/doctor.js` the bash wrapper calls) so
there is one implementation and the device runs the same code CI does.

## Verification gaps

These are things built but not proven. Not bugs — just claims that have not been tested.

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

### GPIO driver on real hardware

`src/hal/gpioDriver.ts` is written from datasheets and the opengpio API but has never run on a
Pi Zero 2 W. Pin numbers, ULN2003 polarity and ALSA device names are all unverified. See the
`TODO(hardware)` banner in the driver; `docs/hardware-bringup.md` is still to be written.
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
  server and 192/288 MB for the bridge, on a 512 MB device. Worth confirming against real
  `systemd-cgtop` numbers once it runs on hardware, especially the bridge during a media download.
- **Tests that depend on filesystem work must use `waitFor`, not a fixed `flush(n)`.**
  `deviceController.test.ts` runs on fake timers with `setImmediate` left real, because the
  commit path awaits `rm`. A fixed number of yields passed in isolation and failed
  intermittently under parallel load. Anything asserting on post-`rm` state should wait on a
  condition.
