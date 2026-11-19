# Pending

What is still missing, and nothing else. Add an item when it comes up rather than leaving it in
conversation. When one ships, delete its entry in the same commit: the commit is the record, and
whatever reasoning outlives the work belongs in the document that owns the subject. What the box has
proven is in `docs/hardware-bringup.md` § What the reference board has proven.

**Verified hardware: the reference board** — a Raspberry Pi 3B+ with the Waveshare WM8960 Audio HAT,
three buttons and three lamps (`docs/hardware.md` § The reference board). It is the one board
releases are built for and proven on gate by gate. A Raspberry Pi 4 Model B (1 GB) was also
confirmed working on 2026-11-19, not yet recorded gate by gate. The Pi Zero 2 W is a later target
(below). CI runs on GitHub (`github.com/sbehrends/bloopbox`, public since 2026-11-19), green on
`main`; Dependabot is off.

Ordered roughly by priority within each group.

---

## Before 1.0

### After going public

The repository is public and `v1.0.0` is released (2026-11-19), with the SD image and the tarball
the manual's download button links to. The GPL-3.0 license, the site's link preview and phone menu,
its `npm audit` advisories and switching Dependabot off went in with it. What the flip left behind:

1. **The third-party skills went public with it.** `.agents/` and `.claude/skills/` are
   third-party skills, some tracked; check each one's license, or untrack them.
   `website/public/Gemini_Generated_Image_*.jpeg` and `why-2-box-old.jpeg` are tracked and
   unreferenced.
2. **Every commit's author email is public** (176 commits). Only a history rewrite and a force push
   would take it back, and forks or clones made since keep it regardless.
3. **Repository settings:** branch protection on `main` requiring the aggregating `ci` check,
   secret scanning with push protection, and private vulnerability reporting with a `SECURITY.md`
   pointing at it — the whitelist is a child-safety boundary, and its reports must not land in a
   public issue.
4. **Rotate the reference board's ssh password** before anything of it is shown (below).

**Never push tags with `--tags`.** `release.yml` builds and publishes on any `v*` push, and the ten
older local tags would each become a release; a guard in today's `release.yml` cannot stop that,
since each tag runs the workflow file of its own commit. Push a release tag by name.

The line that must hold: **no copy may imply the device is buyable or shipping.** Every call to
action is "build one".

### A factory reset does not change the ssh password

The password lives in `/data/ssh-password` and `/etc/shadow` (`docs/deployment.md` § The ssh
password), and the factory reset touches neither, so a box handed to a new family still accepts the
old owner's ssh login and shows the new owner the same password.

The fix is a `rotate-ssh-password` action for the root agent (the daemon cannot run `chpasswd` and
must not be able to) that re-runs `deploy/ssh-password.sh` with a fresh marker. The factory reset
would request it beside `forget`, and the panel could offer it on its own.

The reference board's password was pasted into a chat on 2026-09-30, and the `1.0.0-rc.1` card's on
2026-10-02. Rotate it once this exists (`passwd` on the box until then).

---

## Known gaps

### The admin panel does not block while the box restarts after a save

Every config save restarts the daemon. `noteRestarting()` in `public/admin/main.ts` changes the
status line and `waitForDeviceThenReload()` polls `/api/status` every 500 ms (40 tries), but the
page stays live meanwhile, so a parent can keep editing a panel whose server is gone. Wanted: an
overlay that blocks the page from the save until the poll succeeds, and says so if it never does.

### Read-only mode: invisible at night, and a long tap on a blinking button gets the "oops"

- **No feedback during quiet hours.** The refusal is the "oops", which silent mode suppresses, so
  at night a hold on a read-only box produces only the lamp under the finger. A short LED refusal
  overlay ranked beside `sentFlash` would answer it; that is new vocabulary in `docs/PRODUCT.md` §6
  and a new rung in the priority ladder.
