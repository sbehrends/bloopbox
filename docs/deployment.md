# Deployment

How the code gets onto a Raspberry Pi. Two routes: a **release tarball** you install over ssh,
or a **flashable SD card image** with everything already in place.

Both are produced by Docker on a dev machine or by CI, and the Pi compiles nothing.

For a **new board** — the Pi Zero 2 W target included — follow
[`hardware-bringup.md`](./hardware-bringup.md) rather than this page: it sequences the subsystems so
only one unproven thing is in play at a time, and it carries the debugging kit.
[`hardware.md`](./hardware.md) is the wiring and the parts list.

## The target is Raspberry Pi OS Trixie, 64-bit

Not a preference — a constraint, and the reason is worth knowing before someone tries to
"support Bookworm too":

`opengpio@2.0.2` (the GPIO addon) is written against the libgpiod **v2** C++ API. Bookworm
ships libgpiod 1.6, where `gpiod::line::value` and `line_request::release()` do not exist, so
the addon fails to compile and the device has no buttons and no lights. Trixie ships libgpiod
2.2 — `libgpiod3` at runtime, `libgpiod-dev` to build — which is what it needs. Every current
Pi OS Lite arm64 image is Trixie anyway.

32-bit is not a target either: Node publishes no official armv6 build, and the Pi Zero 2 W is a
Cortex-A53, so arm64 is both available and faster.

Everything pinned — the Node and Debian base images, the Pi OS image and its checksum, the apt
package lists, the root-partition growth — lives in
[`packaging/versions.env`](../box/software/packaging/versions.env), sourced by every release script.

## Building a release

From `box/software/`:

```bash
npm run release            # -> release/bloopbox-<version>-linux-arm64.tar.gz (+ .sha256)
npm run release:smoke      # install and boot it in a bare arm64 Debian Trixie container
```

The tarball (~58 MB) carries:

| Contents                         | Why it is in there                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/`                          | Compiled server, the browser UIs, and the generated cue WAVs                                                                            |
| `node_modules/`                  | Built **for arm64**, including the compiled `opengpio` addon and sharp's prebuilt libvips. A macOS `npm ci` tree is the wrong platform. |
| `node/bin/node`                  | The runtime, lifted out of the build image so the native addon's ABI and the runtime that loads it cannot disagree                      |
| `package.json`                   | Not optional: without `"type": "module"` beside `dist/`, node rejects every import in it                                                |
| `config.default.json`            | What the daemon falls back to, resolved relative to `dist/`                                                                             |
| `deploy/`, flattened             | `install.sh`, the operational scripts, the systemd units and `environment.example`                                                      |
| `release.env`                    | Version, git SHA, build date and Node version, which `install.sh` and `bloopbox-doctor` print                                            |

On an Apple Silicon or arm64 Linux host this is a native build. On x86 it runs under QEMU —
correct but slow — and needs `docker run --privileged --rm tonistiigi/binfmt --install arm64`
once. The timestamps are pinned to the last commit (`SOURCE_DATE_EPOCH`), so rebuilding the same
tree gives the same bytes.

The build fails loudly if `opengpio` did not compile. `opengpio` is an `optionalDependency`, so
npm shrugs off a failed build, and a release that shipped without it would install fine and
produce a device with three dead buttons.

`release:smoke` runs the installer for real in a container with no systemd, then boots both
daemons on the mock HAL and checks the API, the panel, a cue and the bridge's token handshake — run
it after touching `deploy/` or `packaging/`. `scripts/test-onboarding.sh` drives first-boot
onboarding (hotspot, portal, scan, join) against the same tarball with only `nmcli` faked.

## Installing on a Pi

```bash
scp release/bloopbox-0.1.0-linux-arm64.tar.gz <user>@bloopbox.local:
ssh <user>@bloopbox.local
tar xzf bloopbox-0.1.0-linux-arm64.tar.gz
sudo ./bloopbox-0.1.0-linux-arm64/install.sh --audio-hat wm8960
sudo reboot
```

What it does:

- `apt-get install ffmpeg alsa-utils libgpiod3 dnsmasq-base` — the four things npm cannot supply
  (`dnsmasq-base` is the setup hotspot's DHCP and DNS) — plus `i2c-tools` for `--audio-hat wm8960`
- creates the `bloopbox` system user, in the `gpio` and `audio` groups
- creates `/data` (settings, WhatsApp credentials, inbound notes) owned by that user
- installs the app to `/opt/bloopbox`, staged and swapped so a failed copy cannot leave
  half an application behind, and links `bloopbox-doctor`, `-audio-test`, `-diagnostics`,
  `-debug` and `-hotspot-test` into `/usr/local/bin`
- writes `/etc/bloopbox/environment` with a **generated** `BRIDGE_TOKEN`, and
  `/etc/bloopbox/profile` (below)
- gives NetworkManager's shared-mode dnsmasq a wildcard (`address=/#/10.42.0.1`), which is what
  makes a phone's captive-portal sheet open on the hotspot
