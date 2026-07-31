# Deployment

How the code gets onto a Raspberry Pi. Two routes: a **release tarball** you install over ssh,
or a **flashable SD card image** with everything already in place.

Both are produced by Docker on a dev machine or by CI, and the Pi compiles nothing.

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

Everything pinned — base images, the Pi OS image and its checksum, apt package lists — lives in
[`packaging/versions.env`](../packaging/versions.env).

## Building a release

```bash
npm run release            # -> release/kids-messenger-<version>-linux-arm64.tar.gz
npm run release:smoke      # boot it in a bare arm64 Debian Trixie container
```

The tarball (~58 MB, ~190 MB unpacked) carries:

| Contents                         | Why it is in there                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/`                          | Compiled server, both UIs, and the generated cue WAVs                                                                                   |
| `node_modules/`                  | Built **for arm64**, including the compiled `opengpio` addon and sharp's prebuilt libvips. A macOS `npm ci` tree is the wrong platform. |
| `node/bin/node`                  | The runtime, lifted out of the build image so the native addon's ABI and the runtime that loads it cannot disagree                      |
| `package.json`                   | Not optional: without `"type": "module"` beside `dist/`, node rejects every import in it                                                |
| `config.default.json`            | What the daemon falls back to, resolved relative to `dist/`                                                                             |
| `install.sh`, `doctor.sh`, units | Everything below                                                                                                                        |

On an Apple Silicon or arm64 Linux host this is a native build. On x86 it runs under QEMU —
correct but slow — and needs `docker run --privileged --rm tonistiigi/binfmt --install arm64`
once.

The build fails loudly if `opengpio` did not compile. `opengpio` is an `optionalDependency`, so
npm shrugs off a failed build, and a release that shipped without it would install fine and
produce a device with three dead buttons.

## Installing on a Pi

```bash
scp release/kids-messenger-0.1.0-linux-arm64.tar.gz pi@kids-messenger.local:
ssh pi@kids-messenger.local
tar xzf kids-messenger-0.1.0-linux-arm64.tar.gz
sudo ./kids-messenger-0.1.0-linux-arm64/install.sh
```

What it does:

- `apt-get install ffmpeg alsa-utils libgpiod3` — the only three things npm cannot supply
- creates the `kidsmsg` system user, in the `gpio` and `audio` groups
- creates `/data` (settings, WhatsApp credentials) owned by that user
- installs the app to `/opt/kids-messenger`, staged and swapped so a failed copy cannot leave
  half an application behind
- writes `/etc/kids-messenger/environment` with a **generated** `BRIDGE_TOKEN`
- installs and enables both systemd units
- appends a marked block to `/boot/firmware/config.txt`: the GPIO pull-ups and the watchdog
- restarts the services

Re-running it is an upgrade: `/data` and the environment file are left alone, so the parent's
settings and the WhatsApp pairing survive.

Useful flags: `--skip-deps`, `--no-boot-config`, `--no-watchdog`, `--no-start`, `--simulator`
(runs the browser simulator HAL on a box with no buttons), `--prefix`, `--data-dir`, `--user`.

Then check it:

```bash
sudo kids-messenger-doctor
```

That is the bash counterpart to `npm run doctor` — the tsx version cannot run on the device,
which has no devDependencies. It checks the runtime, the addon, ffmpeg's Opus encoder, the ALSA
devices, the firmware pull-ups, `/data`, the tmpfs, the cue files and both services.

## Building a ready-to-run SD card

```bash
sudo ./scripts/build-sd-image.sh --wifi-ssid Home --wifi-psk secret --wifi-country DE
# -> release/kids-messenger-<version>-<pi-os-date>-sd.img.xz  (~660 MB)
```

Flash it with Raspberry Pi Imager (**Use custom**) or `dd`, put the card in, power up. No ssh
step, no install step. The card carries the daemons enabled, ffmpeg and libgpiod, the firmware
pull-ups, ssh on, a login user, and optionally your Wi-Fi.

It needs Linux and root — it attaches the image to loop devices and chroots into it. On macOS,
use CI or a privileged container:

```bash
docker run --rm --privileged --platform linux/arm64 -v "$PWD":/repo -w /repo \
  debian:trixie-slim bash -c 'apt-get update -qq && apt-get install -y --no-install-recommends \
    curl xz-utils parted e2fsprogs dosfstools openssl ca-certificates zerofree && \
    ./scripts/build-sd-image.sh --work-dir /work'