- **Nothing reports the mode but the config.** `DeviceStatusPayload` (`src/ipc/events.ts`) does not
  carry it, so the simulator readout and the admin status line say nothing about a box that cannot
  send. One field on the IPC contract.
- **A long tap on a blinking button is refused.** `readOnly` refuses at `recordThresholdMs`
  (150 ms) in `buttonInterpreter.ts`, before a press can be told from a tap, and a toddler's tap is
  often 300 ms. The listen-first rule solved the same problem by deciding at release
  (`docs/architecture.md` § A blinking button does not record); the same treatment would fix this,
  at the cost of moving the refusal off the bip moment that `docs/PRODUCT.md` §1 argues for. Needs a
  judgement, probably different for a button with notes waiting and one without.

### The panel does not say why WhatsApp stopped at 440

A 440 means another device took over the link, and retrying will not help. The hardware server logs
the detail from `wa:status`, but `onStatus` keeps only `state` and `qr`, and `GET /api/whatsapp` has
no field for it, so a parent sees `disconnected` and nothing else.

### A raw 64-hex Wi-Fi key gets through the agent, and nothing else lets it through

WPA2 takes an 8–63 character passphrase or the 64-hex key itself. `deploy/net-agent.sh` passes
exactly 64 hex characters through (`scripts/test-onboarding.sh` step 9), but everything upstream
caps at 63: `POST /api/wifi/join` (`src/server/routes.ts`), `wifiSchema.password`
(`src/config/schema.ts`), and the `maxlength` on the portal's and the admin panel's inputs. Accept
`^[0-9A-Fa-f]{64}$` beside `.max(63)` in those four places.

### The setup hotspot has no fallback of its own

- **The agent cannot raise it alone.** If the daemon crashes, nothing raises the hotspot. The agent
  should raise it itself after ~5 min unassociated, unconfigured and with no requests.
- **No terminal state.** A box with neither the real network nor a working hotspot retries forever
  and has no way to say so.
- **The regulatory domain defaults to `DE`.** `ensure_radio_unblocked` in `deploy/net-agent.sh` sets
  `AP_COUNTRY` (default `DE`) only when the domain reads `00`, because an image built without
  `--wifi-ssid` never sets a country and Pi OS will not let the radio transmit until something does.
  `DE` is the bring-up location, not a claim about where a box ships.
- **`hotspot-test.sh` prints "the web server is stopped" unconditionally**, which is wrong with
  `--keep-daemon`. Make it conditional, and suggest `--keep-daemon` whenever the run will be looked
  at from a phone — without it `10.42.0.1` answers nothing, which looks like a broken portal.
- **Optional: hardening the open AP.** While the hotspot is up on an unconfigured box, anyone in
  radio range can complete onboarding (accepted, `docs/PRODUCT.md` § First Boot). If it is ever
  wanted, the answer is physical presence — a button press within N seconds to accept
  `POST /api/onboard` and `POST /api/wifi/join` — not a shared secret.

### A factory reset leaves an imager-seeded network behind

`forget` deletes only the profile bloopbox manages, so a box built with `--wifi-ssid` rejoins after
a reset instead of offering a hotspot. Fine until a real device makes it confusing.

### No liveness: a wedged daemon stays "active" forever

A daemon whose event loop is stuck keeps its unit `active`, the buttons dark, and nothing notices.
`RuntimeWatchdogSec=15s` covers a wedged kernel, not a wedged process. The design:

- **`Type=notify`, `NotifyAccess=all`, `WatchdogSec=30`** on `bloopbox-hardware` (later the bridge).
- **Sent with no native addon.** Node's `dgram` has no `AF_UNIX` datagram socket and every npm
  `sd-notify` is native, so spawn systemd's own `systemd-notify` (Trixie ships 257):
  `execFile('systemd-notify', ['--ready'])` and `['WATCHDOG=1']`. The child is not the main PID,
  hence `NotifyAccess=all`. 257's `systemd-notify` waits for the manager to process the message by
  default, which closes the race where a short-lived sender exits before systemd attributes it —
  **confirm that on the device; the design rests on it.** Guard every call on
  `process.env.NOTIFY_SOCKET` so a dev machine never spawns anything.
