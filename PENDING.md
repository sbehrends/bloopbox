# Pending

Work identified but not yet done. Add items here as they come up rather than losing them in
conversation; move them out when they ship.

Ordered roughly by priority within each group.

---

## Features

### The website is a first iteration, and three things are still missing

The marketing site landed on 2026-08-02: `website/`, one statically exported Next.js 16 page. It is
complete as a page — hero with an interactive device, one section per argument, and a build guide —
but it cannot be published as it stands.

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
  the reachable-device case, and cheap: delete the `bloopbox` NM profile (or hand the agent an
  action for it — `NET_ACTIONS` in `src/net/netState.ts` would need a fourth entry) and let
  `NetworkSupervisor`'s existing `unconfiguredGraceMs` path do the rest.
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

### A factory-reset control that wipes all user configuration

Requested 2026-08-10, alongside the Wi-Fi-forget item above — related, but a different blast
radius and worth keeping separate rather than building one control that tries to be both.

**What it should do.** Delete `/data/config.json` (falls back to `config.default.json` in RAM per
the existing safety constraint), clear the WhatsApp auth state so the next boot needs a fresh QR
pairing, and land the device back at onboarding exactly as it behaves on a first boot with no
config. What it should *not* touch: the SD image itself, the installed application, or the
`bloopbox` system user — this is a config wipe, not a re-flash.

**Trigger, and why it needs care.** This is the most destructive control the device can expose to a
child's room, so the bar for "impossible to trigger by accident" is higher than the silent chord or
the Wi-Fi-forget idea above. Worth deciding deliberately rather than defaulting to "all three
buttons, held a while": consider a hold duration well past `maxRecordingSeconds` (so it cannot be
reached by an unusually long recording attempt), and whether it needs a two-step confirmation the
existing LED vocabulary can express (`PRODUCT.md` §6's patterns are all currently spoken for, so a
new one needs a priority-ladder slot in `ledPriority.test.ts`, not just a cue). The admin panel is
the safer primary path — a button behind confirmation, no timing tricks needed — with the physical
chord reserved for the case the panel is exactly what a factory reset needs to route around: a
device nobody can reach.

**Acceptance.** From a fully configured device: trigger the reset, confirm `/data/config.json` is
gone and `system.configured` reads `false`, confirm WhatsApp requires a fresh pairing QR rather than
resuming the old session, and confirm the three buttons and their contacts are all unassigned —
covered by a test in the same family as `adminAuth.test.ts`'s onboarding-boundary checks.

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

### The mark is drawn twice and copied twice more, and nothing enforces that the four agree

`box/software/public/shared/bloopbox-mark.svg` (three concentric ring pairs, for 24px and up) and
`bloopbox-favicon.svg` (three solid discs, for browser tabs) are separate hand-drawn files sharing
no code. They have to agree on five colours and on the left-to-right button order — **yellow,
coral, teal** — and today the only thing keeping them in step is the comment in each and `/brand/`,
which renders both side by side.

Since 2026-08-02 both are also **copied into `website/public/`**, along with the palette in
`website/app/tokens.css`. The duplication is deliberate — the site and the box share a brand, not a
build (`website/README.md`) — but it doubles the count: a colour or button-order change is now four
files, and only the two in `box/software/` are ever seen side by side.

Cheap guard if this ever drifts: a test that parses both SVGs and asserts the `fill` values appear
in the same order, and that both match `--ch-1/2/3` in `tokens.css`. Three assertions, no browser.
Not written yet because `src/tests` has no fixture that reads `public/`. Extending it to the
website's copies means reading across packages from a box test, which the decoupling rule argues
against — the honest options are a root-level script or accepting the comment as the guard.

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

### GPIO driver on real hardware

**Partly closed on 2026-08-10** — first real boot, from a `build-sd-image.sh` image, on a
**Raspberry Pi 3 Model B Plus** (not a Zero 2 W). What that boot proved:

- the addon loads against `libgpiod3` on real silicon, and the daemon reports `"driver":"gpio"`
- **all six lines are claimed**, with the intended directions and edges — `gpioinfo` shows 17, 27
  and 22 as `input edges=both` and 23, 24, 25 as `output`, each with an `opengpio_…` consumer
- the firmware pull-up block (`gpio=17,27,22=ip,pu`) is present in `/boot/firmware/config.txt`
- no GPIO error appears in `journalctl -u bloopbox-hardware` across a full boot

Still unproven, and needing a finger and an eye rather than a shell: whether a **press registers**
(no button was pressed during this session), whether `BUTTON_ACTIVE_LOW` matches the wiring, and
whether the LEDs light the right colour in the right order — `--ch-1/2/3` are yellow, coral, teal
and nothing enforces it. The board also matters for what comes next: a 3B+ has an analog audio jack
that a **Zero 2 W does not have at all**, so any playback verified here says nothing about the real
target.

`src/hal/gpioDriver.ts` is written from datasheets and the opengpio API. ULN2003 polarity and ALSA
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

**Blocked on hardware as of 2026-08-10:** the first device has **no capture device at all**.
`arecord -l` lists nothing, `/proc/asound/cards` shows only `bcm2835 Headphones` and `vc4-hdmi`, and
`lsusb` shows no audio device — only the internal hubs and the LAN7800. `bloopbox-doctor` reports
this correctly as `✗ capture device — none — is the USB microphone plugged in?`. Until a USB
microphone is attached, recording cannot be exercised at all, so everything below is still open.

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
