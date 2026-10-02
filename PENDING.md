# Pending

The backlog: work not yet done, claims not yet proven, and things that could bite. Add an item
when it comes up rather than leaving it in conversation. When one ships, delete its entry and add
one line to **Recently resolved** at the foot, with the commit, so nothing disappears silently.

Where things stand on hardware: the **reference board** (Pi 3B+, WM8960 HAT, three buttons, three
lamps — `docs/hardware.md` § The reference board) proved buttons, lamps, audio both ways, the
hotspot and WhatsApp linking on the bench, 2026-09-30. **The Pi Zero 2 W target has run none of
it.** There is no git remote, so CI has never run on GitHub either.

Ordered roughly by priority within each group.

---

## Known gaps

### The admin panel does not block while the box restarts after a save

Every config save restarts the daemon. Today `noteRestarting()` in `public/admin/main.ts` changes
the status line and `waitForDeviceThenReload()` polls `/api/status` every 500 ms (40 tries) and
reloads when it answers — but the page stays live in the meantime, so a parent can keep editing a
panel whose server is gone. Wanted: an overlay that blocks the page from the save until the poll
succeeds, and says so if it never does.

### Read-only mode is invisible everywhere except the admin card that sets it

`config.mode.readOnly` has two deliberate gaps:

- **No feedback at all during quiet hours.** The refusal is the "oops", and the "oops" is silenced
  in silent mode, so at night a hold on a read-only box produces nothing but the lamp under the
  finger. Consistent with a failed send (`docs/PRODUCT.md` §7), but it is the moment a child is
  most likely to keep trying. A short LED refusal overlay ranked beside `sentFlash` would answer it
  without sound; it is new vocabulary in §6 and a new rung in the priority ladder.
- **Nothing reports the mode but the config.** `DeviceStatusPayload` (`src/ipc/events.ts`) does not
  carry it, so the simulator readout and the admin status line say nothing about a box that cannot
  send. One field on the IPC contract.

### A read-only box answers a long tap on a blinking button with the "oops"

`readOnly` refuses **at** `recordThresholdMs` (150 ms) in `buttonInterpreter.ts`, before a press can
be told from a tap, so any press over 150 ms on a blinking button gets "that did not send" instead
of playing the note — and a toddler's tap is often 300 ms. The listen-first rule solved the same
problem by withholding the microphone and deciding at release (`docs/architecture.md` § A blinking
button does not record). The same treatment would fix read-only, at the cost of moving its refusal
off the bip moment, which `docs/PRODUCT.md` §1 argues for. Needs a judgement, probably different for
a button with notes waiting and one without.

### Silent mode is invisible on the box, by design

While quiet mode is on the lamps look exactly like an audible idle box; only the transition chase
marks the moment it flips (`docs/PRODUCT.md` §6, pinned by `ledPriority.test.ts`). Accepted for now,
at these costs:

- **The mode cannot be read off the device.** The admin status line (`silent` /
  `silent (scheduled)`) is the only answer.
- **The chord's only feedback is that chase.** Cues are suppressed the instant the mode goes on. If
  the chase is ever cut, the chord becomes unobservable.
- **The scheduled edges still animate.** 20:00 and 07:00 run the chase unprompted — 1.5 s of light
  in a dark bedroom, kept because it is the only sign the schedule fired.

### The activity card and the health card leave out what a Pi can say

`docs/PRODUCT.md` §3 has both cards. Left out deliberately:

- **No undervoltage or throttling reading.** `vcgencmd get_throttled` is the one Pi-specific figure
  that explains a box behaving oddly rather than failing (a marginal supply throttles the SoC and
  can brown out the codec). Debug mode's sampler already records it, as root; the hardware unit
  cannot, because `vcgencmd` needs `/dev/vcio` and the `video` group. Widening
  `SupplementaryGroups=` in `bloopbox-hardware.service` is a privilege decision to make with a
  measurement in hand.
- **Memory reads pessimistically off-device.** Without `/proc/meminfo` it falls back to
  `os.freemem()`, which excludes the page cache, so a healthy Mac reads 99% used. The card says so.
- **Neither card is on the IPC contract.** Both poll `/api` (activity every 15 s, health every 5 s
  while open).
- **The totals count messages, not attempts.** A failed send now reaches the health card's
  "Recently" list as a `device fault`, but there is no count beside the success total. Whether
  "3 sent, 11 failed" is information or alarm needs deciding first.
- **Nothing tests the panel's rendering.** There is no browser test harness; both cards were checked
  by driving the page in Chrome and by testing their routes and store.

### A way to force the setup hotspot back up without pulling the card

Once a box is configured, the only way back to the setup flow is to pull the card and write
`bloopbox-wifi.txt` on the boot partition (`docs/deployment.md`). A family that moves or changes
router needs something better.

- **Reachable box:** the mechanism exists — `forget` in `NET_ACTIONS` (`src/net/netState.ts`)
  deletes the `bloopbox` profile and the supervisor's `unconfiguredGraceMs` path raises the hotspot.
  Missing is a control that calls it **without** the rest of the factory reset.
- **Unreachable box** — the case this is really for — needs a physical trigger. The silent chord
  (buttons 1 + 3 for `silentComboMs`) is the precedent; a Wi-Fi-forget chord would need a hold no
  toddler produces by accident and a cue no parent mistakes for silent mode.

Scope it narrowly: Wi-Fi only. Anything touching contacts, the admin password or WhatsApp is the
factory reset below, and a parent changing routers must not lose those.

### A factory reset does not change the ssh password

The password lives in `/data/ssh-password` and `/etc/shadow` (`docs/deployment.md` § The ssh
password), and the factory reset touches neither, so a box handed to a new family still accepts the
old owner's ssh login and shows the new owner the same password.

The fix is a `rotate-ssh-password` action for the root agent (the daemon cannot run `chpasswd` and
must not be able to) that re-runs `deploy/ssh-password.sh` with a fresh marker. The factory reset
would request it beside `forget`, and the panel could offer it on its own. **No longer blocked:** it
was held back until the agent's request channel was known not to replay requests, and the
acknowledgement-by-id was confirmed on the reference board on 2026-09-30.

Also: the reference board's current ssh password was pasted into a chat during the 2026-09-30 bench
session. Rotate it once this exists.