- **`READY=1` after the HAL is initialised and the server is listening**, so "active" means
  "buttons answer". A unit that never sends it is killed at `TimeoutStartSec` and restarted forever.
- **`WATCHDOG=1` from a `setInterval`** of `WATCHDOG_USEC / 2`, `unref()`'d: if a timer cannot
  fire, neither can the loop that times button presses.
- **Verify:** `systemctl show bloopbox-hardware -p WatchdogUSec -p NotifyAccess`, then
  `kill -STOP` the node process and watch systemd restart it within ~30 s.

`RESTART_RESET=1`, which would let a long-healthy daemon reset the `RestartSteps` ladder, is newer
than systemd 257.

### Read-only root filesystem needs /data on its own partition

`docs/PRODUCT.md` §8 wants the root filesystem read-only through overlayfs so a power cut cannot
corrupt the OS. `/data` lives on the root filesystem today, so enabling it would put every config
write and the WhatsApp credentials in a RAM overlay that vanishes on reboot.

Give `/data` its own ext4 partition (label `bloopdata`, mounted from fstab); then
`raspi-config nonint do_overlayfs 0` is safe. Pi OS expands the **last** partition on first boot,
so put `/data` before the rootfs, or size the rootfs at build time and expand in the image builder.
**Acceptance:** pulling power during a settings save leaves the OS and the previous config intact,
and `sudo bloopbox-doctor` reports `/data` writable and `/` read-only.

### Audio-HAT profile: the codec is not autodetected and does not self-heal

The profile is persisted and cannot silently downgrade (`docs/deployment.md`). Measured on the
reference board, 2026-09-08:

| Question | Answer | How |
| -------- | ------ | --- |
| HAT ID EEPROM, so the firmware self-configures? | **No** | `/proc/device-tree/hat/` absent |
| Codec probeable without the overlay? | **Yes** | SMBus quick-write at `0x1a` on `/dev/i2c-1` ACKs; `0x1b`, `0x50`, `0x60` give `Remote I/O error` |
| Probe available in every profile? | **Yes** | `i2c_arm` uses GPIO 2/3, clear of buttons and lamps |
| Overlay loadable at runtime, no reboot? | **Yes** | `dtoverlay wm8960-soundcard`: card enumerates both ways (as card 1), `bloopbox-audio-init` passes, `aplay` plays |

The control interface is write-only, so the probe must be a quick-write, and `I2C_SLAVE_FORCE` is
needed once the driver has claimed `0x1a`.

- **Autodetect on a first install,** where there is no record to read.
- **Self-heal at boot.** `bloopbox-audio-init.service` already detects a missing card. When `0x1a`
  also ACKs, it could load the overlay, wait for the card, then repair `config.txt` — no reboot, so
  no reboot loop. **Heal, repair, and still report**: healing that hides a misconfiguration only
  moves the silence somewhere harder to find.

### `--audio-hat wm8960` promises i2c-tools and the SD image does not deliver it

`install.sh --audio-hat wm8960` installs `i2c-tools`, but the image builder runs the installer with
`--skip-deps` and installs only `RUNTIME_PACKAGES`. Nothing in the product needs it; it is the tool
for talking to the codec directly. Add it to wm8960 images, or stop promising it.

### On-device doctor duplicates the tsx one

`npm run doctor` (`scripts/doctor.ts`) cannot run on the device — the release carries no
devDependencies — so `deploy/doctor.sh` covers the same ground in bash, and the two drift. Compile
the checks into `dist/` (a `dist/doctor.js` the bash wrapper calls).

### Baileys cannot draw the waveform on a sent voice note

Every send logs `Failed to generate waveform: Cannot find package 'audio-decode'`. The note sends
and plays, but the PTT bubble on the recipient's phone has no waveform bars. Worth a dependency for
a product whose whole output is voice notes — check a real phone screen first.