- installs and enables the systemd units, and the userspace half of the hardware watchdog
  (`RuntimeWatchdogSec=15s`)
- appends a marked block to `/boot/firmware/config.txt`: the GPIO pull-ups, the watchdog and any
  HAT overlay, opened with an explicit `[all]` so it never inherits a board filter such as `[cm4]`
  that the file happened to end on
- adds `cgroup_enable=memory cgroup_memory=1` to `cmdline.txt`. Pi firmware switches the memory
  controller off on boards with this little RAM, and without it every `MemoryHigh` / `MemoryMax`
  below is inert
- pins the journal to RAM (`journald.conf.d/50-bloopbox.conf` — see "When something is wrong")
- restarts the services

**The reboot is not optional.** The pull-ups, the HAT overlay and the memory controller are all
firmware or kernel settings: until the reboot the buttons float and there is no sound card.

Re-running it is an upgrade: `/data` and the environment file are left alone, so the parent's
settings and the WhatsApp pairing survive.

Then check it:

```bash
sudo bloopbox-doctor
sudo bloopbox-audio-test    # speaker out, microphone in, played back
```

`bloopbox-doctor` is the bash counterpart to `npm run doctor` — the tsx version cannot run on the
device, which has no devDependencies. It checks the runtime, the addon, ffmpeg's Opus encoder, the
ALSA devices, mixer controls and routing, the firmware pull-ups and audio profile, `/data`, the
tmpfs, the cue files, the services, the network agent and the clock.

Useful flags: `--skip-deps`, `--no-boot-config`, `--no-watchdog`, `--no-start`, `--simulator`
(runs the browser simulator HAL on a box with no buttons), `--prefix`, `--data-dir`, `--user`,
`--boot-dir`, `--force`.

Two describe the hardware rather than the install, and both write into
`/etc/bloopbox/environment` — which means their **environment half only takes effect on a first
install**, since an upgrade deliberately keeps that file. Passing them to an upgrade warns and
tells you to edit it:

| Flag | Effect |
| ---- | ------ |
| `--audio-hat wm8960` | Adds `dtoverlay=wm8960-soundcard`, `dtparam=i2c_arm=on` and `dtparam=audio=off` to `config.txt`, installs `i2c-tools`, and writes the codec's ALSA device, mixer controls, routing switches and capture rate. **No sound card exists until the reboot.** |
| `--no-leds` | `LED_PINS=` — claim no output lines. The three logical channels remain; `setLed` is a no-op. Only for a board with no lamps wired |

The reference board (`hardware.md`) — a Pi 3B+ with the HAT, three buttons and three lamps — is
`--audio-hat wm8960` and **never `--no-leds`**.

### The box remembers which board it is

Both flags are recorded in **`/etc/bloopbox/profile`**, and an upgrade that passes neither reads
them back. Give them once, on the first install; after that `sudo ./install.sh` on its own is
correct and keeps the board it finds.

```
AUDIO_HAT=wm8960
NO_LEDS=false
```

Machine-written, world-readable, and not the place for settings — those go in `environment` next
to it. The resolution order is:

    explicit flag  >  /etc/bloopbox/profile  >  inferred from an existing environment  >  usb

The third step covers a box installed before the file existed: an environment naming
`wm8960soundcard` means a wm8960 board, and an empty `LED_PINS=` means no lamps.