### A factory-reset control that wipes all user configuration

The panel half is built: "Recover from factory settings" (Advanced, two-step confirm) calls
`POST /api/factory-reset`, which deletes `/data/config.json`, clears the WhatsApp auth directory and
asks the agent to `forget` the Wi-Fi profile, then restarts. Covered by `routes.test.ts`. Still open:

- **No physical trigger**, which is the case it was asked for: a box nobody can reach. The bar is
  higher than the silent chord's — a hold well past `maxRecordingSeconds`, and a confirmation the LED
  vocabulary can express. §6's patterns are all spoken for, so a new one needs a rung in
  `ledPriority.test.ts`, not just a cue.
- **An imager-seeded network survives the reset.** `forget` deletes only the profile bloopbox
  manages, so a box built with `--wifi-ssid` rejoins after a reset instead of offering a hotspot.
  Fine until a real device makes it confusing.
- **Not run on hardware.** `forget` has only met a stubbed agent. Reset a configured device and
  confirm the hotspot comes back rather than the box silently rejoining; add it to
  `docs/hardware-bringup.md`'s gates.

### AP hotspot / captive portal for onboarding

Built and proven on a radio and a phone, 2026-08-10: a blank image raised `bloopbox-XXXX`, the
captive portal popped up by itself, and a join from the portal brought the box online with
`system.configured: true`. The design — NetworkManager's own AP mode rather than `hostapd`, an open
network, root doing the networking through files in `/run`, the timings — is in `docs/PRODUCT.md`
§3, `docs/deployment.md` and `docs/architecture.md`. What is left:

- **The agent has no fallback of its own.** If the daemon crashes, nothing raises the hotspot. The
  agent should raise it itself after ~5 min unassociated, unconfigured and with no requests.
- **No terminal state.** A box with neither the real network nor a working hotspot retries forever
  and has no way to say so.
- **Hardening the open AP, if it is ever needed.** While the hotspot is up on an unconfigured box,
  anyone in radio range can complete onboarding (accepted: the window is short and the box holds
  nothing). The answer is physical presence — a button press within N seconds to accept
  `POST /api/onboard` and `POST /api/wifi/join` — not a shared secret, which would be published in
  this repository. All three buttons are now proven on the reference board, so this is no longer
  blocked on hardware, only on wanting it.
- **The regulatory domain defaults to `DE`.** `ensure_radio_unblocked` in `deploy/net-agent.sh` sets
  `AP_COUNTRY` (default `DE`) only when the domain reads `00`, because an image built without
  `--wifi-ssid` never sets a country and Pi OS will not let the radio transmit until something
  does. `DE` is the bring-up location, not a claim about where a box ships; asking during
  onboarding may be better, but the radio has to be unblocked before onboarding can ask anything.
- **`hotspot-test.sh` prints "the web server is stopped" unconditionally.** With `--keep-daemon`
  passed it is wrong. Make the paragraph conditional, and suggest `--keep-daemon` whenever the run
  will be looked at from a phone — without it `10.42.0.1` answers nothing, which looks exactly like
  a broken portal.

### What quiet hours should do on a clock that has not synced — an open product decision

A Pi has no real-time clock: until NTP answers it runs on the time its last shutdown saved, so a
box unplugged overnight and plugged in at 07:30 may believe it is still 20:15 and stay silent — or
the reverse. The purge TTL and debug mode's deadline read the same clock. The root agent publishes
`timeSynced` (`true` / `false` / `null`), and the health card and `bloopbox-doctor` show it (true
within a minute on the reference board), but **nothing acts on it**, on purpose. "Treat quiet hours
as unknown until synced" has no obvious meaning for a toddler's box: audible risks waking a child,
silent risks a morning where Grandma's note never plays, and a box with no internet may never sync.
Decide which failure is worse, and whether a box that has synced once this boot counts, before
writing code.

### A raw 64-hex Wi-Fi key gets through the agent, and nothing else lets it through yet

WPA2 takes an 8–63 character passphrase or the 64-hex key itself. `deploy/net-agent.sh` passes
exactly 64 hex characters through whole (`scripts/test-onboarding.sh` step 9 proves it), but
everything upstream caps at 63: the length check in `POST /api/wifi/join` (`src/server/routes.ts`),
`wifiSchema.password` in `src/config/schema.ts`, and the `maxlength` on the portal's and the admin
panel's inputs. Accept `^[0-9A-Fa-f]{64}$` beside `.max(63)` in those four places.

### Read-only root filesystem needs /data on its own partition

`docs/PRODUCT.md` §8 wants the root filesystem read-only through overlayfs so a power cut cannot
corrupt the OS. `scripts/build-sd-image.sh` deliberately does not enable it: `/data` lives on the
root filesystem, so every config write and the WhatsApp credentials would land in a RAM overlay and
vanish on reboot — a worse failure, and a silent one.

Give `/data` its own ext4 partition (label `bloopdata`, mounted from fstab); then
`raspi-config nonint do_overlayfs 0` is safe. The catch: Pi OS expands the **last** partition on
first boot, so a third partition after the rootfs breaks auto-expand. Put `/data` before the rootfs,
or size the rootfs at build time and expand in the image builder.

**Acceptance:** pulling power during a settings save leaves the OS and the previous config intact,
and `sudo bloopbox-doctor` reports `/data` writable and `/` read-only.

### The units' `MemoryMax` values add up to more than the board has

192M (hardware) + 288M (bridge) + 48M (net agent) + 48M (debug sampler) = 576M, on a Zero 2 W with
512 MB, before the kernel, NetworkManager, journald and the page cache. The caps cannot all be
reached at once, so a system-wide OOM is possible below every one of them. The units already say
who dies first (`OOMScoreAdjust=-500` on the hardware unit, `+300` on the bridge — confirmed on the
reference board; `docs/deployment.md` § The systemd units).

The values are guesses and are **unchanged on purpose**: lowering them blind trades an unlikely OOM
for a likely one. Measure first — debug mode's sampler records `memHardware` and `memWhatsapp`
every 10 s; the peak across a WhatsApp pairing, a media download and a few inbound notes is the
number to size from. Before trusting any of it, check `grep -o cgroup_enable=memory /proc/cmdline`:
Pi firmware turns the memory controller off on small boards, `install.sh` appends
`cgroup_enable=memory cgroup_memory=1`, and without it no `MemoryHigh`/`MemoryMax` is enforced at all
(`docs/hardware-bringup.md` has the check). Then watch that the two daemons do not start OOM-killing
each other where they silently did not before.