### The health card cannot read undervoltage

`vcgencmd get_throttled` is the one Pi-specific figure that explains a box behaving oddly rather
than failing (a marginal supply throttles the SoC and can brown out the codec). Debug mode's sampler
records it as root; the hardware unit cannot, because `vcgencmd` needs `/dev/vcio` and the `video`
group. Widening `SupplementaryGroups=` in `bloopbox-hardware.service` is a privilege decision to
make with a measurement in hand. Separately, nothing tests the panel's rendering: there is no
browser test harness.

### Coverage: the known holes

The gate enforces coverage as a ratchet in `vitest.config.ts`. Thin, largest first:

- **`src/whatsapp/`** — the rest of `client.ts`: pairing-code and group-listing glue, LID resolution.
- **`src/audio/`** — the ffmpeg pipeline's error paths.
- Three timeout paths in `bridgeLink.ts` (send 60 s, pairing 20 s, groups 10 s), uncovered because
  they need fake timers, which do not mix with real sockets.

### Website and brand

- **The manual prints badly.** Sections break wherever they land, and the dark band and footer print
  as full-bleed navy. `break-inside: avoid` on the step blocks and a print rule that drops the night
  band to paper.
- **The manual's LED ladder is a third copy.** `website/components/LightSignature.tsx` ports the
  keyframes from `box/software/public/brand/brand.css`, after `src/core` and the brand kit, and
  nothing checks the three agree. The authority is `docs/PRODUCT.md` §6.
- **The product pages pick the light-inked mark unconditionally.** The portal and the admin panel
  hard-code `bloopbox-iso-light.svg` and the simulator `bloopbox-logo-light.svg`, so in dark mode
  the outline is black on navy. `/brand/` already does it right with `<picture>`; copy that, and
  move `.lockup picture { display: flex; flex: none; }` from `brand.css` into `base.css`. Alongside:
  `docs/BRAND.md` § "There is no reversed asset" describes the old single-file mechanism, and
  `.lockup-hero .lockup-mark` letterboxes the hero logo.
- **The artwork's hexes are not the brand palette.** It draws `#F3B333`, `#F0776C`, `#0B97C4`; the
  tokens say `#f7b733`, `#ff6f61`, `#00a7e1`. Retint the artwork or move the palette, once, in
  `website/public/`, and re-copy (the box copies it path for path).
- **`bloopbox-logo-dark.svg` is a bad export**: the pill's left arc is teal, the button outlines stay
  black, and it has an extra white backing path. `/brand/` §1 shows it on purpose; the site uses it
  through `website/components/Lockup.tsx`. Also, `website/app/layout.tsx` points `icons.icon` at the
  old speech-bubble favicon, and the site's `bloopbox-mark.svg` is unreferenced.
- **Nothing enforces that the four copies of the mark agree.** `bloopbox-mark.svg` and
  `bloopbox-favicon.svg` are separate drawings that must agree on five colours and the button order
  (yellow, coral, teal), and the logo and iso files are copies of `website/public/`. A guard is
  cheap: strip everything before the first `<path`, replace `class="ink"` with `fill="black"`, and
  the rest must match the site's file byte for byte. It reads across packages, so it belongs in a
  root-level script or `.githooks/pre-commit`. A colour assertion would fail today (the hexes above).

---

## Verification gaps

Built but not proven on the reference board. `docs/hardware-bringup.md` is the order to prove them
in.

### WhatsApp

- **A group note from a third party**, not from the account that owns the device.
- **Read receipts across a bridge restart** (`2d6a584`): restart the bridge with a note waiting,
  play it, and check the sender gets both ticks.
