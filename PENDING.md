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
Pi Zero 2 W. Pin numbers, ULN2003 polarity and ALSA device names are all unverified. See
`docs/hardware-bringup.md` (to be written in Phase 4) and the `TODO(hardware)` banner in the
driver. Contained behind the HAL, so bring-up should be a debugging session rather than a
rewrite.

### Simulator playback timing

In headless Chrome each 140ms clip took ~5s to report `ended`, because there is no audio output
device to drive the media clock. Order and completion were correct. Worth confirming on a real
browser with speakers that playback runs at the right speed.

---

## Watch items

Not work, but things that could bite.

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
- **Tests that depend on filesystem work must use `waitFor`, not a fixed `flush(n)`.**
  `deviceController.test.ts` runs on fake timers with `setImmediate` left real, because the
  commit path awaits `rm`. A fixed number of yields passed in isolation and failed
  intermittently under parallel load. Anything asserting on post-`rm` state should wait on a
  condition.