### No liveness: a wedged daemon stays "active" forever

A daemon whose event loop is stuck (a sync loop, a wedged native call) keeps its unit `active`, the
buttons dark, and nothing notices. `RuntimeWatchdogSec=15s` covers a wedged kernel, not a wedged
process. Not done blind: `Type=notify` on a unit that never sends `READY=1` is killed at
`TimeoutStartSec` and restarted forever. Now that the plain units are proven on the reference board,
this is the next step. The design:

- **`Type=notify`, `NotifyAccess=all`, `WatchdogSec=30`** on `bloopbox-hardware` (later the bridge).
- **Sent with no native addon.** Node's `dgram` has no `AF_UNIX` datagram socket and every npm
  `sd-notify` is native, so spawn systemd's own `systemd-notify` (Trixie ships 257):
  `execFile('systemd-notify', ['--ready'])` and `['WATCHDOG=1']`. The child is not the main PID,
  hence `NotifyAccess=all`. 257's `systemd-notify` waits for the manager to process the message by
  default (`--no-block` opts out), which closes the race where a short-lived sender exits before
  systemd attributes it — **confirm that on the device; the design rests on it.** Guard every call
  on `process.env.NOTIFY_SOCKET` so a dev machine never spawns anything.
- **`READY=1` after the HAL is initialised and the server is listening**, so "active" means
  "buttons answer".
- **`WATCHDOG=1` from a `setInterval`** of `WATCHDOG_USEC / 2`, `unref()`'d. A timer is the right
  probe: if it cannot fire, neither can the loop that times button presses.