- **Phone-number pairing, an unlink-then-relink, and switching methods a few times** — the
  pairing-race fix (`3c9cb18`) has not been rerun on hardware. If a correctly formatted number still
  fails with WhatsApp's generic "couldn't link device", the open Baileys issues
  (WhiskeySockets/Baileys#2679, #2488) are the next suspect.
- **The connection lifecycle** (only met `FakeWASocket`): a QR left unscanned ~3 minutes returns the
  panel to the method picker with one close at 408 and no reconnect; a scanned QR's 515 reconnects
  at once and ends `connected`; a copy of a linked card in a second box stops one side at 440
  instead of both flapping.
- **"Delete for everyone"** with a real account, online and — more interesting — sent while the box
  was off (the offline queue arrives as `append`), and a group admin deleting someone else's note.
  Not handled: the activity card still counts a revoked note.
- **The upload bound** assumes at most two media hosts: `MEDIA_UPLOAD_TIMEOUT_MS` (20 s) applies per
  host, so three stalling hosts can outlive the hardware side's 60 s and a delivered note reports as
  failed. Log `hosts.length` from one real send.
- **The admin panel felt sluggish during pairing** (2026-08-01, never measured). The bcrypt cost is
  now cached; still unexamined, the 2 s pairing poll with no timeout on `getJson`, and `qr.svg`
  re-rendered on every QR rotation. Time the panel on a Pi before closing it.

### The box

- **A factory reset on hardware.** `forget` has only met a stubbed agent: reset a configured device
  and confirm the hotspot comes back rather than the box silently rejoining.
- **Reboot and poweroff from the panel.** Checked on macOS against a stubbed `systemctl`; not that
  `systemctl poweroff` succeeds inside `bloopbox-net.service`'s sandbox (`NoNewPrivileges=yes`,
  `ProtectSystem=strict`). Add it to `docs/hardware-bringup.md`'s gates.
- **The restart backoff cap.** Six config saves in a row should reach the 5 s cap.
- **`dtparam=audio=off` may not do what its comment says.** It is written after
  `dtoverlay=wm8960-soundcard`, which makes it a parameter of the overlay, not the base DTB. Check
  `aplay -l` on a normal boot; if it shows two cards, move the line above the overlay.

### Capture and helper processes (only met fake children)

- **`arecord` exiting by itself** (an adapter pulled mid-take, a rate the codec refuses): the take
  should be refused with the "oops" and the warning reach the journal.
- **Duration from the WAV size** assumes a 44-byte header. A ~5 s hold reported `sentMs: 4128`;
  check against `ffprobe` at `CAPTURE_RATE=16000` and `48000`.
- **Deadlines** (ffmpeg 30 s + 2× the audio, amixer 5 s) are desk margins, not a loaded board.
- **An arrival decode already running when a take starts** — look for `overrun!!!`.
- **amixer warnings:** a wrong `ALSA_MIXER_CONTROL` should log at `warn`; a correct box nothing.

### Audio, by ear

- **`micGainPercent` 65** leaves ~10 dB of headroom against a MacBook speaker. Confirm with a child,
  including one shouting at 10 cm.
- **The 400–800 Hz lift** from the microphone and enclosure: a corrective cut is justified but its
  depth and Q are unspecified. Check too whether the microphone is mechanically coupled to the
  enclosure.
- **The designed cues** (`boot`, `notify`) were matched to the beeps by peak, but a sustained sound
  reads louder than a 90 ms click: if `notify` is hotter than `pop` and `oops`, lower its `peak`.
  Whether `boot` is too long under the boot chase, and whether the tail trim (`MIN_SILENCE_S`
  100 ms, `TAIL_PAD_S` 30 ms) clips a cue with a long decay.

### Browsers

- **The simulator's microphone** has only met a stubbed `getUserMedia`: a real permission prompt,
  sample rate and slow-starting mic have never been in the path. Its playback timing was only seen
  in headless Chrome, with no audio device to drive the media clock.
- **The brand implementation** has only been seen in headless Chrome on macOS: not `ui-rounded` off
  Apple, the in-SVG `prefers-color-scheme` inversion in a captive-portal webview, `ctx.roundRect` on
  a parent's browser, or the `.choice` row under a screen reader.

