# Pending

Work identified but not yet done. Add items here as they come up rather than losing them in
conversation; move them out when they ship.

Ordered roughly by priority within each group.

---

## Features

### The activity card and the health card are read-only; some of what a Pi can say is missing

Both landed 2026-09-06 (`docs/PRODUCT.md` §3). What was deliberately left out:

- **No undervoltage or throttling reading.** `vcgencmd get_throttled` is the one Pi-specific figure
  that explains a device behaving oddly rather than failing — a marginal USB supply throttles the SoC
  and can brown out the codec, and nothing else on the health card would show it. `vcgencmd` needs
  `/dev/vcio` and the `video` group, which the hardware unit does not have; adding it means widening
  `SupplementaryGroups=` in `bloopbox-hardware.service`, which is a real privilege decision and not
  one to make without a device on hand to measure whether the reading is even useful.
- **Memory reads pessimistically off-device.** `/proc/meminfo`'s `MemAvailable` is the right number
  and is what the device uses; anything else falls back to `os.freemem()`, which excludes the page
  cache and reports a healthy Mac at 99% used. The card says so in words rather than hiding the row.
  There is nothing to fix on a Pi, but a developer will meet it every time.
- **Neither card is on the IPC contract.** Both poll `/api`. Pushing them over the existing
  Socket.io status channel would be tidier and is not obviously worth an `events.ts` change; the
  activity card refreshes on a 15 s interval and the health card on 5 s while open.
- **The totals count messages, not attempts.** A parent diagnosing "she presses it and nothing
  happens" wants the *failed* sends, which are exactly what is not counted (deliberately — see the
  table in `docs/architecture.md`). A separate failure counter beside the success one would answer
  both questions; it needs a decision about whether "3 sent, 11 failed" is information or alarm.
- **Nothing tests the panel's rendering.** There is no browser test harness in this project at all,
  so both cards were verified by driving the real page in Chrome and by covering their routes and
  their store. Consistent with the rest of `public/`, and worth knowing before trusting a refactor of
  either render function.

### Rebooting the box is not verified on real hardware

`reboot` and `poweroff` were added to the root agent's allowlist on 2026-09-06. The chain was
verified end to end on macOS against `deploy/net-agent.sh` with a stubbed `systemctl` — the daemon
writes the request, the agent parses it, deletes it, and calls `systemctl poweroff`, and an injected
`{"action":"poweroff; touch /tmp/pwned"}` is dropped by the allowlist without running anything. What
is **not** verified is that `systemctl poweroff` succeeds from inside `bloopbox-net.service`'s
sandbox (`NoNewPrivileges=yes`, `ProtectSystem=strict`) on a real Trixie box. It runs as root and
talks to systemd over D-Bus, which none of those directives block, but that is reasoning rather than
a measurement. Add it to `docs/hardware-bringup.md`'s gate list.

### Normalise the loudness of inbound voice notes on decode (`loudnorm` / `dynaudnorm`)

Raised 2026-08-16 from a live device: at maximum volume playback is still underwhelming.

`toPlayableWav()` in `box/software/src/audio/ffmpeg.ts` is a bare Opus→PCM decode with no gain
stage anywhere in it, so a received note plays back at whatever level the sender's phone happened
to record — and a voice note held at arm's length in a kitchen is quiet. Raising
`speakerVolumePercent` scales the noise floor along with it; normalisation is the thing that
actually changes *perceived* loudness, and it is the single largest win available on the playback
path.

Two candidate ffmpeg filters, and the choice is a real trade-off:

- **`loudnorm`** (EBU R128) is the correct one, and **two-pass is now on the table** — it was not
  when this was written. The decode moved off the tap-to-play path on 2026-08-17 (`hal.prepare()`
  runs it when the note *arrives*, see `docs/architecture.md` § Audio), so a second pass costs a
  little more CPU while nobody is waiting rather than latency a child notices. Single-pass with an
  explicit target (`I=-16` or louder, plus a true-peak ceiling so the class-D amp does not clip) is
  still the safer first move; two-pass is worth measuring now that it is affordable.
  **Whichever is chosen, it belongs in `prepare()`'s decode, not only in `play()`'s fallback** — the
  fallback decode still happens on the tap, so the two must produce audio of the same loudness or a
  purged-and-re-decoded note plays back noticeably different from every other one.
- **`dynaudnorm`** is frame-based and much cheaper, but it pumps on speech with pauses in it, which
  is exactly the shape of the material here.

Constraints on whoever does this:

- **Cues must not go through it.** `boot` and `notify` are mastered to a decided peak in
  `scripts/generate-sounds.ts`, and normalising them would undo that and break the premise of
  `soundFiles.test.ts`. `playCue` does not decode at all, so confining the filter to `play()` keeps
  this true by construction — but it is worth saying, because "add it to the ffmpeg helper" is the
  obvious wrong move.
- Measure the CPU cost on the target board, not on a laptop. The decode is already a few hundred
  milliseconds of a Pi's time and this adds to it.

This is one half of the loudness question. **The analogue half is now done** — measured on the real
HAT 2026-08-17 and shipped: `Speaker` powered up at −20 dB and both class-D boosts at 0, worth about
26 dB in total, and all three are now `config.audio.ampVolumePercent` / `ampBoostDc` / `ampBoostAc`
with an admin **Test speaker** button. The table is in `docs/hardware.md`. So this entry is purely
about source material that is quiet before it reaches the amplifier, which no amount of gain fixes
without lifting the hiss with it.

### Read-only mode is invisible everywhere except the admin card that sets it

Added 2026-09-06 with `config.mode.readOnly`. Two gaps, both deliberate for now:

- **No feedback at all during quiet hours.** The refusal is the "oops", and the "oops" is silenced
  in silent mode — so at night a hold on a read-only box produces nothing but the lamp under the
  finger. That is consistent with a failed send behaving the same way (`docs/PRODUCT.md` §7), but
  it is the one moment a child is most likely to keep trying. A short LED refusal overlay, ranked
  beside `sentFlash`, would answer it without sound; it would also be new LED vocabulary in §6 and
  a new row in the priority ladder, so it is not free.
- **Nothing reports the mode but the config.** `DeviceStatusPayload` does not carry it, so the
  simulator readout and the admin status line say nothing about a box that cannot send, and a
  developer testing read-only has only the checkbox to go on. Adding it is one field on the IPC
  contract.

### An installed box keeps `minRecordingMs: 500` until somebody changes it

The default went to 1000 ms on 2026-09-08 (`docs/PRODUCT.md` §1, step 6), and a **default is not a
migration**: `/data/config.json` already holds 500 on every device that has been set up, and
`mergeConfig` keeps what is there. So the box the empty notes came from still sends them until
either the parent types 1000 into **Button timings** in the admin panel, or the file is edited and
the daemon restarts.

Deliberately not migrated, because a config value cannot be told apart from one a parent chose:
rewriting 500 to 1000 on load would also overwrite a device somebody had tuned to 500 on purpose.
Worth revisiting only as part of a general "defaults that moved after release" mechanism — which
would need a record of what was set explicitly, and there is none today.

### A read-only box answers a long tap on a blinking button with the "oops"

Pre-existing, noticed 2026-09-08 while adding the listen-first rule and left alone.