- **Not available on this OS:** `RESTART_RESET=1`, which would let a long-healthy daemon reset the
  `RestartSteps` ladder so late settings saves stop paying the 5 s cap. Newer than 257 (absent from
  257.13's binaries, checked 2026-09-24).
- **Verify:** `systemctl show bloopbox-hardware -p WatchdogUSec -p NotifyAccess`, then
  `kill -STOP` the node process and watch systemd restart it within ~30 s (`Watchdog timeout` in
  `journalctl -u bloopbox-hardware`).

### Audio-HAT profile: the codec is not autodetected and does not self-heal

`install.sh` resolves the profile as `explicit flag > /etc/bloopbox/profile > inferred from the
environment > usb`, refuses to downgrade without `--force`, doctor checks profile and `config.txt`
agree, and the health card names a missing card (`docs/deployment.md` has the flags). What is not
done, measured on the reference board on 2026-09-08:

| Question | Answer | How |
| -------- | ------ | --- |
| HAT ID EEPROM, so the firmware self-configures? | **No** | `/proc/device-tree/hat/` absent |
| Codec probeable without the overlay? | **Yes** | SMBus quick-write at `0x1a` on `/dev/i2c-1` ACKs; `0x1b`, `0x50`, `0x60` give `Remote I/O error` |
| Probe available in every profile? | **Yes** | `i2c_arm` uses GPIO 2/3, clear of buttons and lamps |
| Overlay loadable at runtime, no reboot? | **Yes** | `dtoverlay wm8960-soundcard`: card enumerates both ways (as card 1), `bloopbox-audio-init` passes, `aplay` plays |

The control interface is write-only, so the probe must be a quick-write (a read-byte probe misses a
present codec), and `I2C_SLAVE_FORCE` is needed once the driver has claimed `0x1a`.

- **Autodetect on a first install,** where there is no record to read.
- **Self-heal at boot.** `bloopbox-audio-init.service` already detects a missing card. When `0x1a`
  also ACKs, it could load the overlay, wait for the card, then repair `config.txt` — no reboot, so
  no reboot loop. The rule must be **heal, repair, and still report**: healing that hides a
  misconfiguration only moves the silence somewhere harder to find.
- **The LEDs say nothing about it.** A new pattern is a product decision (a new `docs/PRODUCT.md`
  section), so it was not taken unilaterally.

### `--audio-hat wm8960` promises i2c-tools and the SD-image path does not deliver it

`install.sh --audio-hat wm8960` installs `i2c-tools`, but the image builder runs the installer with
`--skip-deps` and installs only `RUNTIME_PACKAGES` itself, which does not include it. Nothing in the
product needs it; it is the tool for talking to the codec directly, so its absence turns a
diagnostic into a silent no-op. Add it to the image builder for wm8960 images, or stop promising it.

### On-device doctor duplicates the tsx one

`npm run doctor` (`scripts/doctor.ts`) cannot run on the device — the release carries no
devDependencies — so `deploy/doctor.sh` covers the same ground in bash. Two implementations drift.
Compile the checks into `dist/` (a `dist/doctor.js` the bash wrapper calls) so the device runs the
same code CI does.

### Coverage: the known holes

The gate enforces coverage as a ratchet in `vitest.config.ts` (the numbers live there only). Thin,
largest first:

- **`src/whatsapp/`** — the rest of `client.ts`: pairing-code and group-listing glue, LID resolution.
- **`src/audio/`** — the ffmpeg pipeline's error paths.
- Three timeout paths in `bridgeLink.ts` (send 60 s, pairing 20 s, groups 10 s), deliberately
  uncovered: they need fake timers, which do not mix with real sockets.
- `src/server/simulatorTransport.ts` is excluded and deliberately untested — the browser end of a
  debugging tool that never runs on a device. `bridgeLink.test.ts` is the template if that changes.

### CI has never run on GitHub

There is no git remote, so `.github/workflows/` has only been read, not run. Unproven until it
does: the `dorny/paths-filter` outputs (an empty output reads as "run everything", so the failure is
a slow pipeline, not a skipped gate), the `type=gha` Docker layer cache passed through
`BUILDX_EXTRA_ARGS` (a miss is not an error; the env block is deletable), and the rest of what the
2026-10 review added. **Branch protection must require the aggregating `ci` check**, set by hand
once the repository exists. No npm workspaces, on purpose — the root `CLAUDE.md` has why; if that
ever changes, re-run `npm run release:smoke`.

### View-once voice notes are ignored — a product decision nobody has made

`voiceNoteContent` in `whatsapp/client.ts` unwraps `ephemeralMessage` (disappearing chats) and
nothing else, so a note sent as **view once** never reaches the box and the sender is told nothing.
Options: keep ignoring it (today, and the safe default); play it once and delete it even if the
child stops half-way, which breaks "interrupted goes back to the front"; or treat it as an ordinary
note, ignoring what the sender asked for. Not `normalizeMessageContent` either way — it unwraps
edits and more, each a new shape a group member could put on a child's button.

### Baileys cannot draw the waveform on a sent voice note

Every send logs `Failed to generate waveform: Cannot find package 'audio-decode'`. The send succeeds
and the note plays, but the PTT bubble on the recipient's phone has no waveform bars. For a product
whose whole output is voice notes, that is worth a dependency — check a real phone screen first.

### The website cannot be published yet

`website/` is complete as a site but:

1. **The repository URL is a placeholder.** `website/lib/site.ts` guesses
   `github.com/sergiobehrends/bloopbox`; every GitHub link derives from it.
2. **Nothing hosts `out/`.** CI builds it as an artifact; no host or domain exists.
3. **No social preview image.** `openGraph` in `app/layout.tsx` has no `images`.
4. **`npm audit` reports four advisories** (2026-10-02): `next` (critical), `postcss`, `sharp` and
   `nanoid` (high). The offered fix is `next@16.3.8`, outside the exact `16.2.12` pin, plus
   `npm audit fix` for `nanoid`. Bump and re-run `npm run check`.

The line that must hold: **no copy may imply the device is buyable or shipping.** Every call to
action is "build one". The home page deliberately has no status section and no LED table; the
reference lives in `docs/PRODUCT.md` §6 and the manual, and the honest list is this file. The site
has no ESLint (`npm run check` is `tsc --noEmit` plus the export).

### The build manual ships with two placeholders

`/manual/` shows its gaps on the page rather than hiding them:

1. **The card image cannot be downloaded.** Step 1's button points at an empty releases page, and
   the manual says so. A tagged release now builds the right one (`-wm8960-sd.img.xz`, for the
   tested 3B+ with the WM8960 HAT; `docs/deployment.md` § CI), so this closes with the first tag,
   which needs a remote first.
2. **The waitlist form posts nowhere.** `waitlist.endpoint` in `website/lib/site.ts` is
   `https://example.invalid/...`. The site is a static export, so it must post to a third-party
   endpoint (Formspree, Buttondown, a Google Form). While `waitlist.configured` is false the panel
   says the form is not wired up — silently discarding an email address is worse. The copy says
   twice that no kit exists and this is not a pre-order; do not let a rewrite soften that.

The manual's LED ladder (`website/components/LightSignature.tsx`) ports the keyframes from
`box/software/public/brand/brand.css` at identical timings — a **third copy** after `src/core` and
the brand kit, and nothing checks the three agree. The authority is `docs/PRODUCT.md` §6.

### The site's nav disappears on a phone

Below 56rem `.nav` in `website/components/SiteHeader.module.css` is `display: none`, so on a phone
the only ways to the manual are the hero's "Build one yourself" and the footer. A disclosure button
is the obvious fix and would be the site's first interactive chrome. (The header takes its links as
a prop because both pages' links are anchors into themselves.)

### The manual prints, but it prints badly

`chrome --headless --print-to-pdf` on `/manual/` gives 21 complete pages, but sections break
wherever they land (half-empty pages), and the dark band and footer print as full-bleed navy across
most of three pages. `break-inside: avoid` on the step blocks and a print rule that drops the night
band to paper would fix both.

### The display face is a system stack, not the brand's own letterform

`docs/BRAND.md` asks for an ultra-bold rounded geometric sans. The box's `--font-display`
(`public/shared/tokens.css`) starts with `ui-rounded` (SF Pro Rounded on Apple, for zero bytes) and
falls back to Nunito / Quicksand / Varela Round / `system-ui`, so **on Android or Linux the box's
four UIs show the system face**. The website ships Nunito through `next/font`, so the two surfaces
differ off Apple. Deliberate: the portal is served from a Pi over its own hotspot, and a late font
is a page a parent stares at. Revisit only with a subsetted self-hosted WOFF2 (Latin, the two
weights used), `font-display: swap`, and a measured first paint on a real phone over the hotspot.

### The mark is drawn twice and copied twice more, and nothing enforces that the four agree

`box/software/public/shared/bloopbox-mark.svg` (line art, for 24 px and up) and
`bloopbox-favicon.svg` (flat colour fields) are separate drawings that must agree on five colours
and on the button order — **yellow, coral, teal**. The logo and iso files are copies of
`website/public/`, as is the palette in `website/app/tokens.css`: deliberate (the two share a brand,
not a build), but a colour change is four files.

The copy is mechanical, so a guard is cheap: strip everything before the first `<path`, replace
`class="ink"` with `fill="black"`, and the rest must be byte-identical to the site's file (true for
`bloopbox-iso-light.svg` on 2026-10-02). It reads across packages, which the decoupling rule argues
against inside a box test, so it wants to be a root-level script or a `.githooks/pre-commit` step.
A colour assertion would fail today — next entry.

### The refined artwork's hexes are not the brand palette, and the site's dark logo is a bad export

Both want fixing **in `website/public/`** and re-copying, because the box copies it path for path:

1. **The artwork's colours are not the tokens.** It draws `#F3B333`, `#F0776C`, `#0B97C4`; the
   tokens say `#f7b733`, `#ff6f61`, `#00a7e1`. Teal is visibly duller, so `/brand/` §1 shows a mark
   whose teal does not match the swatch below it. Retint the artwork or move the palette — once.
2. **`bloopbox-logo-dark.svg` is wrong.** Not a clean ink swap: the pill's left arc is teal where it
   should be yellow, the button outlines stay black (invisible on navy), and it has an extra white
   backing path. `bloopbox-iso-dark.svg` is fine. `/brand/` §1 shows the bad one on purpose,
   captioned; the site uses it for real through `website/components/Lockup.tsx`.