---

## Later — not for 1.0

- **The Pi Zero 2 W.** It has run none of this. It differs where it matters: **512 MB**, where the
  units' `MemoryMax` values (192M hardware + 288M bridge + 48M agent + 48M sampler = 576M) add up to
  more than the board; **no analogue audio jack**; four slower cores (the `loudnorm` decode and the
  helper deadlines were sized on the 3B+); and a sealed enclosure where throttling is a real risk.
  Measure memory with debug mode's sampler before resizing anything, and check
  `grep -o cgroup_enable=memory /proc/cmdline` first, or no limit is enforced at all.
  `src/hal/gpioDriver.ts` keeps its `TODO(hardware)` banner until then.
- **A count of failed sends on the activity card.** Failures already reach the health card's
  "Recently" list as a `device fault`. Whether "3 sent, 11 failed" is information or alarm needs
  deciding first.
- **The display face.** The box's UIs use a system stack (`ui-rounded` first), so on Android or Linux
  they show the system face while the website ships Nunito. Revisit only with a subsetted
  self-hosted WOFF2 and a measured first paint on a real phone over the hotspot (`docs/BRAND.md`).

---

## Watch items

Not work, but things that could bite.

- **The three lamps draw their current from the header itself.** 3 V lamps hang between their GPIO
  pin and ground with no driver: a pin sources 16 mA comfortably and the header wants under ~50 mA
  in total, and the LED matrix lights all three at once routinely. No ammeter yet. Dim lamps, a lamp
  that dims when its neighbours light, or a brownout all point here; a transistor would not change
  `setLed`.
- **How much of a first word the microphone misses.** The dead window is 150 ms + 90 ms of cue +
  however long ALSA takes to open a stream on the WM8960, which has never been measured.
- **`CAPTURE_RATE=48000` may no longer be necessary.** No cue plays over an open capture any more
  (D-06, D-17), except **Test speaker** pressed mid-take. A mismatched rate pair failing was never
  tested, and the failure mode is a silent recording, so it is not changed blind.
- **The carry-on window leaves its own silence in the file** — up to 400 ms per gap and at the end,
  counted toward `minRecordingMs`. If the tail annoys, trim at encode time.
- **A default that moves is not a migration.** `mergeConfig` keeps what `/data/config.json` holds,
  so a changed default reaches only freshly set-up boxes.
- **Baileys is pinned to a release candidate** (`7.0.0-rc14`), an unofficial WhatsApp surface that
  can break from WhatsApp's side at any time; `legacy` (6.7.24) is the fallback.
- **A group target trusts every member of that group.** Adding someone to the group gives them a
  channel to the child without touching the device. The extension, if needed, is a per-group
  participant allowlist.
- **If a device goes dark on every interface again**, treat it as new: turn on a persistent journal
  first (`bloopbox-debug on`), or the evidence goes with the reboot.
- **The brand kit ships to the device, ungated.** Static HTML with no secrets; drop it from release
  builds or put it behind `requireAdmin` if it ever matters.
- **The site's entrance animations are engine-gated**: Firefox gets none, by design
  (`animation-timeline: view()` inside `@supports`).
- **oxlint's `--rules` prints nothing** in 1.76; valid rule names are in
  `node_modules/oxlint/configuration_schema.json`, and an unknown name is a hard config error.
- **opengpio 2.0.2 transposes `bias` and `debounce`.** Worked around by passing no options; revisit
  if a fixed release appears.
- **The pinned Pi OS image will go stale.** Bump `PI_OS_RELEASE`, `PI_OS_IMAGE` and `PI_OS_SHA256`
  together, and watch the first-boot mechanisms `scripts/build-sd-image.sh` relies on (the bare
  `resize` token, the `pi` user and `userconfig.service`, the inert cloud-init templates).
- **`libgpiod` soname churn.** The addon links Trixie's `libgpiod3` (upstream 2.2.x); a move to 3.x
  would break it, loudly, as a CI build error.