**Why it exists.** `environment` is written once and never rewritten, but the `# >>> bloopbox >>>`
block in `config.txt` is deleted and regenerated on *every* install. A profile that lived only on
the command line was therefore lost the first time anyone re-ran the installer without the flags,
leaving the environment pointing at a codec whose overlay had just been removed. The box booted,
joined Wi-Fi, reported `READY` — and had no sound card at all (2026-09-07; `PENDING.md`).

Two guards stand behind the record:

- **The installer refuses to downgrade.** Resolving to `usb` on a box whose profile or environment
  says `wm8960` is an error, not a rewrite. `--force` overrides it, for a HAT that really has been
  removed.
- **`bloopbox-doctor` checks that the two still agree.** A profile saying `wm8960` while
  `config.txt` carries no `dtoverlay=wm8960-soundcard` is a failed check *before* the reboot that
  would make it audible, and the admin panel's health card says the same thing in words a parent
  can act on.

## Building a ready-to-run SD card

```bash
# The reference board — Pi 3B+ with the WM8960 HAT, three buttons and three lamps:
sudo ./scripts/build-sd-image.sh --audio-hat wm8960
# -> release/bloopbox-<version>-<pi-os-image>-wm8960.img.xz  (~660 MB), plus .sha256 and .credentials.txt

# With the family Wi-Fi baked in (local builds only — see CI below):
sudo ./scripts/build-sd-image.sh --audio-hat wm8960 --wifi-ssid Home --wifi-psk secret --wifi-country DE
```

`<pi-os-image>` is `PI_OS_IMAGE` from `versions.env` (today `2026-06-18-raspios-trixie-arm64-lite`).
It takes the newest tarball in `release/`, so run `npm run release` first.

**Match the flags to the board.** `--audio-hat` and `--no-leds` are passed straight through to
`install.sh` inside the image, and they are the difference between a card that works on a board
and one that boots with the wrong ALSA device, or with its lamps never driven. Getting it wrong
means ssh-ing in to re-run the installer, which is the whole thing the image exists to avoid. A
non-default profile goes into the filename (`-wm8960`, `-noleds`), so two boards' images cannot
overwrite each other in `release/`, and the `.credentials.txt` beside the image records the exact
`install.sh` line it was built with.

Flash it with Raspberry Pi Imager (**Use custom**) or `dd`, put the card in, power up. No ssh
step, no install step. The card carries the daemons enabled, ffmpeg and libgpiod, the firmware
settings, ssh on, a login user (`bloop` by default), and optionally your Wi-Fi. First boot expands
the root filesystem and reboots once.

It needs Linux and root — it attaches the image to loop devices and chroots into it. On macOS,
use a privileged container, from `box/software/`:

```bash
docker run --rm --privileged --platform linux/arm64 \
  -v "$PWD":/repo -v "$PWD/release/image-work/cache":/work/cache:ro -w /repo \
  debian:trixie-slim bash -c 'apt-get update -qq && apt-get install -y --no-install-recommends \
    curl xz-utils parted e2fsprogs dosfstools openssl ca-certificates util-linux mawk zerofree && \
    ./scripts/build-sd-image.sh --work-dir /work --audio-hat wm8960'
```

**`--work-dir /work` is load-bearing there, not a preference.** The scratch image is copied with
`cp --sparse=always`, which punches holes, and a bind mount of a macOS directory cannot — Docker
Desktop and OrbStack both fail with `error deallocating: Invalid argument` on the very first copy.
`/work` is the container's own filesystem, which can. Binding `…/image-work/cache` in separately is
what keeps the ~500 MB Pi OS download between runs, since the cache lives under the work dir. It
is mounted read-only, so the cache has to be filled once first: drop `:ro` for that run.