Also: `website/app/layout.tsx` points `icons.icon` at `bloopbox-favicon.svg`, the old speech-bubble
drawing rather than the refined iso, and the site's `bloopbox-mark.svg` is the old drawing with no
reference left.

### The three product pages pick the light-inked mark unconditionally

`/brand/` picks between the light- and dark-inked files with `<picture>` and a
`prefers-color-scheme` `<source>`. The portal and the admin panel hard-code
`bloopbox-iso-light.svg` and the simulator `bloopbox-logo-light.svg`, so **in dark mode the outline
is black on navy** — on the first screen a parent sees. The fix is the same few lines in each page,
plus moving `.lockup picture { display: flex; flex: none; }` from `brand.css` into `base.css`.

Alongside, not urgent: `docs/BRAND.md` § "There is no reversed asset — but the mark's ink does
switch, in-file" describes the old single-file mechanism, now true only of the favicon; and
`.lockup-hero .lockup-mark` is a 5.5rem square around a 279 × 118 logo, so the hero letterboxes
(`height: 5.5rem; width: auto` is probably the answer, but it is a base.css change for a variant only
the brand kit uses).

---

## Verification gaps

Built but not proven. Not bugs — claims nobody has tested. `docs/hardware-bringup.md` is the order
to prove them in.

### The Pi Zero 2 W has never run any of it

Everything proven so far ran on the reference board's Pi 3B+. The target differs in ways that
matter: **512 MB** (see the `MemoryMax` entry), **no analogue audio jack** (so nothing the 3B+ says
about playback carries over without the HAT), four slower cores (the `loudnorm` decode and the
helper deadlines were sized on the 3B+ and on a desk), and a sealed enclosure where throttling is a
real risk. `RaspberryPi_Zero2W` is the default `PI_BOARD` and resolved the right lines on the 3B+;
the override exists for a board that does not agree. `src/hal/gpioDriver.ts` keeps its
`TODO(hardware)` banner until this is done.

### Rebooting the box is not verified on real hardware

`reboot` and `poweroff` are on the root agent's allowlist; the chain was checked on macOS against
`deploy/net-agent.sh` with a stubbed `systemctl`, including an injected
`{"action":"poweroff; touch /tmp/pwned"}` being dropped. Not checked: that `systemctl poweroff`
succeeds from inside `bloopbox-net.service`'s sandbox (`NoNewPrivileges=yes`,
`ProtectSystem=strict`) on Trixie. It runs as root and talks to systemd over D-Bus, which none of
those block — reasoning, not measurement. Add it to `docs/hardware-bringup.md`'s gates.

### The restart backoff cap has not been watched on a device

The restart policy itself is confirmed on the reference board (`StartLimitIntervalUSec=0`, backoff
5 / 5 / 3 steps, caps 5 s / 1 min / 15 s). Not yet seen: six config saves in a row reaching the 5 s
cap on the hardware unit, which is what a parent fiddling with settings produces.

### The capture and helper-process hardening is tested against fake children only

Each was written against a mocked `child_process`; `docs/architecture.md` § Audio has the
reasoning.

- **`arecord` exiting by itself.** A stop after arecord has died returns at once and logs
  `arecord exited before the recording was stopped` with its stderr. Nobody has seen a real early
  exit (an adapter pulled mid-take, a rate the codec refuses). Check the take is refused with the
  "oops" and the warning reaches the journal.
- **Duration from the WAV size.** `(size − 44) / (rate × 2 × channels)` assumes the canonical
  44-byte header. The bench reported a ~5 s hold as `sentMs: 4128`; check that against `ffprobe` on
  the capture, at `CAPTURE_RATE=16000` and `48000`.
- **Deadlines.** ffmpeg gets 30 s + 2× the audio (5 min if unknown), amixer 5 s — margins from desk
  measurements, not a loaded Zero 2 W decoding with `loudnorm` beside a capture.
- **Arrival decodes beside a capture** are held while `arecord` is open and reniced to 10. Nobody
  has measured whether a decode already running when a take starts still causes overruns (look for
  `overrun!!!`). If it does, hold capture-side work or SIGSTOP the decode.
- **amixer warnings.** A wrong `ALSA_MIXER_CONTROL` should log at `warn` with amixer's stderr, and a
  correct box should log nothing at boot.

### Audio tuning still wants an ear

The measured work is in `docs/audio-quality.md`; what measurement could not settle:

- **`micGainPercent` 65** leaves ~10 dB of headroom against a MacBook speaker at a normal level. A
  child's mouth is not a MacBook speaker — confirm by ear, including a child shouting at 10 cm.
- **The 400–800 Hz lift** is the microphone and enclosure. A corrective cut is justified but
  deliberately unspecified: an octave table cannot set a notch's depth and Q.
- **Whether the microphone is mechanically coupled to the enclosure** — a mechanical fix no filter
  substitutes for.

### The designed cues have only been measured, not judged

`boot` and `notify` are designed recordings (`src/audio/samples/`) mastered to a declared `peak` in
`scripts/generate-sounds.ts`; the other four are synthesised tones. Three things to listen for in
gate 4a's audio pass:

1. **Whether the designed cues sit at the same loudness as the beeps.** They were matched by peak,
   but a sustained sound reads louder than a 90 ms click at the same peak. If `notify` is obviously
   hotter than `pop` and `oops`, lower its `peak` and leave the tones alone.
2. **Whether `boot` is too long under the boot LED chase**, and reads as "the box came back".
3. **The tail trim.** Trimming stops `MIN_SILENCE_S` (100 ms) after the last audible window and keeps
   `TAIL_PAD_S` (30 ms), so a cue with a long soft decay could be clipped — audible as a cut,
   invisible in the numbers.

### Browser microphone capture

The glue is proven (two holds in a real Chrome sent voice notes WhatsApp accepted, 2026-08-01:
`MediaRecorder` → WebM/Opus → Socket.io → ffmpeg → Ogg/Opus → Baileys), but `getUserMedia` was
stubbed with an oscillator. A real capture device — permission prompt, sample rate, channel count,
a slow-starting mic — has never been in the path, and `minRecordingMs` discards on captured audio
precisely because a slow start is expected.

### Simulator playback timing