```

Options: `--hostname`, `--user`, `--password` (generated and written to a `.credentials.txt`
beside the image if omitted), `--wifi-ssid` / `--wifi-psk` / `--wifi-country`, `--no-ssh`,
`--keep-img`, `--artifact`, `--output`, `--work-dir`.

### What the builder does to the stock image

1. Downloads the pinned Pi OS Lite arm64 image and **verifies its checksum**.
2. Grows the file and the root partition by 1792 MB — Lite has nowhere near enough free space
   for the bundled runtime plus ffmpeg. First boot still expands the partition to fill the real
   card: the `resize` token in `cmdline.txt` is untouched and the root partition stays last.
3. Attaches each partition as its own loop device, using offsets from the partition table
   rather than `losetup --partscan`, which needs a udev that no container has.
4. `apt-get install`s the runtime packages inside the image, then runs the same `install.sh`
   the ssh route uses, with `--no-start`: units are enabled offline and come up on first boot.
5. Seeds the device: hostname, `userconf.txt`, the `ssh` marker, a NetworkManager keyfile for
   Wi-Fi, and two plain-text files on the boot partition (below).
6. Zeroes the free blocks and compresses.

The login user is handed to Pi OS's own `userconfig.service` through `userconf.txt` rather than
created by hand. The image ships a `pi` user which that service renames, keeping its group
memberships — and left with no `userconf.txt` it starts an **interactive setup wizard on tty1**,
which is useless on a device with no screen.

### The two files a parent can touch

The boot partition is FAT32, so any Windows or macOS laptop can read and write it:

- `kids-messenger-wifi.txt` — `ssid=` / `psk=` / `country=`. Applied on the next boot and then
  **deleted**, so the passphrase does not sit in clear text on a partition every computer can
  read. This is also the way back in when the device is offline and the admin panel is
  therefore unreachable: write the file, reboot.
- `kids-messenger-README.txt` — the addresses and commands, for whoever finds the card in a
  drawer in two years.

## Wi-Fi at runtime

[`deploy/wifi-apply.sh`](../deploy/wifi-apply.sh) is the only thing that turns Wi-Fi settings
into an actual network connection. It runs from two places:

- `kids-messenger-firstboot.service`, on every boot
- `ExecStartPre` of the hardware unit — so saving Wi-Fi in the admin panel takes effect on the
  restart that saving already triggers (config is read at boot; there is no live-reload path)

The boot-partition file wins over `config.json` when both are present. The connection is called
`kids-messenger` and is given `autoconnect-priority 10`, so anything seeded earlier stays as a
fallback if the new network turns out to be wrong.

There is still **no AP / captive-portal fallback** — `PRODUCT.md` §First Boot describes one and
it is not built. Editing the file on the boot partition is the recovery path today. See
`PENDING.md`.

## The systemd units

| Unit                       | Runs                             |
| -------------------------- | -------------------------------- |
| `kids-messenger-hardware`  | GPIO, LEDs, audio, API, admin UI |
| `kids-messenger-whatsapp`  | The Baileys bridge               |
| `kids-messenger-firstboot` | Wi-Fi provisioning, oneshot      |

```bash
journalctl -u kids-messenger-hardware -u kids-messenger-whatsapp -f
systemctl restart kids-messenger-hardware
```

Decisions worth knowing:

- **`Restart=always` is load-bearing.** Saving a setting makes the hardware server exit 0 on
  purpose so the new config is read at startup. Without `Restart=always` a settings save would
  simply switch the device off.
- **Recordings go in `/run/kids-messenger`**, via `RuntimeDirectory=` in both units. `/run` is
  already a tmpfs, so audio lives in RAM with no mount unit and no fstab entry, and cannot
  survive a power cut or fill the card. `RuntimeDirectoryPreserve=yes` keeps it across the
  restart-on-save; both units declare the same directory because they hand each other file
  paths. `PrivateTmp` is off for the same reason.
- **The bridge is deliberately not `BindsTo` the hardware unit.** WhatsApp is an unofficial API
  on a release candidate; a crash there must not take the buttons and lights with it.
- **Memory caps are set** (`MemoryHigh` / `MemoryMax`, plus `--max-old-space-size`) because a Pi
  Zero 2 W has 512 MB for both processes. They are tunables, not measurements.
- **The hardening block** (`ProtectSystem=strict`, `ReadWritePaths=/data`, …) is the first thing
  to comment out if bring-up hits an unexplained `EACCES` — the GPIO and ALSA paths have never
  run on real hardware.

## CI

- [`ci.yml`](../.github/workflows/ci.yml) — on every push and PR: `npm run check`, plus building
  the arm64 tarball and smoke-testing it. Packaging breaks quietly (a missing runtime package, a
  path that only resolves in the source tree), so it is checked on the same cadence as the tests.
- [`release.yml`](../.github/workflows/release.yml) — on a `v*` tag: the gate, then the tarball,
  then the SD image, then a GitHub release with the tarball, the image and their checksums.

GitHub's hosted runners are x86, so the arm64 build runs under emulation. Swapping `runs-on` for
an arm64 runner makes it several times faster and needs no other change.

Optional repository secrets for the image job: `WIFI_SSID`, `WIFI_PSK`, `WIFI_COUNTRY`,
`IMAGE_PASSWORD`. Without them the image still boots — it ships the fillable
`kids-messenger-wifi.txt` and a generated ssh password.

**The generated ssh password is never attached to a release.** It goes to the private
`sd-card-credentials` build artifact; the release assets are an explicit list, not a glob, so a
`credentials.txt` cannot slip into a public download.

## What none of this proves

Everything above has been exercised: the tarball builds, installs and boots on arm64 Trixie, and
the image has been mounted back and booted from inside. What has **not** happened is any of it
running on a Raspberry Pi with buttons attached. Pin numbers, ULN2003 polarity and ALSA device
names remain unverified, `arecord`/`aplay`/`amixer` have never been called against real
hardware, and no WhatsApp account has been paired. See `PENDING.md`.