Options: `--hostname`, `--user`, `--password` (see [the ssh password](#the-ssh-password)),
`--wifi-ssid` / `--wifi-psk` / `--wifi-country`, `--audio-hat`, `--no-leds`, `--no-ssh`,
`--keep-img`, `--artifact`, `--output`, `--work-dir`.

### What the builder does to the stock image

1. Downloads the pinned Pi OS Lite arm64 image and **verifies its checksum**.
2. Grows the file and the root partition by `IMAGE_GROW_MB` (1792 MB) — Lite has nowhere near
   enough free space for the bundled runtime plus ffmpeg. First boot still expands the partition
   to fill the real card: the `resize` token in `cmdline.txt` is untouched and the root partition
   stays last.
3. Attaches each partition as its own loop device, using offsets from the partition table
   rather than `losetup --partscan`, which needs a udev that no container has.
4. `apt-get install`s `RUNTIME_PACKAGES` inside the image, then runs the same `install.sh` the ssh
   route uses, with `--skip-deps --no-start` plus any hardware-profile flags: units are enabled
   offline and come up on first boot. An image for the WM8960 board differs from the default one
   *only* in what that one command writes to `/etc/bloopbox/environment` and `config.txt`.
   Because of `--skip-deps`, a wm8960 image carries **no `i2c-tools`** (`PENDING.md`).
5. Seeds the device: hostname, `userconf.txt`, the `ssh` marker, a NetworkManager keyfile for
   Wi-Fi, and two plain-text files on the boot partition (below).
6. Zeroes the free blocks (when `zerofree` is present) and compresses.

The login user is handed to Pi OS's own `userconfig.service` through `userconf.txt` rather than
created by hand. The image ships a `pi` user which that service renames, keeping its group
memberships — and left with no `userconf.txt` it starts an **interactive setup wizard on tty1**,
which is useless on a device with no screen.

### The ssh password

**By default an image carries no usable password, and each device makes its own on first boot.**
One image is flashed onto many cards and, from CI, published for anyone to download, so a
password chosen at build time would be shared by every box made from it, and printed wherever the
build ran.

- The builder gives `userconf.txt` the hash of a throwaway random password that is never
  recorded, so nothing in the image can log in. It also leaves
  `/etc/bloopbox/ssh-password.pending`, naming the login user.
- On first boot `bloopbox-ssh-password.service` runs `deploy/ssh-password.sh` as root, after
  `userconfig.service` has renamed the account and **before sshd starts**. It generates 14
  characters from `/dev/urandom`, writes them to `/data/ssh-password` (`0640 root:bloopbox`), applies
  them with `chpasswd`, and only then deletes the marker. A power cut part-way leaves the marker,
  and the next boot starts again, so the record and the account cannot disagree.
- The admin panel shows it under **Advanced → Device health → SSH access**, behind the parent's
  admin password, fetched only when asked for (`GET /api/system/ssh`, `Cache-Control: no-store`).
- Parents never need it. Setup is still flash, boot, onboard.

**`--password PASS` still works**, and is the way to debug a device before its admin panel is
reachable — the hotspot, a portal that never loads. The image then carries that password's hash
and writes no marker, so the first-boot service does nothing; the panel says the password was set
when the card was built. That hash is readable by anyone holding the image, so use a strong
password and do not publish such an image.

A **tarball install never gets a marker**, so its existing login is never touched.

The `.credentials.txt` beside the image records either the explicit password or "generated on the
device". The builder never prints the password, because it runs in CI, where the job log is as
readable as the repository.

### The two files a parent can touch

The boot partition is FAT32, so any Windows or macOS laptop can read and write it:

- `bloopbox-wifi.txt` — `ssid=` / `psk=` / `country=`. Applied on the next boot and then
  **deleted**, so the passphrase does not sit in clear text on a partition every computer can
  read. This is also the way back in when the device is offline and the admin panel is
  therefore unreachable: write the file, reboot.
- `bloopbox-README.txt` — the addresses and commands, for whoever finds the card in a
  drawer in two years.

## Wi-Fi at runtime

[`deploy/wifi-apply.sh`](../box/software/deploy/wifi-apply.sh) is the only thing that turns Wi-Fi settings
into an actual network connection. It runs from two places:

- `bloopbox-firstboot.service`, on every boot
- `ExecStartPre` of the hardware unit — so saving Wi-Fi in the admin panel takes effect on the
  restart that saving already triggers (config is read at boot; there is no live-reload path)

The boot-partition file wins over `config.json` when both are present. The connection is called
`bloopbox` and is given `autoconnect-priority 10`, so anything seeded earlier stays as a
fallback if the new network turns out to be wrong.

Two details that are easy to undo by accident:

- **An open network removes the security setting outright** (`remove 802-11-wireless-security`).
  `wifi-sec.key-mgmt none` looks like "open" but is static WEP to NetworkManager, which then fails
  for want of a key.
- **`nmcli --wait 10 con up`**, never the bare form. This runs inside the hardware unit's
  `ExecStartPre`, and nmcli's default is to wait 90 s for a network that is out of range — 90 s
  of dark buttons at boot and after every settings save. Activation carries on inside
  NetworkManager after nmcli stops waiting.

When no network is reachable the device raises its own **setup hotspot** — `PRODUCT.md` §3 (First
Boot) describes the behaviour. The pieces are NetworkManager's own AP mode (not `hostapd`), an open
network, the root `bloopbox-net.service` below doing the privileged work while the unprivileged
daemon serves `public/portal/`, the two talking through files in `/run`. It has onboarded the
reference board (bench, 2026-09-30).

Editing the file on the boot partition therefore stays the **recovery** path rather than the primary
one: it is what gets you back in when even the hotspot cannot be reached.

## How the device knows whether Wi-Fi is up

The hardware daemon runs as `bloopbox` under `ProtectSystem=strict`; it cannot talk to
NetworkManager and should not be able to. So [`deploy/net-agent.sh`](../box/software/deploy/net-agent.sh) runs
as root from `bloopbox-net.service`, polls `nmcli` every 5 s and publishes one small JSON document:

```
/run/bloopbox-net/net-state.json   root writes, everyone reads   (the agent)
/run/bloopbox/net-request.json     daemon writes, root reads     (the AP work, and power)
```

Two directories, one writer each. That is deliberate: the agent must never end up owning
`/run/bloopbox`, which is the recordings tmpfs the daemon has to be able to write.

The daemon reads it through `src/net/netState.ts` and turns it into the Wi-Fi Error LED pattern.
The rule there is worth knowing before debugging a device that "won't show the error": a missing
file, an unparseable one, a reading older than 30 s, or an agent that found no `nmcli` all mean
**unknown**, and unknown is reported as "not down". Only a fresh reading that explicitly says the
network is gone lights the LEDs. Inventing an outage from missing information would light all
three LEDs on any dev machine and on any device whose agent died.

The daemon asks for things back through `/run/bloopbox/net-request.json`: one JSON object such as
`{"action":"ap-up","id":"…"}`, written by rename so it is never read half-written. The action is
matched against a fixed list before anything runs and no part of the file is ever evaluated as
shell; that allowlist is the whole security model of the boundary. Root opens the file without
following a symlink or blocking, and ignores anything that is not a regular file of at most 4 KiB.

**The agent never deletes the request, and must not try.** Under `ProtectSystem=strict` the
daemon's runtime directory is read-only to `bloopbox-net.service`, so an `rm` there fails silently
and the action would run again on every poll. Instead:

1. every request carries a fresh `id` (`writeAgentRequest` in `src/net/netState.ts`);
2. the agent acts on each id once, recording it in `/run/bloopbox-net/handled-request-id` before
   it acts, so a restart mid-join does not run the join again;
3. it publishes that id as `handledRequestId` in `net-state.json`;
4. the daemon, the file's only writer, deletes the request when it sees its own id come back, and
   leaves a newer request alone.

A request with no id (hand-written) is named by a hash of its content, so it also runs only once.
`scripts/test-net-agent-sandbox.sh` runs the shipped agent under the unit's own sandbox properties,
because no container test has a systemd to apply them.

**The list is wider than networking.** `reboot` and `poweroff` arrive here too, from the admin
panel's *Device health* card via `src/system/power.ts`, because this agent is the only process in
the product running as root and a box with no power button still has to be able to shut down
cleanly. They run `systemctl reboot` / `systemctl poweroff` — never `--force`, because the ordinary
path is what stops the daemons with a SIGTERM, and that is what flushes the activity counters and
finalises anything mid-write. Both are backgrounded behind a two-second pause so the poll finishes
and the admin panel's HTTP response reaches the browser before its network disappears.

The no-`nmcli` branch consumes requests as well, and not incidentally: powering off needs no
NetworkManager, and a box that cannot be shut down from the panel is exactly the box somebody
unplugs mid-write.

`ap-up` creates (or rewrites) the `bloopbox-ap` NetworkManager profile — `mode ap`, band bg, no
passphrase, `ipv4.method shared` — and brings it up. Shared mode is why `dnsmasq-base` is a
runtime package: NM runs its own dnsmasq on that interface for DHCP and DNS. `ap-down` drops it
and immediately tries the real network, because there is one radio and stepping aside is the only
way to attempt a join.

`forget` deletes the `bloopbox` profile, and only a factory reset asks for it. Deleting
`/data/config.json` is not enough on its own to send a device back to onboarding:
`wifi-apply.sh` only ever *writes* that profile, so with no SSID left to apply it exits early and
NetworkManager keeps the old one at `autoconnect yes, priority 10`. The device would come back up
online, and `NetworkSupervisor` only raises the hotspot for a device that is **offline**. It is
scoped to the profile bloopbox manages: a network the imager seeded is left alone, so a device
built with `--wifi-ssid` rejoins after a reset instead of offering a hotspot, and is re-onboarded
over the network it is already on.

When the hotspot goes up is decided in `src/core/networkSupervisor.ts`: 10 s of no network on an
unconfigured device, 3 minutes on a configured one (a flat 30 s would pop a hotspot into the house
every time the router reboots), then every 60 s the hotspot steps aside for a 30 s join attempt —
unless the device was never configured, in which case there is nothing to rejoin and it stays up.

The reading also carries **`timeSynced`**, which has nothing to do with Wi-Fi and is here because
the agent is the only process that can ask `timedatectl show -p NTPSynchronized` (it goes over D-Bus
to `systemd-timedated`, refreshed every 30 s rather than every poll). A Pi has no real-time clock, so
until NTP answers it runs on the time its last shutdown saved. It is `true`, `false`, or `null` for
"cannot tell" — no `timedatectl`, or no clear answer — and `netState.ts` keeps it that way, reading
anything malformed as `null` and never as `false`. The health card shows it; nothing acts on it yet
(`PENDING.md`).

`sudo bloopbox-doctor` checks the file exists, is fresh, and is readable by the service user, and
that `nmcli` and dnsmasq are installed. It also fails if no time-sync service is active (Pi OS ships
`systemd-timesyncd`) and warns while the clock is not yet synced.

## When something is wrong

**The journal lives in RAM, on purpose.** `install.sh` pins it with
`/etc/systemd/journald.conf.d/50-bloopbox.conf` (`Storage=volatile`, `RuntimeMaxUse=8M` — small
because `/run` is one tmpfs and the recordings live there too) rather than trusting whatever the OS
image defaults to: plain Debian's `auto` turns persistent the moment `/var/log/journal` exists, and
this is an SD card. Pi OS's own `40-rpi-volatile-storage.conf` sorts before it, so ours applies.
Debug mode's drop-in is `90-bloopbox-debug.conf`, so it sorts after `50-` and its
`Storage=persistent` wins while it exists; removing it (`off --purge`) is the whole of "back to
RAM". Neither file ever edits the other. (`install.sh` renames a leftover `10-bloopbox-debug.conf`
from older releases, which would otherwise lose to `50-`.)

`sudo bloopbox-debug on` makes the journal survive reboots (normally it is in RAM, as above,
which loses exactly the logs that explain a restart), raises both daemons to debug level, and
starts a 10 s sampler writing `/var/log/bloopbox/trace.jsonl`. It expires after 24 h on its own.
Then `sudo bloopbox-diagnostics` bundles all of it — journals, trace, every `nmcli` view, the
hardware inventory and a **redacted** config — into one tarball to send somewhere.
[`hardware-bringup.md`](./hardware-bringup.md) has the details.

## The systemd units

| Unit                       | Runs                                                                        |
| -------------------------- | --------------------------------------------------------------------------- |
| `bloopbox-hardware`        | GPIO, LEDs, audio, API, admin UI and captive portal                         |
| `bloopbox-whatsapp`        | The Baileys bridge                                                          |
| `bloopbox-net`             | The root network agent: publishes Wi-Fi state, runs the AP and power requests |
| `bloopbox-firstboot`       | Wi-Fi provisioning from the boot partition, oneshot, every boot             |
| `bloopbox-audio-init`      | Codec routing from the environment's `ALSA_*` settings, oneshot, before the daemon |
| `bloopbox-ssh-password`    | The per-device ssh password, oneshot, only while the image's marker exists  |
| `bloopbox-debug-sampler`   | Debug mode's sampler. Installed, never enabled — `bloopbox-debug on` starts it |

```bash
journalctl -u bloopbox-hardware -u bloopbox-whatsapp -u bloopbox-net -f
systemctl restart bloopbox-hardware
```

Decisions worth knowing:

- **`Restart=always` is load-bearing.** Saving a setting makes the hardware server exit 0 on
  purpose so the new config is read at startup. Without `Restart=always` a settings save would
  simply switch the device off.
- **No start limit, and a backed-off restart instead.** systemd's default gives up after 5 starts
  in 10 s and counts a deliberate exit-on-save exactly like a crash, so a few quick saves could
  leave the hardware unit `failed` until a power cycle. All three long-running units set
  `StartLimitIntervalSec=0` and grow the delay with `RestartSteps=` / `RestartMaxDelaySec=`
  (systemd 254+; Trixie ships 257). The caps differ on purpose: **5 s for the hardware unit**,
  because systemd's restart counter never resets while the unit keeps coming back — only at boot or
  on `reset-failed` — so the cap is what every settings save costs once a boot has seen five; a
  minute for the bridge, which no save restarts; 15 s for the net agent, under the daemon's 30 s
  staleness limit.
- **Memory caps, and the bridge dies first.** `MemoryHigh` / `MemoryMax` plus
  `--max-old-space-size` on both daemons, because a Zero 2 W has 512 MB. They are tunables, not
  measurements, enforced only once the `cmdline.txt` step has enabled the memory controller — and
  the `MemoryMax` caps (192 M, 288 M, and 48 M each for the agent and the sampler) add up to more
  than the board has, so a real out-of-memory is possible below all of them. `OOMScoreAdjust` is
  `-500` on the hardware unit and `+300` on the bridge: the process the box survives losing is the
  one that reconnects.
- **Recordings go in `/run/bloopbox`**, via `RuntimeDirectory=` in both units. `/run` is
  already a tmpfs, so outbound audio lives in RAM with no mount unit and no fstab entry, and cannot
  survive a power cut or fill the card. `RuntimeDirectoryPreserve=yes` keeps it across the
  restart-on-save; both units declare the same directory because they hand each other file
  paths. `PrivateTmp` is off for the same reason. Inbound notes are on the card instead
  (`/data/notes`, `PRODUCT.md` §8), which `ReadWritePaths=/data` already allows.
- **The bridge has its own scratch directory**, `/run/bloopbox-tmp`, with `TMPDIR` pointed at it.
  Baileys writes media scratch through `os.tmpdir()` on every send, `/tmp` is read-only under
  `ProtectSystem=strict`, and the failure arrives as an unhandled stream error that kills the
  process. It is deliberately not `/run/bloopbox`, where recovery would take it for a note.
- **The hardware unit holds `CAP_NET_BIND_SERVICE` and nothing else**, for the captive portal on
  :80 — a phone's connectivity probe asks nowhere else.
- **The bridge is deliberately not `BindsTo` the hardware unit.** WhatsApp is an unofficial API
  on a release candidate; a crash there must not take the buttons and lights with it.
- **`bloopbox-audio-init` is not a `Requires=` of the hardware unit.** A failed routing step shows
  in `systemctl status` and `bloopbox-doctor`; a box that still records and blinks is more
  recoverable than one that refuses to boot.
- **The hardening block** (`ProtectSystem=strict`, `ReadWritePaths=/data`, `ProtectHome`,
  `NoNewPrivileges`, …) has run on the reference board with the GPIO and ALSA paths working. On a
  new board that hits an unexplained `EACCES`, it is still the first thing to comment out to rule
  it in or out.

## Writing the shell scripts

A third of the box is bash, and two traps have each broken more than one script:

- **Never `cmd | grep -q`** in a script with `pipefail` on. `grep -q` exits at the first match, the
  producer takes a SIGPIPE, and `pipefail` reports a passing check as failed (or, under `!`, the
  reverse). Capture the output and match it with `case` or `[[ =~ ]]`.
  `src/tests/shellScripts.test.ts` fails on the pattern. `doctor.sh` and `wifi-apply.sh` leave
  `pipefail` off on purpose so they can keep the idiom.
- **Never expand a possibly empty array as `"${arr[@]}"`.** Every script runs `set -u`, and on
  bash 3.2, which is what macOS ships as `/bin/bash` and where the release scripts also run, that
  is an unbound-variable error when the array is empty. Use an unquoted `${VAR:-}` where word
  splitting is wanted, with `# shellcheck disable=SC2086` and a comment saying why.

## CI

None of this has run on GitHub yet: the repository has no remote. What the workflows are written
to do:

- [`ci.yml`](../.github/workflows/ci.yml) — on a push to `main`, every pull request, and when
  `release.yml` calls it. A cheap `changes` job decides what was touched and gates the rest: the
  **box gate** (`npm audit` over production dependencies at high, `sounds`, `doctor`, `check`); the
  **box package** (the arm64 tarball, `release:smoke`, the onboarding test — packaging breaks
  quietly, so it runs on the same cadence as the tests); the **net agent under its sandbox**
  ([`test-net-agent-sandbox.sh`](../box/software/scripts/test-net-agent-sandbox.sh), since no
  container test has a systemd to apply `ProtectSystem=strict`); **ShellCheck** over every tracked
  shell script; the **website** gate; and the **docs links** check. The single required status
  check is the aggregating `ci` job, because a filtered-out job reports as skipped, which branch
  protection accepts. When the filter cannot run (a tag, a manual run, a call from `release.yml`)
  everything runs.
- [`release.yml`](../.github/workflows/release.yml) — on a `v*` tag: the gate (`ci.yml` with
  `gate_only`, which also stops it filtering), then the tarball and its smoke test, then the SD
  image, then a GitHub release with the tarball, the image and their checksums. Deliberately not
  path-filtered: a tag rebuilds everything.

**The CI image is built for the default board.** Its build step passes no `--audio-hat`, so it is
a USB-audio image named `bloopbox-<version>-sd.img.xz`, not one for the WM8960 reference board.
Until that changes, build a wm8960 card locally.

**Both workflows run with `permissions: contents: read`**, and only the job that publishes a
release asks for `contents: write`. **Every action is pinned to a commit**, with its tag in a
comment: a tag can be moved by whoever controls the action's repository, and the steps run with the
job's token. [`dependabot.yml`](../.github/dependabot.yml) proposes the bumps weekly, grouped, for
the actions and both lockfiles; Baileys is excluded, because it is pinned to an exact release
candidate on purpose.

GitHub's hosted runners are x86, so the arm64 build runs under emulation. Swapping `runs-on` for
an arm64 runner makes it several times faster and needs no other change.

Optional repository secrets for the image job: `WIFI_COUNTRY` and `IMAGE_PASSWORD`. Without
`IMAGE_PASSWORD` every device makes its own ssh password on first boot ([above](#the-ssh-password));
with it, every card flashed from that release shares one, which is only for debugging.

**CI images carry no Wi-Fi network.** They are published, and a passphrase baked into one is
readable by anyone who downloads it, so the build step takes no `--wifi-ssid` / `--wifi-psk`, and a
`WIFI_PSK` secret fails the job rather than being silently ignored. A parent fills in
`bloopbox-wifi.txt` or joins through the hotspot; bake a network into a local build instead.

**CI uploads no credentials artifact.** On a public repository every signed-in GitHub user can
download a workflow's artifacts, so an "unpublished" artifact was never private. The release
assets are an explicit list rather than a glob, so a local `credentials.txt` cannot slip into
a download either.

## What none of this proves

The tarball builds, installs and boots on arm64 Trixie in a container, and a card flashed from a
local `--audio-hat wm8960` image has run the reference board (a Pi 3B+ with the WM8960 HAT) end to
end: its ssh password made on first boot, onboarding through the hotspot, WhatsApp linked, all
three buttons and lamps, audio both ways, and the restart policy, OOM scores and journal drop-ins
as written above (bench, 2026-09-30).

What has **not** happened is any of it on the Pi Zero 2 W the product targets, or any of the CI
above on a real runner. See `PENDING.md`.