In headless Chrome each 140 ms clip took ~5 s to report `ended` (no audio device to drive the media
clock). Order and completion were right. Confirm the speed in a real browser with speakers.

### WhatsApp end to end with a real account

Proven against a real account: QR pairing, the group picker, contacts surviving a restart, send and
receive for a group and an individual, playback, unread counts, purge, and messages sent while both
daemons were off arriving from WhatsApp's own queue on reconnect. The reference board linked on
2026-09-30. Still to run, all in `docs/hardware-bringup.md` gate 6:

- **A note from a number nobody assigned is dropped** — the negative case the safety boundary exists
  for.
- **A group note from a third party**, not from the account that owns the device.
- **Read receipts across a bridge restart** (`2d6a584`): restart the bridge with a note waiting,
  play it, and check the sender gets both ticks.

### The pairing-race fix is not yet reverified on hardware

On 2026-08-10 neither QR nor phone-number pairing would complete on a real device: the panel
offered both at once, and a second `requestPairingCode` could land on a socket mid-QR. Fixed
(`3c9cb18`): the panel asks for one method first, a second request is rejected while one is in
flight, and an unpaired box opens no socket until a parent picks a method (`notLinked`,
`POST /api/whatsapp/link`). Covered by `whatsappClient.test.ts`, `bridgeLink.test.ts` and
`routes.test.ts`, and run locally against real WhatsApp. On hardware, run gate 6's phone-number
path, an unlink-then-relink, and switching between the methods a few times. If a correctly
formatted number still fails with WhatsApp's generic "couldn't link device", the open upstream
Baileys issues (WhiskeySockets/Baileys#2679, #2488) are the next suspect.
`journalctl -u bloopbox-whatsapp -f` carries Baileys' own lines (`"lib":"baileys"`).

### The connection lifecycle fixes of 2026-09-24 are verified against a fake socket only

An unscanned QR settles in `notLinked`, `#connect` is generation-guarded, and 440 / 403 are terminal
— locked by `whatsappLifecycle.test.ts` against `FakeWASocket`. On hardware, cheapest first:

- Leave a QR unscanned ~3 minutes: the panel returns to the method picker, one
  `whatsapp connection closed` at 408, no `reconnecting` after it.
- Scan a QR: the 515 that follows reconnects at once (`delayMs: 0`) and ends `connected`.
- Boot a copy of a linked card in a second box: one side stops at 440 instead of both flapping.

**The 440 detail string does not reach the panel.** The hardware server logs it from `wa:status`,
but `onStatus` keeps only `state` and `qr`, and `GET /api/whatsapp` has no field for it, so a parent
sees `disconnected` with nothing saying retrying will not help.

### "Delete for everyone" has only met a fake socket

Not yet seen with a real account: that a revoke arrives on `messages.update` while the box is
online, and — more interesting — when it was sent **while the box was off**, since the offline
queue arrives as `append`. Also unchecked: a group admin deleting someone else's note (should work —
the chat is whitelisted, not the revoker). Not handled: the activity card's received total still
counts a revoked note, and a revoke for a note mid-playback is dropped (it is deleted as heard
anyway).

### The upload bound assumes at most two media hosts

`MEDIA_UPLOAD_TIMEOUT_MS` (20 s) is applied by Baileys per host, in turn, as an idle timeout. With
two hosts stalling a send fails in ~40 s, inside the hardware side's 60 s; with three or more it can
outlive the "oops", and the late `sendResult` is dropped — a note the recipient got and the box said
had failed. Log `hosts.length` from one real send to settle it.

### The admin panel feels sluggish during pairing

Reported 2026-08-01, never measured. The first suspect is addressed but not timed on a Pi: every
admin request ran a ~300 ms bcryptjs check on the event loop, and `AdminAuthenticator` now runs it
once per browser per 5 min. Still unexamined, cheapest first: the pairing ticker polls
`/api/whatsapp` every 2 s (every tick once a code has lapsed), and `getJson` has no timeout, so a
slow bridge stacks latency; each QR rotation refetches `qr.svg`, re-rendered server-side. Close this
only after timing the panel on a Pi.

### `dtparam=audio=off` may not be doing what its comment says

`install.sh` writes `dtparam=audio=off` **after** `dtoverlay=wm8960-soundcard`, and in `config.txt`
a `dtparam` after a `dtoverlay` is a parameter of that overlay, not of the base DTB. With the overlay
commented out the Headphones card came back (2026-09-08), so the single-card outcome probably comes
from the overlay, and the comment ("One card, so ALSA `default` cannot land on the wrong one") may
claim something the line does not do. Harmless while ALSA is addressed by name. Check `aplay -l` on
a normal boot; if it shows two cards, move the line above the overlay.

### The brand implementation has only been seen in headless Chrome on macOS

Every page was screenshotted in both schemes, but on one engine. Unverified: `ui-rounded` off Apple,
the in-SVG `prefers-color-scheme` inversion in a captive-portal webview (iOS
`SFSafariViewController`, Android Custom Tabs), `ctx.roundRect` on a parent's browser, and the
`.choice` row's `aria-checked` styling under a screen reader. The fallbacks all "look plainer", none
"does not work".

---

## Watch items

Not work, but things that could bite.

- **The three lamps draw their current from the header itself.** The lamps are 3 V, so each hangs
  between its GPIO pin and ground with no driver. A BCM283x pin sources 16 mA comfortably and the
  header wants under ~50 mA in total, and the LED matrix lights all three at once routinely — a real
  but thin margin that depends on which lamps are fitted. No ammeter yet; take one at gate 5. Dim
  lamps, a lamp that dims when its neighbours light, or a brownout on a marginal supply all point
  here. If a transistor turns out to be needed, `setLed` is the same call.
- **How much of a first word the microphone misses.** The "pop" plays at `recordThresholdMs` and
  `arecord` spawns once it has finished, so the dead window is 150 ms + 90 ms of cue + however long
  ALSA takes to open a stream on the WM8960 — **that last term has never been measured.** If a child
  who starts on the bip loses a syllable, look at the stream open, not the cue.