`readOnly` refuses **at** `recordThresholdMs` (150 ms), before a press can be told from a tap, so on
a read-only box any press over 150 ms on a blinking button gets "that did not send" instead of
playing the note — and a toddler's tap is often 300 ms. The listen-first rule hit exactly this and
solved it by withholding the microphone and deciding at release instead (`docs/architecture.md`, "A
blinking button does not record"); the same treatment would fix read-only, at the cost of moving its
refusal off the bip moment, which `PRODUCT.md` §1 argues for on its own merits. Worth doing when
somebody next has a read-only box in front of them: it needs a judgement about which matters more,
and the answer probably differs for a button with notes waiting and one without.

### Silent mode is now invisible on the box, by design — the box cannot be asked

Changed 2026-09-08: the outer-pair heartbeat (0.1 s every 4 s) was removed, so while quiet mode is
on the lamps look exactly like an audible idle box. Only the transition chase remains, at the
moment it flips in either direction. `docs/PRODUCT.md` §6 and the ladder in
`docs/architecture.md` are updated; `ledPriority.test.ts` now pins the darkness.

What that costs, and is accepted for now:

- **There is no way to read the mode off the device.** The admin status line still says `silent` /
  `silent (scheduled)` (`public/admin/main.ts`), and that is the only answer. A parent who missed
  the chase — or a toddler who produced it by accident — cannot tell a quiet box from a normal one
  without opening the panel.
- **The chord's own feedback is that single chase.** Cues are suppressed the instant the mode goes
  on, so entering silent mode is confirmed by lamps only. If that chase is ever cut too, the chord
  becomes completely unobservable.
- **The scheduled edges still animate.** 20:00 and 07:00 run the chase unprompted, which is a light
  moving by itself in a dark bedroom. Left in on purpose — it is 1.5 s, once, and it is the only
  sign the schedule fired — but it is the obvious next thing to want gone.

### The capture chain clips, and its analog gain buys no SNR

Measured on the device 2026-09-06 — full write-up in [`docs/audio-quality.md`](docs/audio-quality.md).
Reported as noise and an echoey quality on outgoing messages; the measurement says the input is
**clipping**, which is what that usually sounds like.

- Ambient room tone, nobody speaking, peaks at **−0.38 dBFS** at the shipped gain. No headroom.
- SNR is flat at ~14–16 dB across a 24 dB range of analog gain, so turning the preamp up buys
  nothing and spends all the headroom. The device measured had `micGainPercent: 100`.
- The noise is **low-frequency**: 20–100 Hz is 12 dB above 300–1000 Hz. A high-pass at 100–120 Hz
  removes the largest component at no cost to a voice.
- Encoding already costs ~2.8 s for a 10 s note **before the whoosh plays**, and cleaning the signal
  makes Opus *faster*, not slower — 1627 ms vs 2770 ms with denoise in the chain.

Confirmed with **real speech** — macOS `say` played from the MacBook beside the box — not just a
sweep: at the shipped gain a normal speaking level peaks at exactly 0 dBFS. At `micGainPercent` 60
the same voice peaks at −10.7 dBFS, and `speechnorm` puts 12 dB of level back, ending *louder* than
the clipped original (−14.4 vs −16.5 dB RMS) with peaks off the rail.

The 400–800 Hz lift **is** the microphone and enclosure: the sweep was repeated from the MacBook,
an unrelated transducer, and the peak survived the swap (+2.6 dB via the HAT, +4.5 dB via the Mac).
A corrective cut is justified in principle but deliberately unspecified — an octave table is too
coarse to set a notch's depth and Q, and it is the one change that makes things worse if fitted to
the wrong curve.

Ordered fixes are in the doc. The first needs no code at all — `micGainPercent` is already a config
field — though the exact value still wants confirming by ear, since a child's mouth is not a
MacBook speaker.

### Loading after config save

When a change is made in the Admin, the server restarts. Add a loading in the admin page that blocks the page. Ping the server until is back responsive.

### The website is a first iteration, and three things are still missing

The marketing site landed on 2026-08-02: `website/`, a statically exported Next.js 16 site. It is
complete as a site — a full-bleed photographic hero, one section per argument, and since
2026-09-06 a second page at `/manual/` carrying the whole build — but it cannot be published as it
stands.

Worth knowing before editing it: **the page deliberately carries no status or limitations section
and no LED reference table.** Both were written and then cut — its job is to make a parent want one
and click through to the repository, which is where the reference (`docs/PRODUCT.md` §6) and the
honest list (this file) live. The line that must hold instead: **no copy on the page may imply the
device is buyable or shipping.** Every call to action is "build one".

1. **The repository URL is a placeholder.** `website/lib/site.ts` guesses
   `github.com/sergiobehrends/bloopbox` because this repository still has no git remote. Every
   GitHub link on the page derives from that one constant, so all of them are currently wrong.
2. **Nothing hosts `out/`.** CI builds it and uploads it as an artifact; no host is configured, and
   no domain is registered.
3. **No social preview image.** `openGraph` declares a title and description but no `images`, so a
   shared link renders as a bare text card.

Smaller, and deliberate: the site has **no ESLint** (`npm run check` is `tsc --noEmit` plus a full
export), and `npm audit` reports three high advisories that are all transitive inside Next itself
(`postcss`, `sharp`) — the offered fix is `next@9`, so they stand until Next ships past them.

### The build manual ships with placeholders, and one of them is a parts conflict

`/manual/` landed on 2026-09-06 — the parts list, the wiring and the setup walkthrough, written for
a parent rather than for this repository. Four things in it are deliberately unfinished, and they
are visible on the page rather than hidden, because a manual that quietly omits its gaps is one
nobody remembers to finish.

1. ~~**The buttons are 30 mm on the site and 60 mm in `docs/hardware.md`.**~~ **Settled 2026-09-06:
   the part is 30 mm**, the standard arcade action-button size, matching the parts actually bought
   and photographed in `website/public/parts-photo.jpg`. The old 60 mm figure and its rationale
   ("big enough for a 2-year-old's whole hand") are gone from all six places that carried them —
   `docs/hardware.md` twice (the part and the enclosure cut-outs), `docs/PRODUCT.md` §2,
   `README.md`, `box/hardware/README.md`, and a `BUTTON_RADIUS` comment in the simulator. The
   enclosure's cut-outs are **30 mm** with it.
2. **Six of the nine illustrations do not exist.** Each renders as a dashed placeholder carrying
   the prompt that will generate it, sharing one house-style clause defined in
   `website/components/Figure.tsx`. Replacing one is a two-word edit: drop `prompt`, add `src`. The
   three that *do* exist — the finished device, the parts flat-lay and the family roster — came with
   the branch as `Gemini_Generated_Image_*.jpeg` and were renamed to URL-safe names.
3. **The card image cannot be downloaded.** Step 1's button points at the releases page, which is
   empty, and the manual says so in a note rather than pretending. It needs a published
   `--audio-hat wm8960` build; see `docs/deployment.md` for what produces one.
4. **The waitlist form posts nowhere.** `website/lib/site.ts` carries `waitlist.endpoint` as
   `https://example.invalid/...`. The site is a static export, so the form has to post to a
   third-party endpoint (Formspree, Buttondown, a Google Form) — there is no Route Handler to add.
   While `waitlist.configured` is false the panel renders a visible setup note admitting the form is
   not wired up, which is deliberate: silently discarding a parent's email address is worse.

**The line about not implying the device is buyable still holds, and the form is the place it is
most likely to erode.** The copy says twice, in the body and in the note under the button, that no
kit exists and that this is not a pre-order. Do not let a rewrite soften that into a waitlist for a
product — there is no product.

One thing the manual settled that the home page had left open: the **LED reference now exists on the
site**, in the manual's dark band, as the box's own animated lamp ladder rather than as a table —
`website/components/LightSignature.tsx` ports the keyframes out of
`box/software/public/brand/brand.css` at identical timings, and adds the three-flash "delivered"
burst the kit has no rung for. That is not a reversal of the decision to keep the reference off the
home page — the split is the point. The marketing page sells and stays clean; the manual documents,
and a parent who has just built a box needs to know what solid means.

**It is now a third copy of those timings**, after `src/core` and the brand kit, and nothing
enforces that the three agree — the same shape of problem as the mark being drawn twice and copied
twice more, below. The authority remains `docs/PRODUCT.md` §6.

### The site's chrome is shared, and its nav is not

Adding `/manual/` turned the header and footer into `website/components/SiteHeader.tsx` and
`SiteFooter.tsx`, lifted out of `app/page.module.css` unchanged. The header takes its section links
as a prop rather than owning a list, because both pages' links are anchors **into themselves** — a
shared list would send a reader on the manual back to the home page to find "How it works".

Still open: **below 56rem the nav is `display: none` entirely**, so on a phone the only ways to the
manual are the hero's "Build one yourself" and the footer. That predates the manual and is now
carrying more weight than it was designed to. A disclosure button is the obvious fix and would be
the site's first piece of interactive chrome.

### The monorepo defers one thing now that there is a second package

The repository became a monorepo on 2026-08-02 (`box/software`, `box/hardware`, `website`, root
`docs`). Two decisions were deliberately **not** taken. `website/` now has a `package.json`, which
was the trigger for both; one has since been done, and the first is still open **on purpose**.
Recorded in `website/README.md` too, which is where someone starting that work will actually look.

1. _No npm workspaces_, still. The trigger has arrived and the answer has not changed: hoisting
   `node_modules` to the repo root moves it away from the tree
   `box/software/scripts/build-release.sh` assumes, and the two packages share no dependency worth
   deduplicating — they are not even allowed to import from each other. A root `package.json` with
   `workspaces: ["box/software", "website"]` buys tidier installs and costs a release script;
   if it is ever taken, **re-run `npm run release:smoke` afterwards**, because hoisting is exactly
   what it would break, and the failure would be a device tarball missing a dependency rather than
   a build error.
2. ~~_No CI path filter._~~ **Done** on 2026-08-02: a `changes` job gates `box-gate`,
   `box-package`, `website` and `docs-links`, and the aggregating `ci` job is what branch protection
   must require — a job skipped by `if:` passes, whereas `on: push: paths:` would make a required check
   never report and block the PR forever. Two things about it are **not yet proven on a real
   runner**: the `type=gha` Docker layer cache passed through `BUILDX_EXTRA_ARGS` (a cache miss is
   not an error, and the env block in `ci.yml` is deletable if it misbehaves), and the
   `dorny/paths-filter` outputs themselves — the fail-safe reads an empty output as "run
   everything", so the failure mode is a slow pipeline rather than a skipped gate.

   **Branch protection still has to be repointed** at the `ci` check by hand; until that happens the
   old required checks (`check`, `package`) no longer exist under those names.

Worth knowing about the layout itself, since it is easy to undo by accident: `scripts/`, `deploy/`,
`packaging/` and `.dockerignore` must stay in `box/software/` **together**, because every release
script derives its root from its own location rather than from git. And `.githooks/` must stay at the
**repo root**, because `core.hooksPath` resolves relative paths against the top of the working tree —
a hook under `box/software/` is never found.

### A way to force the setup hotspot back up without pulling the card

Requested 2026-08-10, right after the hotspot path was first proven end to end. Today there is
exactly one way back onto the setup flow once a device is configured: pull the SD card and edit
`bloopbox-wifi.txt` on the boot partition (`docs/deployment.md`), which only works because that
file is read *and deleted* on every boot regardless of `system.configured`. There is no way to ask
the device to forget its Wi-Fi and raise the hotspot again while it is sitting in the room — useful
when a family moves, replaces their router, or the passphrase changes and the admin panel (which
needs the network to be reachable at all) is the wrong place to ask.

**Where it plausibly lives:**
- The admin panel already has the network in front of it — a "forget this network" action there is
  the reachable-device case, and cheap. **The mechanism now exists**: the factory-reset work below
  added `forget` as the fourth entry in `NET_ACTIONS` (`src/net/netState.ts`), which deletes the
  `bloopbox` NM profile and lets `NetworkSupervisor`'s existing `unconfiguredGraceMs` path do the
  rest. What is missing is a control that calls it *without* the rest of the factory reset — the
  whole point of keeping these two items separate is that a parent changing routers must not lose
  their contacts.
- The unreachable-device case is the one this is actually for, and it needs a **physical**
  trigger, since that is the only interface a screenless device has. `buttonInterpreter.ts`
  already has one precedent for a chord meaning something outside normal record/play — buttons 1
  and 3 held for `silentComboMs` toggles silent mode (`PRODUCT.md` §6, `button.test.ts`). A
  Wi-Fi-forget chord would need its own hold duration, long enough that a toddler's hands cannot
  produce it by accident, and a cue distinct enough from every existing pattern that a parent
  doesn't mistake it for silent mode.

Scope this one narrowly: it must forget Wi-Fi only. Anything that also touches contacts, the admin
password or WhatsApp pairing is the factory-reset item below, and conflating the two means a parent
who only wanted to change routers loses the whole device's setup.

### A factory reset does not change the ssh password

Added 2026-09-23 with the per-device ssh password (`docs/deployment.md` § The ssh password). The
password lives in `/data/ssh-password` and in `/etc/shadow`, and the factory reset touches neither,
so a box handed to a new family still accepts the old owner's ssh login, and the new owner's panel
shows them the same password the old owner saw.

The fix is a `rotate-ssh-password` action for the root agent — the daemon cannot run `chpasswd`,
and must not be able to — which re-runs `deploy/ssh-password.sh` with a fresh marker. The factory
reset would then ask for it alongside `forget`, and the panel could offer it on its own as
"generate a new password". Deliberately not done in the same change: the agent's request channel
has the open `ReadWritePaths` question in `docs/review-2026-09.md` (0.8), and a new root action
should not be added on top of a channel that may be replaying its requests.

### A factory-reset control that wipes all user configuration

Requested 2026-08-10, alongside the Wi-Fi-forget item above — related, but a different blast
radius and worth keeping separate rather than building one control that tries to be both.

**The admin-panel half is built** (2026-08-17): "Recover from factory settings", last in the
Advanced group, behind a two-step confirm. `POST /api/factory-reset` deletes `/data/config.json`,
clears the WhatsApp auth directory, and asks the net agent to `forget` the Wi-Fi profile, then
restarts — all three, because config.json is only one of the three places a device remembers who
it belongs to, and leaving either of the others hands over a box still logged into the previous
owner's account or still sitting on their network. Covered by `routes.test.ts`.

**Two things it does not do yet:**

- **The physical trigger is still missing**, and it is the case this was originally for: a device
  nobody can reach. The panel needs the network, so it cannot rescue a box whose router changed.
  `buttonInterpreter.ts` has the precedent (buttons 1 + 3 for `silentComboMs`), but the bar here is
  higher — consider a hold well past `maxRecordingSeconds` so an unusually long recording attempt
  cannot reach it, and a two-step confirmation the LED vocabulary can express (`PRODUCT.md` §6's
  patterns are all spoken for, so a new one needs a priority-ladder slot in `ledPriority.test.ts`,
  not just a cue).
- **An imager-seeded network survives the reset.** `forget` deletes only the profile bloopbox
  manages, deliberately — a network baked in with `--wifi-ssid` is not ours to delete. The
  consequence is that such a device rejoins after a reset rather than offering a hotspot, and is
  re-onboarded over the network it is already on. Fine for now; revisit if a real device makes it
  confusing.

**Not verified on hardware.** The `forget` action has only been exercised against a stubbed agent
and by watching the request file get written — no `nmcli` has ever run it. It belongs in the
bring-up gates in `docs/hardware-bringup.md`: reset a configured device and confirm the hotspot
actually comes back, rather than the device silently rejoining.

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

_When the AP comes up._ Unconfigured: 10 s of no association. Configured: 3 min — a flat 30 s
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

### Unread notes are recovered at boot — within 8 h, and now across a power cut too

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

1. ~~_A power cycle still wipes everything._~~ **Fixed 2026-09-06**, after it happened on the real
   device: a note arrived, the lamp blinked, the power went out, and it was gone. Inbound notes now
   live in `NOTES_DIR` (`/data/notes`) while outbound captures and derived WAVs stay in
   `RECORDING_DIR` (`/run/bloopbox`), so a power cut costs nothing the child recorded and nothing
   regenerable. The privacy cost was accepted deliberately — `/data` already holds the WhatsApp
   session, notes are deleted on play and swept at 48 h, and the child's own voice never reaches
   the card. `src/audio/directories.ts` has the reasoning.
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

### `RuntimeDirectorySize=` is not a systemd directive, so the tmpfs cap is silently absent

Found on the first real device, 2026-08-10. `bloopbox-hardware.service:48` and
`bloopbox-whatsapp.service:32` both set `RuntimeDirectorySize=64M`. systemd 257 rejects it:

```
$ sudo systemd-analyze verify /etc/systemd/system/bloopbox-hardware.service
/etc/systemd/system/bloopbox-hardware.service:48: Unknown key 'RuntimeDirectorySize' ...
/etc/systemd/system/bloopbox-whatsapp.service:32: Unknown key 'RuntimeDirectorySize' ...
```

The key is ignored, the units start fine, and nothing else complains — which is why it survived
review. The consequence: `/run/bloopbox` is **not a mount of its own**, just a directory inside the
`/run` tmpfs (`findmnt /run/bloopbox` returns nothing; `df` shows it sharing `/run`'s 182 MB on a
1 GB Pi). Recordings are therefore bounded by `/run`, not by 64 MB, and a purge failure would eat
the space `systemd`, `NetworkManager` and the net-agent's state file all need.

Not urgent — the 48 h purge and `maxRecordingSeconds` keep real usage far under 182 MB — but the
protection everyone believes is there is not there. `RuntimeDirectory=` has no size option; the fix
is a `TemporaryFileSystem=` entry or a real `run-bloopbox.mount` unit, which is what the note in
`box/software/CLAUDE.md` ("audio-in-RAM with no mount unit") was trying to avoid. Whichever way it
goes, that note and `docs/deployment.md` need updating with it.

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

**This applies to the box only.** The website (`website/`) ships Nunito, self-hosted by `next/font`,
because it is not served off a Pi. So the two surfaces are not typographically identical on a
non-Apple machine: the site shows the brand's letterform, the device's four UIs show the system
face. That is the accepted consequence of the constraint, not drift — but it is the strongest
argument yet for doing the subsetted WOFF2 work above, since the reference now exists.

### Coverage still fails its own thresholds

`npm run test:coverage` reports 87% statements / 79% branches against declared thresholds of 80,
and `npm run check` does not run it. What is left, in order of size:

- **`src/whatsapp/` at 86% / 77%** (from 58% / 49% on 2026-09-23). Baileys is injected into
  `WhatsAppClient` and `tests/support/fakeWASocket.ts` drives the reconnect ladder, QR
  exhaustion, the unlink race, the ephemeral unwrap and the download caps. What is left in
  `client.ts` is mostly pairing-code and group-listing glue and LID resolution. The call site that
  enforces *whitelist before download* is still in `src/processes/whatsapp-bridge.ts`, which is
  excluded from coverage — moving it into `createBridge()` is review Phase 2F.
- **`src/server/simulatorTransport.ts`** — no tests, and **deliberately not getting any**. It is
  the browser end of a debugging tool: it never runs on a device, and when it breaks the person
  looking at it is the one who broke it. `bridgeLink.test.ts` is the template if that ever stops
  being true. It stays in the coverage denominator, so the 80% thresholds cannot be reached
  without excluding it — worth doing at the same time as any other change to `vitest.config.ts`.
- **`src/audio/` at 75%** — the ffmpeg pipeline's error paths.
- Three timeout paths in `bridgeLink.ts` (send 60s, pairing 20s, groups 10s) are deliberately
  uncovered: they need fake timers, which do not mix with real sockets.

### The mark is drawn twice and copied twice more, and nothing enforces that the four agree

`box/software/public/shared/bloopbox-mark.svg` (the line-art pill, its three arcs and three ring
buttons, for 24px and up) and `bloopbox-favicon.svg` (the pill filled with three flat colour
fields, no buttons, for browser tabs) are separate drawings sharing no code. They have to agree on
five colours and on the left-to-right button order — **yellow, coral, teal** — and today the only
thing keeping them in step is the comment in each and `/brand/`, which renders both side by side.

Both are also **copied from `website/public/`**, along with the palette in
`website/app/tokens.css`. The duplication is deliberate — the site and the box share a brand, not a
build (`website/README.md`) — but it doubles the count: a colour or button-order change is now four
files, and only the two in `box/software/` are ever seen side by side.

As of 2026-09-05 the copy is mechanical, which makes a guard cheaper than it was. The box's two
files are `website/public/bloopbox-logo-light.svg` and `bloopbox-iso-light.svg` path for path, with
`fill="black"` replaced by `class="ink"` and a header comment and `<style>` block prepended. So the
drift check is: strip everything before the first `<path`, replace `class="ink"` with
`fill="black"`, and the remainder must be byte-identical to the site's file. That is a shell
one-liner, not a browser test — but it reads across packages from a box test, which the decoupling
rule argues against, so it wants to be a root-level script or a `.githooks/pre-commit` step.

The colour assertion is still worth having and is now **known to fail**: see the entry below.

### The refined artwork's hexes are not the brand palette, and the site's dark logo is a bad export

Found 2026-09-05 while syncing the box's logos to the site's refined ones.

Two things came out of the site's artwork that want fixing **in the site**, because the box copies
it path for path and a fix applied only in the box would break that:

1. **The artwork's three colours are not the tokens.** It draws `#F3B333`, `#F0776C` and `#0B97C4`
   where `tokens.css` says `--brand-yellow: #f7b733`, `--brand-coral: #ff6f61` and
   `--brand-teal: #00a7e1`. Yellow is imperceptible and coral is close; **teal is visibly duller and
   darker**. So `/brand/` §1 renders a mark whose teal does not match the teal swatch two sections
   below it, which is a real defect in a page whose whole premise is that it shows the real thing.
   Either retint the artwork to the palette or move the palette to the artwork — but decide it once,
   in `website/public/`, and re-copy.

2. **`website/public/bloopbox-logo-dark.svg` is wrong.** It is not the light file with a reversed
   outline: the pill's left arc is teal where it should be yellow, the pill outline is white while
   the three button outlines are still black (so they vanish on navy), and it carries an extra white
   backing path the light file does not have. `bloopbox-iso-dark.svg`, by contrast, is a clean
   `black` → `white` fill swap and is fine. Nothing in the product uses the broken file; the only
   place it appears is `/brand/` §1's dark hero tile, deliberately and captioned as a known-bad
   asset, because a kit that quietly substituted the good file would be the one page the defect
   could not be seen on. The **site still ships it for real**, and `website/components/Lockup.tsx`
   and `app/page.tsx` reference the dark and light variants directly.

Also worth a look while in there: `website/app/layout.tsx` still points `icons.icon` at
`website/public/bloopbox-favicon.svg`, which is the **old** speech-bubble drawing, not the refined
`bloopbox-iso-*.svg`. The site's `bloopbox-mark.svg` is the old drawing too and now has no
reference pointing at it.

### The three product pages pick the light-inked mark unconditionally

Found 2026-09-05 while wiring up `/brand/` §1's pinned specimen panels.

The mark is now two files that differ in one path — `bloopbox-iso-light.svg` inked black,
`bloopbox-iso-dark.svg` inked white — where it used to be one file switching its own ink from an
embedded `<style>` block. `/brand/` picks between them with `<picture>` and a
`prefers-color-scheme` `<source>`, which is the mechanism the swap wants everywhere. The setup
portal, the admin panel and the simulator did not get it: all three hard-code
`bloopbox-logo-light.svg` in their `.lockup`, so **in dark mode the outline is black on navy and
the mark loses its pill**. It is a degradation rather than a disappearance — the three coloured
arcs still draw — but it is on the first screen a parent sees.

The fix is the same four lines in each of the three pages, plus moving `/brand/`'s

```css
.lockup picture {
  display: flex;
  flex: none;
}
```

out of `brand.css` and into `base.css`, which is where it belongs the moment a product page needs
it. Left undone here because it is three pages outside the one this task was scoped to.

Two smaller things noticed alongside, neither urgent:

- `docs/BRAND.md` §"There is no reversed asset — but the mark's ink does switch, in-file" still
  describes the old single-file mechanism, which is now true only of `bloopbox-favicon.svg`.
  `/brand/` §1's prose has been rewritten; the doc that owns the decision has not.
- `.lockup-hero .lockup-mark` is a 5.5rem **square**, and `bloopbox-logo-*.svg` is 279 × 118. So
  the hero mark letterboxes to about 40% of its box and the tile reads as mostly empty. `height:
  5.5rem; width: auto` is probably the answer, but it is a base.css change for a variant only the
  brand kit uses, so it wants deciding rather than patching.

### The brand kit ships to the device and is not behind the admin gate

`/brand/` is a Vite entry, so it lands in `dist/public/` and is served by the hardware server like
any other page — about 7 KB gzipped of static HTML, no JS. It contains no secrets, so being
ungated is not a leak, but it is a page a parent could stumble into. Options if that ever matters:
drop the entry from `vite.config.ts` for release builds, or move it behind `requireAdmin`. Left
shipping on purpose: a style guide that is not built alongside what it documents rots.

### Re-running `install.sh` without `--audio-hat wm8960` silently un-configures the codec

Found 2026-09-08 on the live device, which had been completely silent since the 2026-09-07
upgrade. `aplay -l` listed only `bcm2835 Headphones` and `vc4hdmi`; `arecord -l` listed nothing at
all. The cause was one flag: the upgrade was installed as `install.sh` with no `--audio-hat`, so it
defaulted to `usb`.

The two halves of the audio configuration have **different write policies**, and that asymmetry is
the whole bug:

- `/etc/bloopbox/environment` is written **once** and never overwritten (`install.sh:260`), so it
  kept its 2026-08-17 WM8960 content — `plughw:CARD=wm8960soundcard,DEV=0` both directions.
- The `# >>> bloopbox >>>` block in `config.txt` is **deleted and regenerated on every install**
  (`install.sh:393-395`), so the `dtparam=i2c_arm=on` / `dtoverlay=wm8960-soundcard` /
  `dtparam=audio=off` lines vanished, and `dtparam=audio=on` from the stock file won again.

After the reboot the daemon was pointed at a card that no longer existed. Nothing else looked
wrong: the box booted, joined Wi-Fi, connected to WhatsApp, the buttons worked, the API reported
`{"state":"READY","silentMode":false}`. The only signal was `bloopbox-audio-init.service` sitting
in `failed` with `no mixer on card 'wm8960soundcard' — is the overlay loaded?`, and that unit is
deliberately not a `Requires=` of the hardware service, so nothing propagated it.

Fixed on the device by restoring the three lines by hand and rebooting; `bloopbox-doctor` is green
again apart from the known `Name=Value` false failures below. **The repository fix is still open.**

#### What is actually detectable — measured on the device, 2026-09-08

| Question | Answer | How |
| -------- | ------ | --- |
| Does the HAT have an ID EEPROM, so the firmware self-configures? | **No** | `/proc/device-tree/hat/` does not exist |
| Can the codec be probed without the overlay? | **Yes** | SMBus quick-write at `0x1a` on `/dev/i2c-1` ACKs; `0x1b`, `0x50`, `0x60` all give `Remote I/O error` |
| Is the probe available in every profile? | **Yes** | `dtparam=i2c_arm=on` uses GPIO 2/3; buttons are 17/27/22 and lamps 23/24/25, so it can be unconditional — no chicken-and-egg |
| Can the overlay load at runtime, without a reboot? | **Yes** | `dtoverlay wm8960-soundcard` on a box booted without it: card enumerates with playback **and** capture, `wm8960 1-001a` binds, `bloopbox-audio-init` passes, `aplay` plays |

The runtime-loaded card lands as **card 1**, because onboard audio is still present. That costs
nothing here — the environment addresses it as `plughw:CARD=wm8960soundcard`, which is exactly the
reason that decision was made.

The WM8960's control interface is write-only, so the probe must be a quick-write; a read-byte probe
would miss a codec that is present. `I2C_SLAVE_FORCE` is needed once the driver has claimed `0x1a`.

#### What shipped, 2026-09-08

Autodetection is the **fallback, not the fix**. An install that ran while the HAT was unseated
would still wipe `config.txt`, and `--no-leds` has the identical shape with nothing to detect at
all. So `install.sh` now resolves the profile by precedence instead:

    explicit flag  >  /etc/bloopbox/profile  >  inferred from an existing environment  >  usb

1. **The profile is persisted.** `/etc/bloopbox/profile` records `AUDIO_HAT` and `NO_LEDS`,
   machine-written and separate from the hand-edited `environment`, and is rewritten only when a
   flag is explicit. The third step of the chain is the migration for every box already in the
   field: an environment naming `wm8960soundcard` means a wm8960 board, an empty `LED_PINS=` means
   no lamps. Verified against the live device — an upgrade with no flags now resolves
   `AUDIO_HAT=wm8960` out of its environment, where before it resolved `usb`.
2. **The installer refuses to downgrade.** Resolving to `usb` while the profile or the environment
   says `wm8960` is an error, not a rewrite. `--force` overrides, for a HAT that really is gone.
3. **`bloopbox-doctor` checks the two still agree.** A profile saying `wm8960` while `config.txt`
   carries no `dtoverlay=wm8960-soundcard` fails *before* the reboot that would make it audible.
4. **The health card says it in words.** `readAudioInfo()` in `src/system/systemInfo.ts` compares
   the configured card against `/proc/asound/cards`; the admin panel names the missing card and
   says plainly that nothing can be heard. Nullable like every other reading — a dev machine with
   no `/proc/asound` reads as "cannot tell", never as broken.

The resolution logic and the doctor check were each exercised against fixtures covering both
branches, including the exact 2026-09-07 state.

#### Still open

- **Autodetect the codec.** Quick-write `0x1a` to pick the default on a *first* install, where
  there is no record to read. Measured to work (table above); not wired up, because the precedence
  chain already covers every box that exists today.
- **Self-heal at boot.** `bloopbox-audio-init.service` already runs at the right moment and already
  detects exactly this. When the configured card is missing *and* `0x1a` ACKs, it could
  `dtoverlay wm8960-soundcard`, wait for the card, and carry on — measured above to work and to
  produce real audio — then repair `config.txt` for next boot. No reboot means no reboot loop,
  which is the thing that usually makes auto-repair a bad trade. The rule would have to be **heal,
  repair, and still report**: self-healing that hides a misconfiguration only moves the silence
  somewhere harder to find.
- **The LED language says nothing about this.** The health card is the parent-facing surface and
  now covers it, but a box in a child's room is not being looked at through a browser. Adding an
  LED pattern is a product decision — a new `docs/PRODUCT.md` section, and that file's sections are
  cited by 39 source files — so it was deliberately not taken unilaterally.

#### Unverified, found while measuring the above

`dtparam=audio=off` is written **after** `dtoverlay=wm8960-soundcard`, and in `config.txt` a
`dtparam` following a `dtoverlay` is a parameter *of that overlay*, not of the base DTB. With the
overlay commented out, that line did not disable onboard audio — the Headphones card came back. So
the single-card outcome on a normal boot probably comes from the overlay itself and the comment
above the line ("One card, so ALSA `default` cannot land on the wrong one") may be claiming
something that line does not do. Harmless while everything is addressed by name. Not chased down.


### `bloopbox-doctor` fails two checks that are actually fine — it cannot read a `Name=Value` switch

Found 2026-09-06 on the live device, running doctor straight after an upgrade. It reports:

```
✗ routing: Left Input Boost Mixer LINPUT1=3 not a switch on this card
✗ routing: Right Input Boost Mixer RINPUT1=3 not a switch on this card
```

Both are false. Measured on the box at the same moment: `Left Input Boost Mixer LINPUT1` reads
`3 [100%] [29.00dB]` and `Capture` reads `63 [100%] [30.00dB] [on]` — exactly the values
`docs/hardware.md` specifies. The microphone chain is set up correctly.

The check at `deploy/doctor.sh:163-172` walks `ALSA_ENABLE_SWITCHES` and passes each entry
straight to `amixer sget`. Since entries became `Name` **or** `Name=Value`, the two boost entries
arrive as `Left Input Boost Mixer LINPUT1=3`, which resolves to no control at all — so
`switch_state` is empty and the `*)` branch calls it "not a switch on this card".

Two defects, and fixing only the first still leaves it failing:

1. The `=Value` suffix is never split off before the `amixer sget`.
2. A `Name=Value` entry is a **level, not a switch**. Even queried by its bare name it prints
   `[29.00dB]` and no `[on]`/`[off]` token, so the `case` can never match. It needs to assert the
   *value* for these, and on/off only for the bare-name entries.

Worth fixing rather than living with: doctor is the only health signal a screenless box has, and
two permanent false failures are how you learn to skim past a real one. The same reasoning retired
the `pedantic` lint category.

### The `cmd | grep -q` tripwire was live in the release smoke test

Found 2026-09-06 while adding a `GET /` check beside the existing `GET /admin/` one, by copying
the line above it. `scripts/smoke-test-release.sh` runs under `set -euo pipefail`, and both
checks were `curl … | grep -qi "<html"` — the exact pattern the tier-1 and tier-2 tripwires warn
against, and the one the doctor check twenty lines earlier has a comment explaining it avoided.

It never failed, and that is the interesting part: `grep -q` exits at its first match, but the
admin page is a few KB and fits the 64 KB pipe buffer, so `curl` finishes writing and exits
before the read end closes. There is no SIGPIPE, so `pipefail` has nothing to report. The check
passes because of a size relationship between the page and a kernel buffer — not because it is
correct. Grow the page past the buffer and it becomes an intermittent false failure in CI, of the
kind that takes a day to attribute.

Both are now captured into a variable and matched with `case`, like the doctor check. Worth
knowing more generally: the tripwire's "this bit three separate checks during bring-up" wording
suggests a loud failure, but the dangerous version is this one — silent, passing, and waiting on
a payload size.

### A raw 64-hex Wi-Fi key gets through the agent, and nothing else lets it through yet

Found 2026-09-24 (review Phase 1, Deploy). WPA2 takes either an 8-63 character passphrase or the
64-hex-character key itself. `deploy/net-agent.sh` used to cut every `psk` at 63, turning a correct
raw key into a wrong passphrase; it now passes exactly 64 hex characters through whole, and
`scripts/test-onboarding.sh` step 9 proves it. But everything upstream still caps at 63 —
`POST /api/wifi/join` in `src/server/routes.ts`, `wifiSchema.password` in `src/config/schema.ts`
(so `wifi-apply.sh` never sees one either) and both `maxlength="63"` inputs in the portal and the
admin panel — so today a raw key reaches the agent only in a hand-written request. Allowing it end to
end is four small edits (accept `^[0-9A-Fa-f]{64}$` beside `.max(63)`), left for whoever next
touches the join route rather than done blind across files another change is editing.

### The units' `MemoryMax` values add up to more than the board has

`MemoryMax` is 192M (hardware) + 288M (bridge) + 48M (net agent) + 48M (debug sampler) = 576M, on a
Pi Zero 2 W with 512 MB — before the kernel, NetworkManager, journald and the page cache take theirs.
So the caps cannot all be reached at once, and a real system-wide out-of-memory is possible below
every one of them. Since 2026-09-24 the units say who dies first when that happens
(`OOMScoreAdjust=-500` on the hardware unit, `+300` on the bridge — `docs/deployment.md` § The
systemd units), but the values themselves are **unchanged on purpose**: they are guesses
(`hardware-bringup.md` says so), and lowering them without a measurement would trade an unlikely
OOM for a likely one. Measure first — debug mode's sampler records `memHardware` and `memWhatsapp`
every 10 s, and the peak across a WhatsApp pairing plus a few inbound notes is the number to size
from. Needs the memory cgroup controller actually on (`grep -o cgroup_enable=memory /proc/cmdline`),
or none of this is enforced at all.

### No liveness: a wedged daemon stays "active" forever

Deliberately **not** done blind (review 2026-09, Phase 1, Deploy): switching a unit to
`Type=notify` on a device that has never booted it risks a unit that never becomes active at all —
if `READY=1` never arrives, systemd kills it at `TimeoutStartSec` and restarts it, forever. Today a
daemon whose event loop is stuck (a sync loop, a wedged native call) keeps its unit `active`, the
buttons dark, and nothing notices. `RuntimeWatchdogSec=15s` in `system.conf.d` covers a wedged
kernel, not a wedged process.

The design, for hardware bring-up (gate 1, once the plain units are proven):

- **`Type=notify`, `NotifyAccess=all`, `WatchdogSec=30`** on `bloopbox-hardware` (and later the
  bridge). `all` rather than `main` because of how the message is sent — next point.
- **Sending it from Node with no native addon.** Node's `dgram` has no `AF_UNIX` datagram socket,
  and every npm `sd-notify` is a native module, which this project avoids for anything that is not
  opengpio. So spawn systemd's own `systemd-notify` (present on Trixie, 257):
  `execFile('systemd-notify', ['--ready'])` and `execFile('systemd-notify', ['WATCHDOG=1'])`. The
  child is not the main PID, hence `NotifyAccess=all`. 257's `systemd-notify` waits for the manager
  to process the message by default (its `--help` offers `--no-block` to opt out), which is what
  closes the old race where a short-lived sender exited before systemd could attribute it to the
  unit — confirm that on the device, it is the assumption the whole design rests on. Guard every call on
  `process.env.NOTIFY_SOCKET` so a dev machine and `npm run dev:hw` never spawn anything.
- **`READY=1` after the HAL is initialised** and the HTTP server is listening — not at process
  start — so "active" finally means "buttons answer".
- **`WATCHDOG=1` from the event loop** on a `setInterval` of `WatchdogSec / 2` (read
  `WATCHDOG_USEC` rather than hard-coding it), `unref()`'d. A timer is exactly the right probe: if it
  cannot fire, the loop that times button presses cannot either. One spawn per 15 s is noise on this
  board.
- **Also wanted from it, not available on this OS:** `RESTART_RESET=1`, which would let a daemon that
  has been healthy a while reset the `RestartSteps` ladder, so that settings saves late in a boot stop
  paying the 5 s cap. It is newer than Trixie's systemd 257 — checked 2026-09-24: no
  `RESTART_RESET` anywhere in 257.13's binaries.
- **Verify on the device before trusting it:** `systemctl show bloopbox-hardware -p WatchdogUSec
  -p NotifyAccess`, then `kill -STOP` the node process and watch systemd kill and restart it within
  ~30 s (`journalctl -u bloopbox-hardware` shows `Watchdog timeout`).

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

### The site's entrance animations are engine-gated: Firefox gets none, by design

Added 2026-09-08. Both pages fade-and-rise their blocks on scroll, and the three cards in the home
page's dark band blink the unread-message pattern. All of it is CSS: the entrances use
`animation-timeline: view()`, wrapped in `@supports`, so **Firefox gets no entrance at all today** —
deliberately, since the `from` state is what hides an element and an unsupporting browser never
applies it. That is the fallback most likely to be seen and the least likely to be noticed as
missing. It needs no work; it needs to be remembered when someone screenshots the site in Firefox
and reports the animation as broken.

Verified in Chrome 152 on macOS at 1280×987: both pages scrolled top to bottom with every `.rise`
block's computed opacity asserted back at 1 — the failure that matters is a block stuck
half-transparent at the foot of a page, where there is no scroll left to finish it. The two
overrides were then rendered rather than reasoned about, by driving Chrome over CDP with
`Emulation.setEmulatedMedia`: with `prefers-reduced-motion: reduce`, and again under `print`, 0 of
20 blocks on `/` and 0 of 45 on `/manual/` stay hidden at the top of the page, against 20 and 44
hidden in the same position as delivered. The manual also prints: 21 pages, complete, LED ladder
included.

**The first tuning shipped invisible**, which is worth remembering because the mistake is not
obvious from the code. Ranges ended at `cover 20%`, so a block finished arriving while it was still
in the bottom quarter of the screen — measurable, and never seen. The cause was one block setting
the tempo for all of them: the sign-off at the page bottom cannot complete a late range, so every
range was capped to suit it. Exempting the closing section from the entrance moved the tightest
reachable progress from `cover 39%` to `cover 96%` and the ranges could then be tuned for the
blocks that can actually use them (`cover 15%`–`cover 45%`, finishing around mid-screen).

Still one engine on one platform, and no real printer.

### The manual prints, but it prints badly

Found 2026-09-08 while checking the above, and **not caused by it** — this is how the page has
always printed. `chrome --headless --print-to-pdf` on `/manual/` gives 21 correct pages with two
problems a reader would notice: sections break wherever they land, leaving half-empty pages (page 1
ends after the facts list, page 3 after three short paragraphs), and the dark band plus the footer
print as full-bleed navy across most of three pages, which is a lot of ink for a document whose
whole purpose is to be next to someone holding a screwdriver. Neither is hard to fix —
`break-inside: avoid` on the step blocks and a print rule that drops the night band to paper —
but it is a deliberate piece of work on a page nobody has asked to print yet.

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

Still not run: a note from a number nobody assigned being dropped — the negative case, which is
the one the safety boundary exists for. Group membership as permission is also only
half-checked: the group note came from the account that owns the device, not from a third party
in that group.

`requestPairingCode` was finally exercised against a real device on 2026-08-10 and did not work —
see the pairing-race entry below. Fixed there, but not yet reverified end-to-end on hardware.

### Real-hardware pairing raced QR against phone-number linking — fixed, not yet reverified

Reported 2026-08-10: on a real device neither QR scanning nor phone-number pairing would
complete. The admin panel rendered "scan this QR" and "get a pairing code" side by side with no
mutual exclusion, so a parent could request a pairing code while Baileys was still mid-QR-scan on
the same socket. `WhatsAppClient#requestPairingCode` mutates `authState.creds.pairingCode`/
`creds.me` directly (Baileys' own `socket.js`) and had no guard against a second call landing
before the first was answered — two in flight together can corrupt both, and the resulting close
cascades through `#handleConnectionUpdate` into `#scheduleReconnect`, which opens a fresh socket
and restarts QR rotation from zero. That matches "everything keeps regenerating and nothing
finishes."

Fixed by making the two methods mutually exclusive in the UI (`public/admin/main.ts` now asks
which method to use before rendering either) and by rejecting a second `requestPairingCode` call
while one is already in flight (`src/whatsapp/client.ts`); the lock clears on every reconnect so
a hung request cannot block the method permanently. Covered by
`src/tests/whatsappClient.test.ts` against a mocked socket.

**Follow-on, same day:** mutual exclusion in the UI did not stop Baileys itself from generating a
QR the moment the socket opened — which was unconditionally, at daemon boot, for any unpaired
device, regardless of which method (or neither) a parent had chosen. That is a second source of
"it keeps regenerating": the bridge was asking WhatsApp for a QR before anyone had asked for
anything. `WhatsAppClient#start()` now checks `creds.registered` and, if the device has never
been paired, settles into a new `notLinked` state **without opening a socket at all** — no
socket, no QR, no traffic to WhatsApp. Opening one is deferred to a new `beginLinking()`, wired
through a new `wa:beginLinking` bridge event and `POST /api/whatsapp/link`, which the admin panel
calls only when a parent clicks "Scan a QR code" or "Link with my phone number." `unlink()` and
the logout branch in `#handleConnectionUpdate` settle into `notLinked` the same way instead of
auto-reconnecting — so a device that loses its link (remote logout, or an admin unlinking it) no
longer produces a fresh QR on its own; it waits at the chooser until someone opens the admin
panel and picks a method again. That is a deliberate trade: a plugged-in-and-forgotten device
that gets logged out remotely will now sit idle rather than silently regenerating QR codes into
the void, but it does mean linking is never fully hands-off after the first time. Covered by
four new cases in `src/tests/whatsappClient.test.ts` (no socket without registration or
`beginLinking`, `beginLinking` opens one, immediate connect when already registered,
`beginLinking` is idempotent) plus one each in `bridgeLink.test.ts` and `routes.test.ts`.

**Not yet reverified against the device that reported this** — only the simulator, a live local
run against real WhatsApp servers (phone-number path included), and the mocked unit tests have
exercised these fixes. Re-run Gate 6 in `docs/hardware-bringup.md` on real hardware, including the
phone-number path and an unlink-then-relink, before treating this as closed. If you're chasing a
similar report, `journalctl -u bloopbox-whatsapp -f` carries Baileys' own log lines
(`"lib":"baileys"`) alongside the bridge's, and `sudo bloopbox-diagnostics` bundles that journal.

### `requestPairingCode` sent WhatsApp a bogus number for `0049…`-style input — fixed

Found live-testing the fix above, same day: after the race was gone, a real attempt against a
real WhatsApp account still failed with WhatsApp's generic "couldn't link device" on the phone —
first suspected to be an upstream Baileys/WA-protocol version mismatch (there are several open
Baileys issues matching that exact generic error, e.g. WhiskeySockets/Baileys#2679 and #2488),
but that theory did not survive checking: `fetchLatestBaileysVersion()` was called directly and
returns exactly the version already in use. The actual cause was mundane — the number was typed
as `0049…` (the international-dialling spelling) rather than `49…`, and
`WhatsAppClient#requestPairingCode` only stripped non-digit characters, not a leading `00`. The
result was a valid-looking, wrong string handed straight to WhatsApp, which duly generated a real
code for an account that doesn't exist and rejected it on entry with no error specific enough to
point back at the number.

The contact-target parser (`normalisePhone` in `src/config/schema.ts`) already solves exactly
this — strips a leading `+` or `00`, and *rejects* a leading `0` that survives that rather than
guessing a country code, since inventing one would produce a real, wrong recipient. It just was
never reused for pairing. It now is: `requestPairingCode` calls the same (now-exported)
function, so `0049…` and `+49…` both reduce to `49…`, and a genuinely malformed number (a
surviving leading 0) is rejected before it ever reaches Baileys, with a message that says why.
The admin panel's phone-number hint and placeholder were also reworded to show a `0049` vs. `49`
example, so the mistake is less likely in the first place. Covered by two new cases in
`src/tests/whatsappClient.test.ts`.

Left open: the upstream Baileys issues linked above are real and worth knowing about if a future
pairing failure looks like this again with a correctly-formatted number — they just were not the
cause this time.

### Sending a voice note killed the bridge, and the restart reported the device as never linked — both fixed

Reported 2026-08-10, the first real send attempt on hardware: button 1 recorded (the whoosh
played), then the "oops" cue, no message delivered, and the admin panel afterwards claiming the
device was not linked. Two independent bugs, which only together produce that story — and the
second is the dangerous one, because it invites a parent to fix it by re-pairing.

**1. `/tmp` is read-only, and Baileys writes there on every send.** `encryptedStream`
(`Utils/messages-media.js`) stages outbound media at `join(os.tmpdir(), type + id + '-enc')`
before uploading. The unit runs `ProtectSystem=strict` with `ReadWritePaths=/data`, so `/tmp` is
read-only and the write failed `EROFS` — as an unhandled `'error'` event on a `WriteStream`, not
a rejected promise, so nothing in `handleSend`'s `try`/`catch` could see it and the process
exited 1. `Restart=always` brought it back five seconds later, which is why the only visible
trace was a failed send. Fixed by giving the unit a second runtime directory and pointing
`os.tmpdir()` at it: `RuntimeDirectory=bloopbox bloopbox-tmp` plus
`Environment=TMPDIR=/run/bloopbox-tmp`. Deliberately **not** `/run/bloopbox` — `audio/recovery.ts`
treats every file in the recordings directory as an unread note, so scratch there would be
recovered and played at a child. Verified on the device by replicating the unit's sandbox with
`systemd-run`: the exact `-enc` write now succeeds while bare `/tmp` is still read-only, so the
sandbox was not loosened to get there.

**2. `creds.registered` is false after a QR scan, and `start()` believed it.** The flag is
assigned in exactly one place in Baileys — `Socket/messages-recv.js`, handling
`link_code_companion_reg`, which is the **phone-number** path. A QR scan finishes through
`configureSuccessfulPairing`, which writes `me`, `account`, `platform` and the signal identities
and never touches `registered`. Nothing notices while the process stays up, because the live
socket is authenticated either way and the flag is only read at boot. The crash above forced that
boot, and `start()` — gating solely on `state.creds.registered` — reported `notLinked` over a
session that was completely intact: 1544 files, valid `me`, `account` present, `pairingCode:
null` confirming the scan. The device on the bench was recovered by flipping that one boolean and
restarting the bridge; it went straight to `connected` with no re-pairing.

The trap: the offered remedy is to scan a QR, and `beginLinking()` opens a *fresh* socket — so
following the panel's own advice is what would finally destroy the working session. Fixed with
`isPaired()` in `src/whatsapp/client.ts`, which honours `registered` when set and otherwise asks
whether `me.id` and `account` are both present (a half-written `requestPairingCode` state, which
sets `me` but no `account`, is correctly rejected). The flag is also normalised to `true` when a
connection reaches `open`, so credentials on disk agree with what WhatsApp just accepted and the
fallback stays a safety net rather than the thing every boot rests on. Four `isPaired` cases and
two behavioural tests in `src/tests/whatsappClient.test.ts`.

**Still open — the device is running a drop-in, not the fix.** The `/tmp` repair was applied live
as `/etc/systemd/system/bloopbox-whatsapp.service.d/tmpdir.conf` so sending could be tested the
same evening. The unit file in `deploy/systemd/` now carries the same settings, so a reinstall
supersedes it, but **the drop-in must be deleted when that happens** or it will keep shadowing the
packaged unit. A pre-fix backup of the credentials is on the device at
`/data/auth_info.backup-1786383903.tar.gz`.

### Baileys writes its credentials non-atomically

Noticed while testing the fix above, and reproduced accidentally: `useMultiFileAuthState`'s
`writeData` is a plain `writeFile`, which truncates before it writes. Polling `creds.json` in a
loop hits the empty window often enough to fail a test on a fast machine — which means a crash or
a power cut in that window leaves a truncated file. `readData` then swallows the `JSON.parse`
failure and returns `null`, and `useMultiFileAuthState` falls back to `initAuthCreds()`, so a
destroyed pairing presents as a device that was never linked — silently, with nothing in the log.

This is the same hazard `/data/config.json` is already protected against (tmp file → `fsync` →
`rename`, because a half-written config would brick the device), except the credentials are
written by the library rather than by us and are equally unrecoverable. Not the cause of the
2026-08-10 failure — the file on that device was a healthy 2546 bytes — but the same symptom, so
worth ruling in or out first if this recurs. Worth wrapping `saveCreds` with an atomic write and
keeping one last-good copy to fall back on; `WhatsAppClient` already owns the auth directory, so
it is the natural place.

### The connection lifecycle fixes of 2026-09-24 are verified against a fake socket only

From `docs/review-2026-09.md` Phase 1: an unscanned QR now settles in `notLinked` instead of
looping, `#connect` is generation-guarded, and 440 / 403 are terminal. All of it is locked by
`whatsappLifecycle.test.ts` against `FakeWASocket`, and none of it has met a real account. Worth
checking on hardware, cheapest first:

- Leave a QR unscanned for the ~3 minutes Baileys' refs last and confirm the panel lands back on
  the method picker, with one `whatsapp connection closed` at 408 and no `reconnecting` after it.
- Scan a QR and confirm the 515 that follows reconnects at once (`delayMs: 0`) and ends
  `connected`. That the in-memory `creds` are already paired at that 515 is not relied on — 515 is
  checked first — but it is the assumption to question if a scan ever lands in `notLinked`.
- Boot a copy of a linked card in a second box and confirm one side stops at 440 with the detail
  string instead of both flapping.

**The detail string does not reach the panel yet.** The bridge sends it on `wa:status`, and the
hardware server logs it, but `onStatus` keeps only `state` and `qr`, and `GET /api/whatsapp` has no
field for it. A parent sees `disconnected` with nothing saying that retrying will not help.
Surfacing it is a hardware-server + routes + admin change, left out of this one.

### "Delete for everyone" has only met a fake socket

Built 2026-09-24 from the REVOKE shape in Baileys' source, and locked by unit tests on each hop.
Not yet seen with a real account: that a revoke arrives on `messages.update` at all when the box
is online, and — the more interesting one — when it was sent **while the box was off**, since the
offline queue arrives as `append` and nobody has checked that `processMessage` runs the protocol
message for it. Also unchecked: a group admin deleting someone else's note (it should work — the
chat is what is whitelisted, not the revoker), and a revoke for a note older than the bridge's
memory of revoked ids (200) while its download is still in flight, which cannot really happen.

Not handled: the activity card's *received* total still counts a revoked note, and a revoke for a
note that is mid-playback is dropped rather than applied once the note ends — it is deleted as
heard at that point anyway.

### The upload bound assumes at most two media hosts

`MEDIA_UPLOAD_TIMEOUT_MS` (20 s) is applied by Baileys per host, in turn (`getWAUploadToServer`
in `Utils/messages-media.js`), and as an idle timeout. With two hosts both stalling, a send fails in
about 40 s, inside the hardware side's 60 s. How many hosts `media_conn` actually returns has not
been looked at on a real account; with three or more, a send can still outlive the "oops". A
`sendResult` that arrives after the hardware side gave up is dropped there silently, so the
symptom would be a note the recipient got and the box said had failed. Log `hosts.length` once
from a real send to settle it.

### View-once voice notes are ignored — a product decision nobody has made

`voiceNoteContent` in `whatsapp/client.ts` unwraps `ephemeralMessage` (disappearing chats) and
nothing else, so a note a grandparent sends as **view once** never reaches the box, and the sender
is told nothing. Options: keep ignoring it (today, and the safe default); accept it and play it
once, deleting it even if the child stops half-way, which breaks the "interrupted goes back to the
front" rule; or accept it as an ordinary note, which quietly ignores what the sender asked for.
Not `normalizeMessageContent` either way — it unwraps edits and more besides, each a new shape a
group member could put on a child's button.

Also unverified with a real account: that a note from a disappearing chat arrives as
`ephemeralMessage` at this layer at all, rather than already unwrapped by Baileys. The unwrap is
harmless if it is — a plain `audioMessage` still matches.

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

### ~~The setup hotspot and its portal have never touched a radio or a phone~~ — now closed, 2026-08-10

**Closed end to end, 2026-08-10.** A genuinely blank SD image (no Wi-Fi anywhere in it) booted, the
radio came up, the hotspot raised itself with no manual trigger, `bloopbox-7971` appeared on a
phone, the captive portal popped by itself, the nearby-network list rendered, and joining a network
through the UI landed the device back online with `system.configured: true` — all without a single
step performed from a shell. Three bugs were found and fixed along the way (below), and the full
history is kept here rather than deleted, since it is the record of what "never touched a radio or
a phone" actually cost to close.

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

~~Also unseen: the portal rendered in a browser.~~ **Seen and working, 2026-08-10.** On a phone:
the captive portal popped up by itself, the nearby-network list rendered — which also proves the
"scan captured just before the radio becomes an AP" design does its job — and joining a network
from the UI completed. `system.configured` flipped to `true` and the device came back on the home
network. The whole first-boot path now works end to end on real hardware.

#### But the join reports failure to the parent, and blames the passphrase

Caught in the same run. Two things activate the **same** `bloopbox` profile, both set off by the
one portal save, and they race:

```
01:24:04  bloopbox-hardware.service: Deactivated successfully   <- the config save exits the daemon
01:24:05  Scheduled restart job, restart counter is at 1
01:24:08  net-agent: ap_down, then `nmcli con up bloopbox`      <- writer #1, join_network
01:24:09  NM: Activation: starting connection 'bloopbox'
01:24:10  NM: state change: config -> deactivating (reason 'new-activation')
01:24:10  NM: disconnecting for new activation request          <- writer #1 is preempted
01:24:20  wifi-apply.sh: joined Behrends-P (from /data/config.json)   <- writer #2, ExecStartPre
01:24:20  Started bloopbox-hardware.service
```

`join_network`'s `nmcli con up` is cancelled by the second activation, returns non-zero, and the
agent sets `LAST_ERROR="could not join Behrends-P — wrong passphrase, or out of range"`. The
passphrase was correct. The device joined. **The portal still shows the parent a wrong-password
error** — the single most discouraging thing it could say, on the one screen the product has, at
the one moment a parent is most likely to give up and retype a password that was right.

The two writers are both deliberate and documented (`deployment.md` explains why `wifi-apply.sh`
runs from `ExecStartPre` — so a Wi-Fi save takes effect on the restart the save already triggers).
Nothing anticipated them overlapping, because until the portal existed only one of them ever ran.

**Fixed and verified on hardware, 2026-08-10**, on a genuinely blank SD image (no Wi-Fi baked in
at all): `join_network` now starts the activation with `nmcli --wait 5`, then polls a new
`joined_ssid()` helper against `nmcli dev status` / `dev wifi` for up to `JOIN_CONFIRM_SECONDS`
(25s) before deciding, rather than trusting `nmcli con up`'s exit code. The device joined
`Behrends-P` through the portal on the very first real end-to-end run this project has done —
```
net-agent: hotspot up: bloopbox-7971
net-agent: joined Behrends-P
```
— with no false "wrong passphrase" report and `system.configured` correctly `true` afterward.

Related and worth doing at the same time: PENDING already predicted "the radio may need a settling
delay between `ap_down` and `nmcli con up`". That is **not** what happened here — the failure was a
race, not a settle — so the settling-delay idea can be dropped unless it shows up on its own.

#### A device with genuinely no Wi-Fi configured could not raise the hotspot at all

Found 2026-08-10, on an SD image deliberately built with **no `--wifi-ssid`** — the exact shape of
a real unboxing, and the first time this project built one. `wlan0` came up as `unavailable`, not
`disconnected`: `rfkill list` showed the wifi radio soft-blocked, `iw reg get` read
`country 00: DFS-UNSET`, and NetworkManager's own `WirelessEnabled` toggle was independently
`false` on top of that. All three block *scanning*, not only `ap_up` — so the hotspot's own network
picker would have shown nothing even if activation had somehow succeeded.

Root cause: `scripts/build-sd-image.sh` only calls `raspi-config nonint do_wifi_country` inside the
`if [[ -n "${WIFI_SSID}" ]]` branch. An image built with no Wi-Fi at all — the case the setup
hotspot exists to handle — never sets a country, and Raspberry Pi OS refuses to let the radio
transmit until something does. The mechanism meant to route around "no Wi-Fi known yet" turned out
to depend on Wi-Fi having been known at build time. Confirmed live: `sudo rfkill unblock wifi` and
`sudo nmcli radio wifi on` were both independently required before `wlan0` went from `unavailable`
to `disconnected`.

**Fixed and verified on hardware, 2026-08-10.** `ensure_radio_unblocked`, called once at startup
before the first scan or publish, unblocks rfkill, turns NetworkManager's radio on, and — only when
the regulatory domain reads as `00` (cfg80211's own "nobody has said yet" placeholder) — sets a
fallback via `iw reg set "${AP_COUNTRY:-DE}"`. A domain that is already set, right or wrong, is
never touched; this only fills a genuine gap. On a fresh flash with no Wi-Fi anywhere in the image,
the log read exactly as designed:
```
net-agent: no regulatory domain was set — defaulted to DE
net-agent: publishing to /run/bloopbox-net/net-state.json every 5s; hotspot would be bloopbox-7971
net-agent: hotspot up: bloopbox-7971
```
`rfkill list` showed the radio unblocked, `iw reg get` read `country DE: DFS-ETSI`, and — unlike
every earlier attempt tonight — `eth0` stayed `connected` throughout the AP transition instead of
going dark with `wlan0`. Still worth deciding deliberately: `DE` is this project's bring-up
location, not a claim about where any given device ships; the better long-term answer may be
asking during onboarding rather than defaulting silently, but *something* has to unblock the radio
before onboarding can ask anything at all.

#### The device went dark on every interface four times before the fixes above — none of it recurred after

Every occurrence happened while the agent was still running old, buggy code: the `no-secrets` WEP
trap (which left a real `nmcli` call hung on a secrets prompt), or a build with no country at all
(which left `wlan0` `unavailable` and every AP attempt failing in a loop). Once all four fixes were
in — no-secrets, the join race, and the radio unblock — a full flash-to-configured run went start to
finish with `eth0` staying `connected` the entire time and no lost session. Recorded as **probably
explained by the bugs above, not a separate hardware fault** — but "probably" is doing real work in
that sentence: nothing was captured that pins the mechanism, and `bloopbox-debug on`'s persistent
journal was only running for the later occurrences. If a device goes dark on both interfaces again
with none of tonight's bugs in play, treat it as a new, unexplained finding rather than folding it
into this one.

**`hotspot-test.sh` cannot test the portal without `--keep-daemon`, and its output does not make
that clear enough.** The script stops `bloopbox-hardware` for the duration, so `10.42.0.1` answers
nothing — which looks exactly like a broken portal to whoever is holding the phone. It cost one
round of "the captive portal is dead" on 2026-08-10 before the listeners were checked and found
healthy (`*:80` and `*:3000`, same pid, wildcard). Two cheap fixes: make the "the web server is
stopped for the duration" paragraph **conditional** — it currently prints verbatim even when
`--keep-daemon` was passed, which actively misleads — and have the tool suggest `--keep-daemon`
whenever the run is about to be looked at from a phone.

#### First attempt on real hardware, 2026-08-10 — the decision chain works, the radio does not

Run on the Pi 3B+ with an ethernet cable in, so the operator kept a shell while `wlan0` was taken
away — something a Zero 2 W cannot offer, and the reason `hotspot-test.sh`'s header says the test
must detach itself. Worth reusing: `deploy/net-agent.sh:325` judges the network from the **wifi
device only**, so a wired fallback is invisible to it and does not suppress the hotspot.

`nmcli con down bloopbox`, then watched `/run/bloopbox-net/net-state.json` and
`/run/bloopbox/net-request.json` for 80 s.

**Proven, outside a container, for the first time:** the agent published `online:false` with a full
20-network scan; the supervisor honoured `unconfiguredGraceMs` (20 s) and wrote exactly one
`{"action":"ap-up"}` at t=25 s; the agent consumed it; the daemon re-requested at t=65 s when
nothing changed. Agent → state file → daemon → request file is real.

**Three defects, in the order they will bite:**

1. **ROOT CAUSE FOUND — `wifi-sec.key-mgmt none` means WEP, not "open".** A second run with
   `bloopbox-debug on` (persistent journal) caught NetworkManager saying it outright:

   ```
   device (wlan0): Activation: (wifi) access point 'bloopbox-ap' has security,
                   but secrets are required.
   device (wlan0): state change: need-auth -> failed (reason 'no-secrets')
   ```

   `ap_up` asked for `wifi-sec.key-mgmt none` intending an open network. In NetworkManager that
   creates an `802-11-wireless-security` setting meaning **static WEP**, which then fails
   activation for want of a WEP key. An open network needs the setting **removed**:
   `nmcli con modify <profile> remove 802-11-wireless-security` (verified on the device — the
   property disappears from `nmcli con show`). `build-sd-image.sh` already had this right, by
   omitting `[wifi-security]` from the keyfile when there is no passphrase; only the agent was
   wrong.

   `join_network` carried **the same bug** in its no-passphrase branch, so joining an open network
   from the setup portal would have failed identically — a path no test covers because the
   container harness never activates a real profile.

   **Fixed in `deploy/net-agent.sh`** (both sites, plus `ap_up` now sets `LAST_ERROR`), and
   **verified on hardware with a phone in the room, 2026-08-10.** With the fixed agent deployed,
   `wlan0` left the home network within 2 s of the request, the open `bloopbox-7971` network
   appeared on a phone, and NetworkManager's shared mode handed out a `10.42.0.x` lease with
   `10.42.0.1` as the gateway. That closes three of the bullets above at once: `mode ap` +
   `ipv4.method shared` **does** come up on `brcmfmac`, a phone **does** get a lease, and the
   radio returns to the real network afterwards on its own.
2. **`ap_up`'s failure never leaves the journal.** `deploy/net-agent.sh:136-141` logs
   `"hotspot failed to come up"` and returns 1, but nothing writes that into `lastError`, which the
   state file already carries and the daemon already reads. So the one visible symptom on a
   screenless device — LEDs stuck on `WIFI_ERROR` while the retry loop spins forever — is
   indistinguishable from "no network yet". Publishing the failure is cheap and should come first:
   it is what makes the rest of this debuggable at all.
3. **The device drops off the network entirely, and it has now happened twice.** Both times
   `wlan0` *and* `eth0` went silent together — no ssh, no `:3000` — and only a power cycle brought
   it back.

   The first occurrence is explained: a manual `sudo nmcli con up bloopbox-ap` blocked waiting for
   the WEP secret that item 1 describes, which is why subsequent `nmcli` calls appeared to wedge.
   That was a secrets prompt, not a crash — **the earlier reading of this as a hang was wrong.**

   The second is not explained. It followed a bare
   `nmcli con modify bloopbox-ap remove 802-11-wireless-security` — a config write with no
   activation, no AP, and `wlan0` associated normally — and the very next ssh timed out. Nothing
   was captured. Worth pinning down before trusting the device unattended, and worth checking
   whether `bloopbox-debug on`'s 10 s sampler is implicated, since it was running both times and
   was not during the healthy hours before it.

   Practical rule until it is understood: **do not run network tests on this device without
   physical access to it.** A wired fallback is not sufficient — `eth0` went with it, twice.

The failure mode nobody designed for: the device ends up with *neither* the real network *nor* the
hotspot, and the retry loop has no terminal state and no way to say so. `hotspot-test.sh`'s EXIT
trap covers the opposite case (stuck as an AP) and would not have helped here.

**Recovery was clean.** A power cycle brought it straight back: `nmcli con down` is not persistent,
the `bloopbox` profile still carries `autoconnect=true, autoconnect-priority=10`, and NetworkManager
rejoined on its own. No card was pulled and nothing was lost — except the evidence.

**Set this up before repeating the test, in this order:**

1. **`sudo bloopbox-debug on` first.** The post-mortem was impossible because
   `journalctl -b -1` answers `no persistent journal was found` — Pi OS keeps the journal in RAM, so
   the hang took its own explanation with it. `deploy/debug-mode.sh:90-107` already fixes exactly
   this (`Storage=persistent`, capped at 128 M) and its header says so. The tooling was right; it
   was simply not switched on. **Nothing about this run is worth repeating until it is.**
2. **Install `iw`.** It is not in `RUNTIME_PACKAGES` and not on the device, so neither
   `bloopbox-doctor` nor `hotspot-test.sh` can read the regulatory domain or ask whether the radio
   even advertises an `AP` interface combination — the first two things to check when
   `mode ap` will not activate. Worth adding to the debug kit rather than the runtime.
3. **Do not trust ethernet as the fallback without checking the subnet.** `eth0` and `wlan0` both
   landed on `192.168.1.0/24`; with both up, `192.168.1.154` (eth0) stops answering from another
   host on that subnet while `192.168.1.69` (wlan0) answers fine. Fine during the test itself, when
   `wlan0` is down — but it means the wired route cannot be verified in advance from the same LAN.
   A separate subnet, or a direct cable, removes the doubt.

Also unexplained, and worth watching rather than concluding: `eth0` went down *with* the box during
the hang, when `wlan0` was already disconnected. `ipv4.method shared` installs masquerade rules as
part of activation, which is the only plausible link between an AP that would not start and a wired
interface that stopped answering — but nothing was captured to support that, which is what item 1
is for.

#### It happened again, 2026-08-10, on a fresh flash — still item 1's fault, now fixed

Same device, brand-new SD image (the WhatsApp-pairing fixes above), first boot. Symptom this time:
the AP did not appear for over five minutes; a full power cycle (not a soft reboot) with a USB
Ethernet adapter plugged in brought it up within its normal ~66s window, confirmed live over
`ssh bloop@192.168.1.154`. `iw` really was checked this time — `which iw` came back empty for the
`bloop` user, but `journalctl -u bloopbox-net -b` showed `ensure_radio_unblocked` succeeding
(`no regulatory domain was set — defaulted to DE`) within a second of the unit starting, so `iw`
is reachable from root's service environment even though it is not on an interactive login's
`PATH` — worth settling properly (see item 2 above; this session did not `dpkg -l iw` before losing
the connection, so **still not fully confirmed either way**).

While checking that, **the device went dark again** — `ssh` and `ping` both stopped answering,
`bloopbox.local` stopped resolving, mid-session, with no warning. Same address
(`192.168.1.154`) as the earlier incident. Evidence was lost the same way: item 1 above
(`sudo bloopbox-debug on`) had not been run, because the device was not reachable yet when this
session started and there was no way to turn it on in advance.

**Fixed the actual gap this exposes, not the incident itself, then removed once it had done its
job:** `deploy/install.sh` briefly installed a second, separate journald drop-in
(`05-bloopbox-bringup.conf`, persistent, capped at 128M, alongside — not replacing —
`debug-mode.sh`'s own `10-bloopbox-debug.conf`) so every boot's journal survived without anyone
having to reach the device first to turn it on. **Reflashed the same day and it worked cleanly on
the first try** — AP up in ~66s, straight through onboarding to a joined home network, no repeat of
the dark-device symptom. With the immediate question answered, the drop-in was removed from
`install.sh` and purged from the live device (`rm -rf /var/log/journal`, config deleted, journald
restarted) the same session — it was never meant to be permanent. If a device goes dark like this
again, this is the tool to reach for again, but it does not stay on by default.

**What checking those logs turned up instead: `MemoryHigh`/`MemoryMax` have likely never been
enforced on real hardware at all.** `/proc/cmdline` on the live device read
`cgroup_disable=memory` — the Pi's own firmware adds this on boards with this little RAM, to save
the accounting overhead, and it is not present in `/boot/firmware/cmdline.txt` itself so it is easy
to miss. Without the memory controller, every `MemoryHigh=`/`MemoryMax=` in all four unit files is
inert, not just generous — and so was the `RuntimeDirectorySize=64M` that used to sit next to
`RuntimeDirectory=bloopbox` in the two units that share that tmpfs directory, which turned out to
never have been a real per-service directive in the first place (that name belongs to
`logind.conf`'s per-user `XDG_RUNTIME_DIR` sizing) — `Unknown key 'RuntimeDirectorySize'... ignoring`
on every boot, silently. **Fixed 2026-08-10:** removed the fake directive from both unit files, and
`install.sh` now appends `cgroup_enable=memory cgroup_memory=1` to `cmdline.txt` (same
idempotent-append pattern as the `config.txt` step next to it) — which turns `MemoryHigh`/`MemoryMax`
on for real, and since cgroup v2 charges tmpfs pages to the cgroup of whoever wrote them, that is
also what actually bounds `/run/bloopbox` now, without a dedicated mount unit. **Not yet reverified
on real hardware** — needs a reflash and a check of `cat /proc/cmdline` plus
`systemctl show bloopbox-hardware -p MemoryCurrent` for a real number where "file not found" was
before.

### GPIO driver on real hardware

**Partly closed on 2026-08-10** — first real boot, from a `build-sd-image.sh` image, on a
**Raspberry Pi 3 Model B Plus** (not a Zero 2 W). What that boot proved:

- the addon loads against `libgpiod3` on real silicon, and the daemon reports `"driver":"gpio"`
- **all six lines are claimed**, with the intended directions and edges — `gpioinfo` shows 17, 27
  and 22 as `input edges=both` and 23, 24, 25 as `output`, each with an `opengpio_…` consumer
- the firmware pull-up block (`gpio=17,27,22=ip,pu`) is present in `/boot/firmware/config.txt`
- no GPIO error appears in `journalctl -u bloopbox-hardware` across a full boot

That boot also settles the board map: `RaspberryPi_Zero2W` resolves BCM names to the right lines on a
3B+, which is what `PI_BOARD` defaults to. The override exists for a board that does not agree.

Still unproven, and needing a finger and an eye rather than a shell: whether a **press registers**
(no button was pressed during this session), whether `BUTTON_ACTIVE_LOW` matches the wiring, and
whether the LEDs light the right colour in the right order — `--ch-1/2/3` are yellow, coral, teal
and nothing enforces it. The board also matters for what comes next: a 3B+ has an analog audio jack
that a **Zero 2 W does not have at all**, so any playback verified here says nothing about the real
target.

`src/hal/gpioDriver.ts` is written from datasheets and the opengpio API. Lamp polarity and ALSA
device names remain unverified. See the `TODO(hardware)` banner in the driver;
`docs/hardware-bringup.md` is the order to prove things in and what to reach for when one of them
does not work.
Contained behind the HAL, so bring-up should be a debugging session rather than a rewrite.

What packaging did settle: the addon **compiles and loads on arm64 Trixie** against `libgpiod3`,
and `RaspberryPi_Zero2W` is a real export of opengpio 2.0.2 — both verified in a container by
`scripts/smoke-test-release.sh`. What no container can show is whether the pins, the polarity and
the ALSA device names are right. First moves are in `deploy/environment.example`:
`LED_ACTIVE_HIGH`, `BUTTON_ACTIVE_LOW`, `ALSA_CAPTURE_DEVICE`, `ALSA_PLAYBACK_DEVICE`,
`ALSA_MIXER_CONTROL`. If something fails with a permission error rather than wrong behaviour,
comment out the hardening block in the systemd unit before suspecting the driver.

### Audio capture and playback on real ALSA devices

**The first end-to-end run happened on 2026-08-10** — device on the network, WhatsApp linked, cues
audible on button press — and both audio directions were broken, in two unrelated ways. One was a
code bug and is fixed; the other is a mixer default and is only partly settled.

1. **Received voice notes played as noise. Fixed.** `aplay` is not a decoder: it reads WAV, AU and
   VOC, and given a header it does not recognise it plays the bytes as raw PCM rather than failing.
   Inbound notes are saved as Ogg/Opus (`wa-<index>-<id>.ogg`), so every received message was
   full-volume noise while `aplay` exited 0 and nothing was logged. `toPlayableWav` had been written
   for exactly this and was **never called from anywhere** — a dead export. `GpioHal.play()` now
   decodes to a `play-*.wav` in the same tmpfs and removes it afterwards; `playCue` skips the decode
   because cues are generated as WAV. Locked by `src/tests/gpioPlayback.test.ts`.
2. **Recordings came out the right length and completely silent. Partly fixed.** The WM8960's input
   PGAs power up **muted** (`LINMUTE`/`RINMUTE` default to 1) and `amixer sset Capture 60% cap` moves
   the volume register without touching the mute bit, so capture streamed correctly and carried no
   signal — the same shape of failure as the `… Output Mixer PCM` switches, one stage earlier.
   `GpioHal` now unmutes in a **separate** `amixer` call (a parameter the adapter's control does not
   have would fail the whole line and take the gain with it), and `bloopbox-audio-init.service`
   unmutes at boot so `bloopbox-audio-test` and a bare `arecord` see the same routing, persisted by
   the `alsactl store` it already ran.

**The mute was not the whole cause — settled the same evening over ssh, on the device.** Playback
was confirmed fixed by ear. Capture then produced faint static, which turned out to be two more
defaults plus a measurement problem of my own:

- `Left/Right Input Mixer Boost` (LMIC2B) defaults **off**, disconnecting the input PGA from the
  boost mixer that feeds the ADC. Worth **42 dB**.
- The mic boost stage `Left/Right Input Boost Mixer LINPUT1` defaults to **0 dB**; 3 is +29 dB.
- `config.audio.micGainPercent` 60 mapped to PGA 49/63. Now **80** → 57 (+25.5 dB) — 100 (+30 dB)
  was tried first and was audibly too hot on a real voice.

Both switches are now in `ALSA_ENABLE_SWITCHES`, whose grammar gained `Name=Value` so a gain stage
can be expressed at all. The measurement that settled it: a full-scale 1 kHz tone played through the
HAT's own speaker while `arecord` ran, comparing the tone window against a silent window **of the
same recording** — the tone read −62 dB with the boost switch off, −20 dB with it on, −8.4 dB with
the boost stage at 3. Selecting LINPUT2 or LINPUT3 instead read −80.8 dB (digital silence), which is
what proves the mics are on **LINPUT1/RINPUT1** rather than merely suggesting it.

Four things worth not re-deriving:

1. **Ambient room noise is useless as a stimulus.** Two passes of the same sweep disagreed by 18 dB.
   Every conclusion here rests on the tone, and on two windows of one recording rather than two
   recordings.
2. **MICBIAS is not needed.** It reads `MICB=0` and the mics work. An earlier "test" of it was void:
   `i2cset` was not installed, and the failure was swallowed — see the item below.
3. **The codec's registers must be read during an open capture.** ASoC powers the input path down at
   idle, so `AINL/AINR/ADCL/ADCR=0` at rest is normal and means nothing. `/sys/kernel/debug/regmap/
   1-001a/registers` while `arecord` runs is the real reading.
4. **`ADC PCM Capture Volume` is not a simple mixer element.** `amixer sset` cannot address it and
   fails silently; `amixer cset name=…` can. It stays at its 0 dB default — digital gain lifts the
   noise floor with the signal.

**Closed by ear the same evening:** a real voice at PGA 63 (+30 dB) was too hot, so the default is
`micGainPercent` **80** → PGA 57, where the tone peaks at −15.3 dB with the floor at −29.9 dB. What
is still unmeasured is the extreme: a child shouting into the box at 10 cm. If that clips, the same
knob is the answer, and the +29 dB boost stage carries enough that the PGA can come down a long way
before the faint-static failure returns.

### `--audio-hat wm8960` promises i2c-tools and the SD-image path does not deliver it

Found 2026-08-10 while debugging capture: `command -v i2cset` on a device flashed from
`…-wm8960-noleds.img.xz` returns nothing, although `install.sh --audio-hat wm8960` documents
installing `i2c-tools`. The image builder runs the installer with `--skip-deps` (a chroot cannot
usefully apt-get for the target in every case), and `i2c-tools` is not in the package list
`build-sd-image.sh` installs itself. Nothing in the product needs it — it matters only because it is
the tool for talking to the codec directly, so its absence turns a diagnostic into a silent no-op.
Either add it to the image builder's list or stop claiming it in `--help`.

Unchanged and still worth an explicit check: the `amixer` control name differs across USB adapters
(`PCM`, `Speaker`, `Master`), and `GpioHal` treats a mixer failure as non-fatal — so a wrong name
means playback at whatever volume the adapter booted with, silently, ignoring `speakerVolumePercent`
entirely. Set the volume in the admin panel, then read it back with `amixer sget <control>`.

### The MVP board (Pi 3B+ + WM8960 HAT) is configured from documentation, not measurement

Added 2026-08-10. The first real device is a Pi 3B+ with a **Waveshare WM8960 audio HAT**, using the
HAT's own button as button 1 and **no LEDs at all** — `install.sh --audio-hat wm8960 --no-leds`.
`docs/hardware.md` describes the board and `docs/hardware-bringup.md` gate 4a is the order to prove
it in. Everything below was reasoned from vendor tables, the kernel overlay source and third-party
wikis; **waveshare.com returns 403 to every fetch from here**, so none of it is measured, and all four
are cheap to check on the bench.

1. **That the HAT's P17 button is a populated switch.** Waveshare's pin table lists
   `BUTTON → P17 (header pin 11), configurable` and its own procedure reads `1` released / `0`
   pressed — active-low, matching `BUTTON_ACTIVE_LOW`. But a pin table entry is not a photograph, and
   P17 may be broken out rather than fitted with a switch. `gpiomon gpiochip0 17` settles it. If it
   is not populated, the fallback is a wire from GPIO17 to ground through any momentary switch.
2. **That the card is called `wm8960soundcard`.** The in-tree overlay sets
   `simple-audio-card,name = "wm8960-soundcard"`, and ALSA derives an id by stripping punctuation —
   hence `plughw:CARD=wm8960soundcard,DEV=0` in the environment. Addressed by name rather than number
   on purpose, so a card enumerating differently cannot silently move the daemon onto the Pi's own
   headphone jack. `aplay -L` prints the truth; `bloopbox-doctor` and `bloopbox-audio-test` both now
   check the configured name against it.
3. **That the mixer controls are `Master` and `Capture`.** Both are silent failures by design
   (`GpioHal` treats mixer errors as non-fatal), which is why doctor checks them. The WM8960 also
   has input **boost** switches whose names vary by kernel version; if capture is silence at a
   plausible gain, that is the next suspect and `amixer contents` is where to look.
4. **That `CAPTURE_RATE=48000` is needed.** Predicted, not observed: the codec is the clock consumer
   on a shared I²S bit clock, so it cannot hold two rates at once, and the cues are 48 kHz
   (`scripts/generate-sounds.ts`) while capture defaults to 16 kHz. The **record pop fires at
   `recordThresholdMs`, while capture is open** — the one place in the product where both directions
   are live at the same rate-critical moment. Setting 48 kHz makes them agree and lets ffmpeg
   resample during encode, which it already does; the cost is a larger intermediate WAV in tmpfs.
   If the conflict turns out not to exist, dropping the variable restores the no-resample path.

Also unproven and specific to this board: **whether the device records itself.** Speaker and
microphone are centimetres apart on one HAT. `#commitCapture` finalises before the whoosh for exactly
this reason, but the inbound chime and the record pop still play while the mic is live.

Two decisions worth not re-litigating:

- **Use the in-tree `wm8960-soundcard` overlay, never the vendor DKMS driver.** Waveshare's
  `WM8960-Audio-HAT` repository is unmaintained and its module breaks on new kernels — a bad bet on a
  Trixie target. The overlay needs nothing installed.
- **The Pi 3B+'s own ACT and PWR LEDs were considered and rejected** as a two-channel light show.
  On the 3B+ specifically both hang off a GPIO expander reachable only from the VPU, so every write is
  a firmware mailbox round-trip against a `setLed` the animator calls at 20 Hz; `/sys` is read-only
  under `ProtectKernelTunables=yes` and the files are root-owned, so it needs a udev rule and a
  hardening exception; and two fixed-colour LEDs cannot express the matrix. Lamps on this board need
  no extra part: the HAT passes the header through, so 22/23/24/25/27 stay reachable with it seated.

### The root agent's request acknowledgement has only run in a container

Changed 2026-09-23 (`docs/deployment.md` § the request channel). The agent no longer deletes
`/run/bloopbox/net-request.json`: it acts once per request id, records the id in
`/run/bloopbox-net/handled-request-id`, and publishes it as `handledRequestId`, and the daemon
deletes its own file when that id comes back. The reason was reasoned from systemd's documented
`ProtectSystem=strict` behaviour rather than measured, so the first thing to do on a device is to
confirm it and then confirm the fix:

- `sudo systemd-run --wait -p ProtectSystem=strict touch /run/bloopbox/x` should fail with EROFS.
  If it succeeds, the old code was not replaying requests after all, and the acknowledgement is
  belt and braces rather than a fix.
- After a Wi-Fi join or a reboot request from the panel, `cat /run/bloopbox-net/net-state.json`
  should carry `handledRequestId`, `/run/bloopbox/net-request.json` should be gone within a few
  seconds, and `journalctl -u bloopbox-net` should show the action once.

`scripts/test-onboarding.sh` now proves the action runs once and is acknowledged, but it runs the
agent outside systemd, so it cannot show the sandbox itself.

### Playback interruption on the GPIO driver is tested against a fake aplay only

Also 2026-09-23. `GpioHal.stopPlayback()` now waits for `aplay` to exit (SIGKILL after 500 ms)
before anything else plays, and a note cut off by a signal resolves `'interrupted'`. That is the
fix for the device-busy and deleted-unheard bugs (`docs/architecture.md` § Nothing plays over a
note), and `gpioPlayback.test.ts` covers it against a fake child process. On a device, check two
things: tapping a blinking button, then pressing **Test speaker** in the panel mid-note, leaves the
lamp blinking and the note on the card; and a second note sent while the first plays neither chimes
nor cuts the first off.

### The capture and helper-process hardening is tested against fake children only

Added 2026-09-24. Each of these was written against a mocked `child_process` and none has run on a
Pi. `docs/architecture.md` § Audio has the reasoning.

- **`arecord` exiting by itself.** The driver now tracks the exit from spawn, so a stop after
  arecord has died returns at once and logs `arecord exited before the recording was stopped` with
  its stderr. Nobody has seen what a real early exit looks like, for example a USB adapter pulled
  mid-take or a rate the codec refuses. Check that the take is refused with the "oops" (its WAV is
  short, so its duration is short) and that the warning reaches the journal.
- **Duration from the WAV size.** `(size − 44) / (rate × 2 × channels)` assumes `arecord -t wav`
  writes the canonical 44-byte header. Check that a take's reported duration matches `soxi`/
  `ffprobe` on the capture, at both `CAPTURE_RATE=16000` and `48000`.
- **Deadlines.** ffmpeg gets 30 s + 2× the audio (5 min when the length is unknown) and amixer 5 s.
  The margins come from desk measurements, not from a loaded Zero 2 W decoding with `loudnorm`
  beside a capture.
- **Arrival decodes beside a capture.** They are held while `arecord` is open and reniced to 10.
  Nobody has measured whether a `loudnorm` decode that is already running when a take starts
  still causes overruns at that niceness (look for `overrun!!!` in the journal). If it does, hold
  capture-side work instead, or pause the decode with SIGSTOP. `setPriority` on a pid that is
  already gone is swallowed, and that has only been exercised against a mock.
- **amixer warnings.** A wrong control name now logs at `warn` with amixer's stderr. Check that a
  deliberately wrong `ALSA_MIXER_CONTROL` logs the warning, and that a correctly configured box logs
  nothing at boot.

### The first-boot ssh password has only run in a container

`deploy/ssh-password.sh` was exercised on Debian Trixie in Docker, 2026-09-23: no marker, a user not
yet renamed (marker kept, exit 1), a bad name (refused), a real run (record `0640 root:bloopbox`,
the recorded password verified against `/etc/shadow`, marker removed), and a second boot (no-op).
What that cannot show is the **ordering on a real first boot**: that `userconfig.service` has
renamed `pi` before the unit runs, and that `sshswitch.service` / `ssh.service` wait for it. If the
rename lands later, the unit exits 1 and succeeds on the next boot, and during that one boot the
account keeps the throwaway password nobody knows, so it fails closed. Worth confirming on the first
flashed card with `systemctl status bloopbox-ssh-password` and
`journalctl -b -u userconfig -u bloopbox-ssh-password -u ssh`, and adding to
`docs/hardware-bringup.md`'s image gate.

### An MVP-profile SD image now exists, but has never been booted

Added 2026-08-10. `build-sd-image.sh` gained `--audio-hat` / `--no-leds`, passed straight through to
`install.sh` inside the image, so gate 4a can start from a flashed card instead of an ssh install —
which is the point of the image, and was previously impossible for this board: the builder hardcoded
`install.sh --skip-deps --no-start` and produced a card configured for USB audio and three LED lines.

`release/bloopbox-0.1.0-…-wm8960-noleds.img.xz` is built and its contents verified by mounting it:
seven cue WAVs in `/opt/bloopbox/dist/audio/sounds/`, `LED_PINS=` empty, `CAPTURE_RATE=48000`,
`plughw:CARD=wm8960soundcard` both directions, `Master`/`Capture` mixers, `dtoverlay=wm8960-soundcard`
and `gpio=17,27,22=ip,pu` in `config.txt`, four units enabled. **None of that has been booted** — a
mounted filesystem proves the installer wrote what it claims, not that the board comes up.

One thing to watch on first boot: `config.txt` ends up with stock Pi OS's `dtparam=audio=on` *and*
the installer's later `dtparam=audio=off`, which is how the onboard bcm2835 codec is meant to get out
of the WM8960's way. Later wins, so this should be right, but if `aplay -l` shows two cards the
ordering is the first place to look.

### Simulator playback timing

In headless Chrome each 140ms clip took ~5s to report `ended`, because there is no audio output
device to drive the media clock. Order and completion were correct. Worth confirming on a real
browser with speakers that playback runs at the right speed.

### The designed cues have only been measured, never heard on the device

Added 2026-08-10, when `boot`, `notify` and `swoosh` became designed recordings
(`box/software/src/audio/samples/*.mp3`) instead of synthesised tones. `swoosh` was retired on
2026-08-17 when a send went down to one sound, so two remain. What is verified is arithmetic: each
masters to mono 48 kHz PCM at its declared peak (−7.1 / −8.0 dBFS) and to its audible length
(825 / 318 ms), and `dist/audio/sounds/` carries all six cues after a build. What is not verified is
how any of it sounds through a small speaker at a toddler's ear.

Three specific things to listen for during bring-up, in gate 4a's audio pass:

1. **Whether the designed cues sit at the same loudness as the remaining beeps.** They were matched
   by peak amplitude, which is the honest measure to match on but not the one ears use — a 318 ms
   sound with sustain is perceived louder than a 90 ms click at the same peak. If `notify` comes out
   obviously hotter than `pop` and `oops`, the fix is its `peak` in `scripts/generate-sounds.ts`, and
   the tones are the ones to leave alone.
2. **Whether `boot` at 825 ms is too long to sit under a 2.6 s LED chase**, and whether it reads as
   "the box came back" rather than as a noise the box made.
3. **The tail trim.** Trimming stops `MIN_SILENCE_S` (100 ms) after the last audible 100 ms window and
   keeps `TAIL_PAD_S` (30 ms), so a long soft decay could in principle be clipped where a sudden stop
   would not be. Nothing in the three current sources looks close to that boundary, but a redesigned
   cue with a reverb tail is exactly the case that would hit it — and it would be audible as a cut,
   not visible in the numbers.

---

## Watch items

Not work, but things that could bite.

- **The three lamps now draw their current from the header itself.** Changed 2026-09-08: the lamps are
  3 V, so the ULN2003 came out and each lamp hangs between its GPIO pin and ground. A BCM283x pin
  sources 16 mA comfortably and the header wants to stay under ~50 mA in total, and the LED matrix
  lights all three at once routinely — so the margin is real but thin, and it depends entirely on
  which lamps get fitted. Worth an ammeter at gate 5 rather than a guess: dim lamps, a lamp that
  dims when its neighbours light, or an unexplained brownout under a marginal supply all point here
  first. Nothing in software changes if it turns out a transistor is needed after all; `setLed` is
  the same call either way.
- **How much of a first word the microphone misses, now that it opens behind the bip.** Changed
  2026-08-17: the "pop" plays at `recordThresholdMs` (150 ms) and `arecord` is spawned only once the
  cue has finished, so nothing before the bip exists in the message. Deliberate — the bip is the
  invitation to speak — but the dead window is `recordThresholdMs` + 90 ms of cue + however long ALSA
  takes to open a stream on the WM8960, and **that last term has never been measured**. If a child
  who starts talking right on the bip loses a syllable, the term to look at is the stream open, not
  the cue: `arecord` writing its first frames late is invisible from here and would look exactly like
  a child who spoke too early.
- **A tap held past 150 ms opens and closes the microphone for nothing.** The bip has to precede the
  tap/hold decision, so a press over `recordThresholdMs` bips, spawns `arecord`, and then turns out to
  be a tap. `#playQueue` awaits `#teardown` before starting playback specifically so the capture is
  closed before a note plays — the WM8960 runs both directions off one I2S clock, and this is the one
  path that could ask it for two things at once. Watch for a stutter at the start of the first note of
  a queue on real hardware; if it appears, the SIGTERM-to-exit of `arecord` is the thing in the way.
- **`CAPTURE_RATE=48000` may no longer be necessary.** It exists because the codec cannot hold two
  rates on one clock and the cues are 48 kHz — but the only cue that overlapped a capture was the bip,
  and it no longer does (2026-08-17). Dropping to 16 kHz would shrink the intermediate WAV and remove
  a resample from the encode. **Not changed blind**: it is written by `install.sh --audio-hat wm8960`
  and the failure mode is a silent recording, so it wants a real device and gate 4a.
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
- **`MemoryMax` on the two units is a guess, not a measurement — and was likely never enforced at
  all until 2026-08-10.** 128/192 MB for the hardware server and 192/288 MB for the bridge, on a
  512 MB device. Found live: the Pi's firmware disables the memory cgroup controller by default on
  boards this small, and nothing had turned it back on, so `MemoryHigh=`/`MemoryMax=` on all four
  units had nothing to attach to. Fixed by having `install.sh` set `cgroup_enable=memory
  cgroup_memory=1` on the kernel command line — see the hotspot "went dark" entries above for the
  full story. Once that is confirmed live on a reflashed device, the original ask still stands:
  `bloopbox-debug on` samples `MemoryCurrent` for every unit every 10s, so measuring the real
  numbers (rather than guessing) is a `jq` one-liner over `/var/log/bloopbox/trace.jsonl` — see
  `docs/hardware-bringup.md`. Worth doing especially for the bridge during a media download, and
  worth checking the two units don't now start OOM-killing each other where they silently didn't
  before.
- **Tests that depend on filesystem work must use `waitFor`, not a fixed `flush(n)`.**
  `deviceController.test.ts` runs on fake timers with `setImmediate` left real, because the
  commit path awaits `rm`. A fixed number of yields passed in isolation and failed
  intermittently under parallel load. Anything asserting on post-`rm` state should wait on a
  condition.