- **`CAPTURE_RATE=48000` may no longer be necessary.** It exists because the codec cannot hold two
  rates on one I²S clock and the cues are 48 kHz. No cue plays over an open capture any more (the
  bip finishes first, D-06; the inbound chime is dropped, D-17), except the admin panel's **Test
  speaker** pressed mid-take. Full duplex at a matched 48 kHz works; a mismatched pair failing was
  never tested. Not changed blind: `install.sh` writes it and the failure mode is a silent recording.
- **An empty password hash opens the API even when `configured` is true — accepted, on purpose.**
  `requireAdmin` stands aside when `system.configured` is false **or** `adminPasswordHash` is empty,
  so a config in that half-written state leaves `/api` open on the LAN. It should be unreachable —
  `POST /onboard` and `POST /wifi/join` write the hash and the flag in one `config.update()` — so it
  takes a hand-edited `config.json`.

  **Decision: leave it.** The guard cannot tell "mid-onboarding" from "corrupted", so refusing to
  serve would turn a recoverable box into one that needs the card pulled, in a house with no screen.
  An open API on a family LAN is the smaller failure. Pinned by `src/tests/adminAuth.test.ts`
  ("stands aside when configured is true but no hash was ever written") — change that test only once
  a recovery path exists.

- **A send that fails is dropped, not retried — accepted, on purpose.** `#commitCapture` catches the
  failure, plays the "oops" and abandons the file for the purge; there is no outbound queue.

  **Decision: leave it.** Inbound is worth recovering because the sender was told it was delivered
  and nobody in the house knows it is missing. Outbound is different: the person who recorded it is
  standing at the box, and a restarting box or its error lights are visible. Retrying would also mean
  writing a child's voice somewhere more durable than a RAM disk, a cost with no matching benefit.

  The failure is logged as a `device fault` of kind `send` and shows in the health card's "Recently"
  list. `Oops` is silenced in silent mode, so during quiet hours a failed send makes no sound and no
  sent-flash — the LED error pattern is the only sign.

- **The carry-on window leaves its own silence in the file.** `resumeGraceMs` keeps the microphone
  open after release, so every message carries up to 400 ms of trailing room noise per gap and at
  the end, and that silence counts toward `minRecordingMs`. Accepted in place of stitching segments
  (`docs/architecture.md`). If the tail annoys on real hardware, trim at encode time.
- **A default that moves is not a migration.** `mergeConfig` keeps what `/data/config.json` holds,
  so a changed default (e.g. `minRecordingMs` 500 → 1000, 2026-09-08) reaches only freshly set-up
  boxes. Rewriting old values would also overwrite a value a parent chose on purpose, and nothing
  records which values were set explicitly.
- **Baileys is pinned to a release candidate** (`7.0.0-rc14`, what `latest` points at). An unofficial
  WhatsApp surface that can break from WhatsApp's side at any time; `legacy` (6.7.24) is the
  fallback. `box/software/CLAUDE.md` § Baileys 7 notes has the API differences.
- **A group target trusts every member of that group.** The deliberate reading of "assign the family
  chat to a button", but adding someone to the group gives them a channel to the child without
  touching the device. The extension, if needed, is a per-group participant allowlist.
- **If a device goes dark on every interface again**, treat it as new. On 2026-08-10 the 3B+ dropped
  off Wi-Fi and Ethernet four times; every occurrence ran agent code with bugs since fixed
  (`f8c89eb`), and nothing recurred after, but nothing was captured that pins the mechanism. Turn on
  a persistent journal first (`bloopbox-debug on`, `docs/hardware-bringup.md`) — without it the
  evidence goes with the reboot.
- **The brand kit ships to the device, ungated.** `/brand/` is static HTML with no secrets, built
  alongside what it documents on purpose (`vite.config.ts` says why). If it ever matters, drop the
  entry from release builds or put it behind `requireAdmin`.
- **The site's entrance animations are engine-gated: Firefox gets none, by design.** They use
  `animation-timeline: view()` inside `@supports`, so a browser without it never applies the hidden
  `from` state. Not a bug when someone screenshots the site in Firefox. Verified in Chrome only,
  including `prefers-reduced-motion` and `print`, where no block stays hidden.
- **oxlint's `--rules` prints nothing** in 1.76, so valid rule names have to be read out of
  `node_modules/oxlint/configuration_schema.json`. An unknown name is a hard config error.
- **opengpio 2.0.2 transposes `bias` and `debounce`** in its native call. Worked around by passing no
  options (`box/software/CLAUDE.md`). Revisit if a fixed release appears.
- **The Pi OS image pinned in `packaging/versions.env` will go stale.** Bump `PI_OS_RELEASE`,
  `PI_OS_IMAGE` and `PI_OS_SHA256` together. Watch first-boot mechanisms changing underneath
  `scripts/build-sd-image.sh`: the 2026-06 Trixie images use a bare `resize` token in `cmdline.txt`,
  still ship a `pi` user plus `userconfig.service`, and carry inert cloud-init templates on the boot
  partition that a future release could make live.
- **`libgpiod` soname churn.** The addon links `libgpiodcxx.so.2` / `libgpiod.so.3` from Trixie's
  `libgpiod3` (upstream 2.2.x). A Debian moving to libgpiod 3.x would break it as Bookworm's 1.6
  does today — loudly, as a CI build error.

---

## Recently resolved

One line each, newest first. The commit holds the detail; where the reasoning lives now is named.

- **`bloopbox-doctor` failed the two mic-boost levels on every WM8960 box** — 2026-10-02. A `Name=Value` entry is now read as a level and its value compared; green on the reference board.
- **The inbound chime could be recorded into a child's message** — 2026-10-02. A note arriving mid-take now lights its lamp without a chime (D-17).
- **Read receipts survive a bridge restart** — 2026-10-02, `2d6a584`. `wa-<i>-<id>.key` beside each
  note (`whatsapp/readKeys.ts`, `docs/architecture.md`). Device check is in "WhatsApp end to end".
- **Baileys' credentials written atomically** — 2026-10-02, `8d032e8`. `whatsapp/authState.ts`; a
  last-good copy was left out on purpose (atomic writes cannot leave a bad file, and a second copy on
  the same card does not survive the card).
- **Coverage enforced as a ratchet** — 2026-10-01, `97d1669`. `vitest.config.ts`.
- **Bench session 2026-09-30** — reference board, `f0df8c5`, `efd9872`. Fresh `--audio-hat
  wm8960` card, onboarded through the hotspot, WhatsApp linked, debug mode on. Proven: all three
  buttons; all three lamps with default polarity, yellow / coral / teal left to right; audio both
  ways; the lockout; the silent chord both ways; a short hold refused with the "oops"; the restart
  policy, OOM scores and journald drop-ins (Pi OS's `40-rpi-volatile-storage.conf` sorts before ours,
  so `50-bloopbox` and debug mode's `90-` both apply); `timeSynced: true` within a minute. Two
  findings, both fixed and re-confirmed on the box the same evening:
  - **Switch bounce** (`ff2630f`): 42 of 75 edge bursts bounced, up to 12 edges in 15 ms, 17 opening
    with an `up`. `hal/settledLine.ts` restarts a `BUTTON_SETTLE_MS` (20 ms) quiet window on every
    edge and emits only a changed level. After: a 3 s hold settled as one down and one up 2904 ms
    apart, three taps as 316 / 308 / 278 ms, nothing unpaired.
  - **A button with no contact recorded anyway** (`2621947`): it now refuses at `recordThresholdMs`
    with `recordBlocked` reason `unassigned` and never opens the microphone
    (`docs/PRODUCT.md` § A button with no contact).
- **First-boot ssh password** — `12a10cf` (2026-09-24), verified on a real first boot 2026-09-30:
  `userconfig` renamed `pi` → `bloop`, then `bloopbox-ssh-password` ran, then `sshswitch`, then sshd;
  record `0640 root:bloopbox`, marker gone, the panel's password logged in.
- **The root agent acknowledges requests by id** — `2603c6d` (2026-09-24), verified 2026-09-30:
  `systemd-run -p ProtectSystem=strict touch /run/bloopbox/x` fails, confirming the old `rm -f` could
  never have worked; a join ran exactly once and the request file was gone.
- **Nothing plays over a note** — `31b8421` (2026-09-24), verified 2026-09-30: a second note
  mid-playback neither chimed nor cut in; **Test speaker** mid-note left the note unread and it
  replayed from the start (`docs/architecture.md` § Nothing plays over a note).
- **An MVP-profile SD image boots** — a flashed `--audio-hat wm8960` image ran the whole 2026-09-30
  session. The lampless `--no-leds` image and its board no longer exist.
- **The reference board's GPIO** — `e9cc214` (2026-10-01): every line claimed with the intended
  direction (`gpioinfo`, 2026-08-10), pull-ups from `config.txt`, the `RaspberryPi_Zero2W` map
  correct on a 3B+, and the bench above. What remains is the Zero 2 W.
- **The WM8960 board's documented assumptions** — card `wm8960soundcard`, mixers `Playback` /
  `Capture`, active-low buttons — all held on the bench. Measured traps (the three capture settings,
  LINPUT1, `cset` for the ADC volume, MICBIAS not needed, registers read only during capture) are in
  `docs/hardware.md`.
- **The `cmd | grep -q` tripwire in the release smoke test** — `13367a0` (2026-09-06); now enforced
  for every script by `shellScripts.test.ts` (`b5c3318`). It passed only because the page fit the
  64 KB pipe buffer: the dangerous version of the trap is the silent one.
- **A blinking button does not record** — `2cdeddb` (2026-09-08). Also retired the watch item about a
  tap past 150 ms opening the microphone before a queue plays: a blinking button no longer opens it.
- **The audio-HAT profile is persisted and cannot silently downgrade** — `1a2f9ed`. An upgrade run
  without `--audio-hat` had left the box silent since 2026-09-07. `docs/deployment.md` has the
  precedence; open parts are in "Audio-HAT profile".
- **The manual's illustrations exist** — `400536f` (2026-09-08).
- **Inbound loudness normalised, capture filtered and the mic gain lowered** — `781a1df`
  (2026-09-06). `PLAYBACK_FILTER_CHAIN` (`loudnorm`, in `prepare()`'s decode, never on cues) and
  `CAPTURE_FILTER_CHAIN`, `micGainPercent` 65; `docs/audio-quality.md`.
- **Inbound notes survive a power cut** — `c222008` (2026-09-06). `/data/notes`; reasoning in
  `src/audio/directories.ts` and `docs/architecture.md`.
- **The buttons are 30 mm** — `19a06bc` (2026-09-06), everywhere that said 60 mm.
- **The setup hotspot works on a radio and a phone** — `f8c89eb` (2026-08-10). Three bugs fixed:
  `key-mgmt none` meant WEP (open networks need the security setting removed, in both `ap_up` and
  `join_network`); the portal's join raced `wifi-apply.sh` and reported a correct passphrase as wrong
  (now confirmed by polling `joined_ssid()`); an image with no Wi-Fi never set a country, so the radio
  was blocked (`ensure_radio_unblocked`). `ap_up` failures now reach `lastError`.
- **Sending a voice note killed the bridge, and the restart reported "never linked"** — `d7dfbe3`
  (2026-08-10). `TMPDIR=/run/bloopbox-tmp` (reasoning in `bloopbox-whatsapp.service`) and `isPaired()`
  (reasoning in `whatsapp/client.ts`). The live drop-in went with the reflash.
- **`RuntimeDirectorySize=` removed; the memory controller turned on** — `d7dfbe3`, `382c0dc`
  (2026-08-10). Not a real per-service directive; cgroup v2 charges tmpfs pages to the writer, so
  `MemoryMax` is what bounds `/run/bloopbox` (unit comments).
- **Both audio directions on the WM8960** — `382c0dc` (2026-08-10): inbound Ogg is decoded before
  `aplay`, and capture is unmuted and boosted.
- **`requestPairingCode` sent `0049…` as typed** — `3c9cb18` (2026-08-10). It now reuses
  `normalisePhone`.
- **CI path filter** — `278584b` (2026-08-02). The `changes` job and the aggregating `ci` check
  (the CI section of the root `CLAUDE.md`); never run, see "CI has never run on GitHub".
- **Unread notes recovered at boot** — `0e3a3aa` (2026-08-01). The directory is the ledger; 8 h window
  (`RECOVERY_MAX_AGE_MS`), restored silently (`docs/architecture.md`). Notes from before the filename
  carried the button index were skipped as unattributable rather than guessed.
