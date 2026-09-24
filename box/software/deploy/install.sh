#!/usr/bin/env bash
#
# Installs bloopbox on a Raspberry Pi. Run from inside an unpacked release tarball:
#
#   tar xzf bloopbox-0.1.0-linux-arm64.tar.gz
#   sudo ./bloopbox-0.1.0-linux-arm64/install.sh
#
# Safe to re-run: an upgrade swaps the application directory and leaves /data (config,
# WhatsApp credentials) and /etc/bloopbox/environment (the bridge token) untouched.
#
# scripts/build-sd-image.sh runs this same script inside a mounted Pi OS root, which is
# why every step either works offline or is skippable, and why services are enabled but
# not started when no systemd is running.
set -euo pipefail

PREFIX=/opt/bloopbox
DATA_DIR=/data
SERVICE_USER=bloopbox
ETC_DIR=/etc/bloopbox
BOOT_DIR=
SKIP_DEPS=false
NO_START=false
NO_BOOT_CONFIG=false
NO_WATCHDOG=false
SIMULATOR=false
FORCE=false
AUDIO_HAT=usb
NO_LEDS=false
PROFILE_FILE="${ETC_DIR}/profile"
# Whether the two above came from the command line rather than from these defaults. The
# resolution step below turns on that difference: an absent flag has to mean "whatever this
# box already is", never "usb".
AUDIO_HAT_GIVEN=false
NO_LEDS_GIVEN=false

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Installs bloopbox and its systemd services.

Usage: sudo ./install.sh [options]

Options:
  --prefix DIR       Application directory (default: /opt/bloopbox)
  --data-dir DIR     Writable volume for config.json and WhatsApp auth (default: /data)
  --user NAME        System user the daemons run as (default: bloopbox)
  --boot-dir DIR     Firmware config location (default: autodetected /boot/firmware)
  --skip-deps        Do not apt-get install ffmpeg / alsa-utils / libgpiod3 / dnsmasq-base
  --no-boot-config   Do not touch config.txt (skips the GPIO pull-ups the buttons need)
  --no-watchdog      Do not enable the hardware watchdog
  --no-start         Install and enable, but do not start the services
  --simulator        Run the browser simulator HAL instead of real GPIO (for a test box)
  --audio-hat NAME   Audio hardware: usb or wm8960 for the WM8960 codec HAT
  --no-leds          No lamps are wired — claim no LED lines at all
  --force            Continue even if the architecture or OS looks wrong, or to change
                     the recorded audio profile to one the box contradicts
  -h, --help         This message

The MVP board (Pi 3B+ + WM8960 HAT, the HAT's own button as button 1, no lamps) is:

  sudo ./install.sh --audio-hat wm8960 --no-leds

Both of those are remembered in /etc/bloopbox/profile, so an upgrade needs neither flag
again. Passing one changes what this box is recorded as; passing nothing keeps it.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --boot-dir) BOOT_DIR="$2"; shift 2 ;;
    --skip-deps) SKIP_DEPS=true; shift ;;
    --no-boot-config) NO_BOOT_CONFIG=true; shift ;;
    --no-watchdog) NO_WATCHDOG=true; shift ;;
    --no-start) NO_START=true; shift ;;
    --simulator) SIMULATOR=true; shift ;;
    --audio-hat) AUDIO_HAT="$2"; AUDIO_HAT_GIVEN=true; shift 2 ;;
    --no-leds) NO_LEDS=true; NO_LEDS_GIVEN=true; shift ;;
    --force) FORCE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "${AUDIO_HAT}" in
  usb|wm8960) ;;
  *) echo "unknown --audio-hat: ${AUDIO_HAT} (expected usb or wm8960)" >&2; exit 2 ;;
esac

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "run this with sudo"

# Three cases, and all of them happen:
#   - a running Pi:        enable and start normally
#   - a mounted Pi OS root (scripts/build-sd-image.sh): systemctl exists and enables units
#     offline, but there is no systemd to talk to, so nothing starts
#   - a plain container (scripts/smoke-test-release.sh): no systemctl at all
SYSTEMD_RUNNING=true
[[ -d /run/systemd/system ]] || SYSTEMD_RUNNING=false
HAS_SYSTEMCTL=true
command -v systemctl >/dev/null 2>&1 || { HAS_SYSTEMCTL=false; SYSTEMD_RUNNING=false; }

# --------------------------------------------------------------------------------------
step "resolving the hardware profile"
# What this box IS has to outlive the command line that first said so.
#
# Before this file existed, --audio-hat and --no-leds were remembered only in
# ${ETC_DIR}/environment, which is written once and never rewritten — while the config.txt
# block those same flags drive is deleted and regenerated on EVERY run. So an upgrade run
# without the flags left the environment pointing at a codec whose overlay it had just
# removed. The box booted, joined Wi-Fi, connected to WhatsApp, reported READY, and made no
# sound at all. That is what this step exists to make impossible. See PENDING.md.
#
#   explicit flag  >  recorded profile  >  inferred from an existing environment  >  usb

RECORDED_AUDIO_HAT=
RECORDED_NO_LEDS=
if [[ -f "${PROFILE_FILE}" ]]; then
  # Matched out, never sourced. We write this file, but `.`-ing anything that lives in the
  # one directory an operator hand-edits buys nothing and costs a shell-injection foot-gun.
  RECORDED_AUDIO_HAT="$(sed -n 's/^AUDIO_HAT=\([A-Za-z0-9_-]\{1,\}\)$/\1/p' "${PROFILE_FILE}" | tail -1)"
  RECORDED_NO_LEDS="$(sed -n 's/^NO_LEDS=\([a-z]\{1,\}\)$/\1/p' "${PROFILE_FILE}" | tail -1)"
  # `\|` alternation is a GNU sed extension that silently matches nothing on BSD sed, so the
  # value is captured loosely and checked here instead.
  [[ "${RECORDED_NO_LEDS}" == true || "${RECORDED_NO_LEDS}" == false ]] || RECORDED_NO_LEDS=
fi

# A box installed before the profile file existed still describes its own hardware, in the
# environment file. Read the profile back out of that rather than defaulting to usb and
# rewriting config.txt underneath it — every device in the field today is in this case, so
# without it the bug above gets one more chance to happen to each of them.
INFERRED_AUDIO_HAT=
INFERRED_NO_LEDS=
if [[ -f "${ETC_DIR}/environment" ]]; then
  if [[ -z "${RECORDED_AUDIO_HAT}" ]] \
     && grep -q '^ALSA_PLAYBACK_DEVICE=.*wm8960soundcard' "${ETC_DIR}/environment"; then
    INFERRED_AUDIO_HAT=wm8960
  fi
  if [[ -z "${RECORDED_NO_LEDS}" ]] && grep -q '^LED_PINS=$' "${ETC_DIR}/environment"; then
    INFERRED_NO_LEDS=true
  fi
fi

AUDIO_HAT_SOURCE='the default'
if [[ "${AUDIO_HAT_GIVEN}" == true ]]; then
  AUDIO_HAT_SOURCE='--audio-hat'
elif [[ -n "${RECORDED_AUDIO_HAT}" ]]; then
  AUDIO_HAT="${RECORDED_AUDIO_HAT}"; AUDIO_HAT_SOURCE="${PROFILE_FILE}"
elif [[ -n "${INFERRED_AUDIO_HAT}" ]]; then
  AUDIO_HAT="${INFERRED_AUDIO_HAT}"; AUDIO_HAT_SOURCE="${ETC_DIR}/environment"
fi

NO_LEDS_SOURCE='the default'
if [[ "${NO_LEDS_GIVEN}" == true ]]; then
  NO_LEDS_SOURCE='--no-leds'
elif [[ -n "${RECORDED_NO_LEDS}" ]]; then
  NO_LEDS="${RECORDED_NO_LEDS}"; NO_LEDS_SOURCE="${PROFILE_FILE}"
elif [[ -n "${INFERRED_NO_LEDS}" ]]; then
  NO_LEDS="${INFERRED_NO_LEDS}"; NO_LEDS_SOURCE="${ETC_DIR}/environment"
fi

# The recorded value gets the same validation the flag does — a hand-mangled profile file
# must not reach the config.txt writer.
case "${AUDIO_HAT}" in
  usb|wm8960) ;;
  *) die "unknown audio profile '${AUDIO_HAT}' from ${AUDIO_HAT_SOURCE} (expected usb or wm8960)" ;;
esac

info "audio: ${AUDIO_HAT} (from ${AUDIO_HAT_SOURCE})"
info "lamps: $([[ "${NO_LEDS}" == true ]] && echo 'none wired' || echo 'wired') (from ${NO_LEDS_SOURCE})"

# Refuse the silent downgrade. Everything above makes the right thing happen when nobody
# passes a flag; this catches the case where someone passes the wrong one, or where a
# profile file was removed but the box is still plainly a wm8960 build.
if [[ "${AUDIO_HAT}" == usb ]]; then
  DOWNGRADE_EVIDENCE=
  if [[ "${RECORDED_AUDIO_HAT}" == wm8960 ]]; then
    DOWNGRADE_EVIDENCE="${PROFILE_FILE} records AUDIO_HAT=wm8960"
  elif [[ -f "${ETC_DIR}/environment" ]] \
       && grep -q 'wm8960soundcard' "${ETC_DIR}/environment"; then
    DOWNGRADE_EVIDENCE="${ETC_DIR}/environment points the daemon at wm8960soundcard"
  fi
  if [[ -n "${DOWNGRADE_EVIDENCE}" ]]; then
    if [[ "${FORCE}" == true ]]; then
      warn "--force: recording a usb profile on what looks like a wm8960 box"
      warn "${DOWNGRADE_EVIDENCE}"
    else
      warn "${DOWNGRADE_EVIDENCE}"
      warn "writing a usb profile here would regenerate config.txt without the codec overlay,"
      warn "and the box would boot silent with every other indicator healthy. That is exactly"
      warn "how the 2026-09-07 upgrade broke this device."
      die "refusing to change the audio profile to usb. Re-run with --audio-hat wm8960, or --force if the HAT really has been removed."
    fi
  fi
fi

step "checking the target"
if [[ -f "${SOURCE_DIR}/release.env" ]]; then
  # shellcheck disable=SC1091
  source "${SOURCE_DIR}/release.env"
  info "release ${APP_VERSION:-?} (${GIT_SHA:-?}) built ${BUILD_DATE:-?}"
  info "bundled node ${NODE_VERSION:-?} for ${TARGET_ARCH:-?}"
else
  warn "no release.env — is this an unpacked release tarball?"
fi

for required in dist/processes/hardware-server.js dist/processes/whatsapp-bridge.js \
                dist/public/admin/index.html config.default.json package.json node/bin/node; do
  [[ -e "${SOURCE_DIR}/${required}" ]] || die "incomplete release: ${required} is missing"
done

HOST_ARCH="$(uname -m)"
if [[ "${HOST_ARCH}" != "aarch64" && "${HOST_ARCH}" != "arm64" ]]; then
  if [[ "${FORCE}" == true ]]; then
    warn "architecture is ${HOST_ARCH}, not aarch64 — continuing because --force"
  else
    die "this release is arm64 and this machine is ${HOST_ARCH} (use --force to override)"
  fi
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  VERSION_CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-unknown}")"
  info "os ${VERSION_CODENAME}"
  if [[ "${VERSION_CODENAME}" != "trixie" && "${FORCE}" != true ]]; then
    warn "expected Raspberry Pi OS trixie; opengpio needs libgpiod v2 (libgpiod3) and"
    warn "older releases ship libgpiod 1.x, where the GPIO driver cannot load"
  fi
fi

if ! "${SOURCE_DIR}/node/bin/node" --version >/dev/null 2>&1; then
  die "the bundled node runtime does not run here — wrong architecture, or a libc older than the build image (${NODE_IMAGE:-?})"
fi

step "installing runtime dependencies"
if [[ "${SKIP_DEPS}" == true ]]; then
  info "skipped (--skip-deps)"
else
  # ffmpeg: the Opus pipeline. alsa-utils: arecord/aplay/amixer. libgpiod3: what the
  # opengpio addon links against. dnsmasq-base: DHCP and DNS for the setup hotspot, via
  # NetworkManager's shared mode. Nothing here compiles.
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends ffmpeg alsa-utils libgpiod3 dnsmasq-base
  if [[ "${AUDIO_HAT}" == wm8960 ]]; then
    # i2c-tools only: `i2cdetect -y 1` answering at 0x1a is the one check that separates
    # "the HAT is not seated" from "the overlay did not load".
    apt-get install -y --no-install-recommends i2c-tools
  fi
  info "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
fi

step "creating the ${SERVICE_USER} user"
if ! getent group "${SERVICE_USER}" >/dev/null; then
  groupadd --system "${SERVICE_USER}"
fi
if ! getent passwd "${SERVICE_USER}" >/dev/null; then
  useradd --system --gid "${SERVICE_USER}" --no-create-home \
          --home-dir /nonexistent --shell /usr/sbin/nologin \
          --comment "bloopbox" "${SERVICE_USER}"
  info "created"
else
  info "already exists"
fi

# The units list these as SupplementaryGroups and refuse to start if a group is missing.
# Raspberry Pi OS ships both; a plain Debian box may not have gpio.
for group in gpio audio; do
  getent group "${group}" >/dev/null || { groupadd --system "${group}"; info "created group ${group}"; }
  usermod --append --groups "${group}" "${SERVICE_USER}"
done
info "groups: $(id -nG "${SERVICE_USER}")"

step "preparing ${DATA_DIR}"
# The one persistent, writable location: config.json plus the WhatsApp credentials. Kept
# across upgrades and never shipped in an image.
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${DATA_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0700 "${DATA_DIR}/auth_info"
info "$(stat -c '%A %U:%G %n' "${DATA_DIR}")"

if [[ "${SYSTEMD_RUNNING}" == true ]]; then
  step "stopping the running services"
  # Before the directory swap, not after: node resolves some imports lazily (the GPIO
  # driver, socket.io transports), and pulling node_modules out from under a live process
  # crashes it in a way that looks like a bug in the new version. The net agent is stopped
  # for a blunter reason — bash reads a script as it runs it, so swapping the directory
  # under net-agent.sh feeds it garbage.
  for unit in bloopbox-hardware bloopbox-whatsapp bloopbox-net; do
    if systemctl is-active --quiet "${unit}.service" 2>/dev/null; then
      systemctl stop "${unit}.service"
      info "${unit}: stopped"
    fi
  done
fi

step "installing the application into ${PREFIX}"
# Staged then swapped, so a failed copy cannot leave a half-written application behind.
STAGING="${PREFIX}.new"
rm -rf "${STAGING}"
install -d -m 0755 "${STAGING}"
for item in dist node_modules node package.json package-lock.json config.default.json release.env; do
  [[ -e "${SOURCE_DIR}/${item}" ]] && cp -a "${SOURCE_DIR}/${item}" "${STAGING}/"
done
# Keep the operational scripts beside the app so doctor / uninstall stay available once
# the tarball is gone.
install -d -m 0755 "${STAGING}/deploy"
cp -a "${SOURCE_DIR}"/*.sh "${STAGING}/deploy/"
cp -a "${SOURCE_DIR}/systemd" "${STAGING}/deploy/"
chown -R root:root "${STAGING}"
chmod 0755 "${STAGING}/node/bin/node"

if [[ -d "${PREFIX}" ]]; then
  rm -rf "${PREFIX}.old"
  mv "${PREFIX}" "${PREFIX}.old"
fi
mv "${STAGING}" "${PREFIX}"
rm -rf "${PREFIX}.old"
info "$(du -sh "${PREFIX}" | cut -f1) installed"

# Debug mode's trace lives here. Created now, not by the sampler: its unit lists the path in
# ReadWritePaths, and systemd refuses to start a unit whose ReadWritePaths does not exist.
install -d -m 0755 /var/log/bloopbox

ln -sf "${PREFIX}/deploy/doctor.sh" /usr/local/bin/bloopbox-doctor
ln -sf "${PREFIX}/deploy/collect-diagnostics.sh" /usr/local/bin/bloopbox-diagnostics
ln -sf "${PREFIX}/deploy/hotspot-test.sh" /usr/local/bin/bloopbox-hotspot-test
ln -sf "${PREFIX}/deploy/debug-mode.sh" /usr/local/bin/bloopbox-debug
ln -sf "${PREFIX}/deploy/audio-test.sh" /usr/local/bin/bloopbox-audio-test
info "bloopbox-doctor, -diagnostics, -hotspot-test, -debug and -audio-test are on PATH"

step "configuring the setup hotspot's DNS"
# NetworkManager runs its own dnsmasq for `ipv4.method shared`, and reads extra config from
# this directory. The wildcard is what makes the captive portal appear: every name a phone
# looks up on the hotspot resolves to the device, so its connectivity probe reaches us and
# can be answered wrongly on purpose (see src/server/captivePortal.ts).
if [[ -d /etc/NetworkManager ]]; then
  install -d -m 0755 /etc/NetworkManager/dnsmasq-shared.d
  cat > /etc/NetworkManager/dnsmasq-shared.d/bloopbox.conf <<'EOF'
# Installed by bloopbox. Applies only to NetworkManager's shared-mode dnsmasq — the instance
# that serves the setup hotspot — and not to normal DNS on this device.
address=/#/10.42.0.1
# No upstream: there is no internet to forward to while the device is hosting the hotspot,
# and a query that hangs waiting for one delays the portal appearing.
no-resolv
EOF
  info "wildcard DNS for the setup hotspot"
else
  warn "no /etc/NetworkManager — the captive portal will not redirect here"
fi

step "writing ${ETC_DIR}/environment"
install -d -m 0755 "${ETC_DIR}"
if [[ -f "${ETC_DIR}/environment" ]]; then
  info "kept the existing file (it holds the bridge token both daemons agree on)"
  # The file is authored once on purpose, so flags that write into it do nothing on an
  # upgrade. Say so rather than let someone believe --audio-hat took effect. Keyed on the
  # flag actually being PASSED: now that the profile is remembered, testing the resolved
  # value would fire this on every ordinary upgrade of a wm8960 box and teach the operator
  # to skim past it.
  if [[ "${AUDIO_HAT_GIVEN}" == true || "${NO_LEDS_GIVEN}" == true ]]; then
    warn "--audio-hat/--no-leds write to this file and it already exists — the firmware"
    warn "half was still applied, but edit ${ETC_DIR}/environment by hand for the rest"
  fi
  # A device installed before the capture routing was understood keeps its environment file
  # here, so the new entries never arrive and its microphone stays inaudible with nothing to
  # show for it. Say so with the line to paste, since we cannot write it ourselves.
  EXISTING_SWITCHES="$(grep '^ALSA_ENABLE_SWITCHES' "${ETC_DIR}/environment" 2>/dev/null || true)"
  if [[ -n "${EXISTING_SWITCHES}" && "${EXISTING_SWITCHES}" != *"Input Mixer Boost"* ]]; then
    warn "this file's ALSA_ENABLE_SWITCHES has no capture routing, so the microphone will be"
    warn "faint noise. Replace that line in ${ETC_DIR}/environment with:"
    warn '  ALSA_ENABLE_SWITCHES="Left Output Mixer PCM,Right Output Mixer PCM,Left Input Mixer Boost,Right Input Mixer Boost,Left Input Boost Mixer LINPUT1=3,Right Input Boost Mixer RINPUT1=3"'
    warn "then: sudo systemctl restart bloopbox-audio-init"
  fi
else
  # Shared secret for the localhost Socket.io link between the two processes. Generated
  # per device: a hardcoded default would be the same on every unit ever flashed.
  TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -e "s|@BRIDGE_TOKEN@|${TOKEN}|" \
      -e "s|@DATA_DIR@|${DATA_DIR}|g" \
      "${SOURCE_DIR}/environment.example" > "${ETC_DIR}/environment"
  if [[ "${SIMULATOR}" == true ]]; then
    echo 'SIMULATOR_MODE=true' >> "${ETC_DIR}/environment"
    info "simulator HAL selected"
  fi
  if [[ "${NO_LEDS}" == true ]]; then
    {
      echo ''
      echo '# --no-leds: no lamps are wired, so the driver claims no output lines. The three'
      echo '# logical channels still exist above the HAL; setLed() is simply a no-op.'
      echo 'LED_PINS='
    } >> "${ETC_DIR}/environment"
    info "no LED lines will be claimed"
  fi
  if [[ "${AUDIO_HAT}" == wm8960 ]]; then
    {
      echo ''
      echo '# --audio-hat wm8960. Addressed by card *name*, so a changing card number cannot'
      echo '# point the daemon at the wrong device. Confirm with: sudo bloopbox-audio-test'
      echo 'ALSA_PLAYBACK_DEVICE=plughw:CARD=wm8960soundcard,DEV=0'
      echo 'ALSA_CAPTURE_DEVICE=plughw:CARD=wm8960soundcard,DEV=0'
      echo '# Measured on a real WM8960 HAT, 2026-08-10: this codec has NO "Master" control.'
      echo '# It exposes Playback (the DAC volume), Speaker and Headphone (the two output amps),'
      echo '# and Capture. Playback is the one config.audio.speakerVolumePercent drives, because it'
      echo '# sits upstream of both amps. A wrong name here is SILENT — the HAL treats a mixer'
      echo '# failure as non-fatal, so the setting would simply never apply.'
      echo 'ALSA_MIXER_CONTROL=Playback'
      echo 'ALSA_CAPTURE_MIXER_CONTROL=Capture'
      echo '# The two stages BELOW the DAC, measured on a real HAT 2026-08-17. Playback was already'
      echo '# at 0 dB while Speaker sat at 101/127 = -20 dB and both class-D boosts at 0 — so the'
      echo '# box was ~26 dB quieter than the hardware allows, and turning Playback up could not'
      echo '# reach any of it. Driven by config.audio.ampVolumePercent / ampBoostDc / ampBoostAc so'
      echo '# a builder can trade loudness against distortion for their own enclosure.'
      echo 'ALSA_AMP_MIXER_CONTROL=Speaker'
      echo "ALSA_AMP_DC_MIXER_CONTROL='Speaker DC'"
      echo "ALSA_AMP_AC_MIXER_CONTROL='Speaker AC'"
      echo '# Analogue routing this codec does not do by default. Every entry here was measured'
      echo '# on a real HAT on 2026-08-10 with a full-scale tone through its own speaker.'
      echo '#   Output Mixer PCM   off by default = the DAC is wired to nothing. Total silence,'
      echo '#                      while the card enumerates, aplay exits 0 and volumes read fine.'
      echo '#   Input Mixer Boost  off by default = the mic PGA is not connected to the boost'
      echo '#                      mixer that feeds the ADC. Worth 42 dB (tone -62 dB -> -20 dB).'
      echo '#   Input Boost Mixer  the mic boost stage, 0 dB by default. 3 is +29 dB and takes'
      echo '#                      the same tone to -8.4 dB. Without it a voice note is faint noise.'
      echo '# bloopbox-audio-init.service applies these at boot — it cannot happen here, because'
      echo '# install.sh also runs inside a chroot with no sound card. Entries are Name or Name=Value.'
      echo 'ALSA_ENABLE_SWITCHES="Left Output Mixer PCM,Right Output Mixer PCM,Left Input Mixer Boost,Right Input Mixer Boost,Left Input Boost Mixer LINPUT1=3,Right Input Boost Mixer RINPUT1=3"'
      echo '# Match the 48 kHz cues: this codec cannot hold two rates on one I2S clock, and'
      echo '# the record pop plays while capture is open. See src/hal/gpioDriver.ts.'
      echo 'CAPTURE_RATE=48000'
    } >> "${ETC_DIR}/environment"
    info "WM8960 ALSA settings written"
  fi
  info "generated a bridge token"
fi
chown "root:${SERVICE_USER}" "${ETC_DIR}/environment"
chmod 0640 "${ETC_DIR}/environment"

step "recording the hardware profile"
# Machine-written and world-readable: doctor reads it unprivileged to check that the
# firmware block still matches what the box is supposed to be.
{
  echo '# What this box IS. Written by install.sh, read back by the next upgrade so that'
  echo '# --audio-hat and --no-leds do not have to be remembered by a human.'
  echo '#'
  echo '# Machine-written — settings go in environment, next to this file, not here.'
  echo "AUDIO_HAT=${AUDIO_HAT}"
  echo "NO_LEDS=${NO_LEDS}"
} > "${PROFILE_FILE}"
chmod 0644 "${PROFILE_FILE}"
info "AUDIO_HAT=${AUDIO_HAT}, NO_LEDS=${NO_LEDS} -> ${PROFILE_FILE}"

step "installing systemd units"
for unit in "${SOURCE_DIR}"/systemd/*.service; do
  sed -e "s|@PREFIX@|${PREFIX}|g" \
      -e "s|@USER@|${SERVICE_USER}|g" \
      -e "s|@DATA_DIR@|${DATA_DIR}|g" \
      -e "s|@ETC_DIR@|${ETC_DIR}|g" \
      "${unit}" > "/etc/systemd/system/$(basename "${unit}")"
  info "$(basename "${unit}")"
done

if [[ "${NO_WATCHDOG}" == true ]]; then
  rm -f /etc/systemd/system.conf.d/10-bloopbox-watchdog.conf
else
  # A screenless appliance in a child's room has nobody to notice a wedged kernel. The
  # BCM watchdog is enabled in config.txt below; this is the userspace half.
  install -d -m 0755 /etc/systemd/system.conf.d
  cat > /etc/systemd/system.conf.d/10-bloopbox-watchdog.conf <<'EOF'
# Installed by bloopbox. Reboots the device if systemd stops petting /dev/watchdog.
[Manager]
RuntimeWatchdogSec=15s
RebootWatchdogSec=2min
EOF
  info "hardware watchdog: 15s"
fi

if [[ "${SYSTEMD_RUNNING}" == true ]]; then
  systemctl daemon-reload
fi
if [[ "${HAS_SYSTEMCTL}" == true ]]; then
  # Works offline too: inside a mounted image systemctl just writes the symlinks.
  systemctl enable bloopbox-hardware.service bloopbox-whatsapp.service \
                   bloopbox-firstboot.service bloopbox-net.service \
                   bloopbox-audio-init.service bloopbox-ssh-password.service >/dev/null
  info "enabled at boot"
else
  warn "no systemctl here — the unit files are installed but nothing is enabled"
fi

step "configuring the firmware"
if [[ "${NO_BOOT_CONFIG}" == true ]]; then
  info "skipped (--no-boot-config)"
else
  if [[ -z "${BOOT_DIR}" ]]; then
    if [[ -f /boot/firmware/config.txt ]]; then BOOT_DIR=/boot/firmware
    elif [[ -f /boot/config.txt ]]; then BOOT_DIR=/boot
    fi
  fi

  if [[ -z "${BOOT_DIR}" || ! -f "${BOOT_DIR}/config.txt" ]]; then
    warn "no config.txt found — skipping. On a real Pi the buttons will float without"
    warn "the pull-ups, so add this by hand:  gpio=17,27,22=ip,pu"
  else
    CONFIG_TXT="${BOOT_DIR}/config.txt"
    cp -n "${CONFIG_TXT}" "${CONFIG_TXT}.bloopbox.bak" 2>/dev/null || true
    # Replace our own block rather than appending a second copy on every upgrade.
    if grep -q '^# >>> bloopbox >>>' "${CONFIG_TXT}"; then
      sed -i '/^# >>> bloopbox >>>/,/^# <<< bloopbox <<</d' "${CONFIG_TXT}"
    fi
    {
      echo '# >>> bloopbox >>>'
      echo '# Button inputs with firmware pull-ups. This is where the pull-ups come from:'
      echo '# opengpio 2.0.2 transposes bias and debounce when calling its native binding,'
      echo '# so asking the library for them leaves the lines floating. Applied before'
      echo '# userspace starts and survives any library change. See CLAUDE.md.'
      echo 'gpio=17,27,22=ip,pu'
      if [[ "${AUDIO_HAT}" == wm8960 ]]; then
        echo '# WM8960 codec HAT (I2S audio, I2C control). This overlay is in-tree in the'
        echo '# Raspberry Pi kernel — do not install the vendor DKMS driver, it is'
        echo '# unmaintained and breaks on new kernels. The HAT uses GPIO 2,3 and 18-21;'
        echo '# its own button is on GPIO17, which is already button 1.'
        echo 'dtparam=i2c_arm=on'
        echo 'dtoverlay=wm8960-soundcard'
        echo '# One card, so ALSA `default` cannot land on the wrong one.'
        echo 'dtparam=audio=off'
      fi
      if [[ "${NO_WATCHDOG}" != true ]]; then
        echo '# Hardware watchdog, petted by systemd (see system.conf.d).'
        echo 'dtparam=watchdog=on'
      fi
      echo '# <<< bloopbox <<<'
    } >> "${CONFIG_TXT}"
    info "updated ${CONFIG_TXT} (backup at ${CONFIG_TXT}.bloopbox.bak)"
    info "the pull-ups and the watchdog take effect after a reboot"
    if [[ "${AUDIO_HAT}" == wm8960 ]]; then
      info "so does the WM8960 overlay — there is no sound card until you reboot"
    fi
  fi

  # The Pi's own firmware appends `cgroup_disable=memory` to the kernel command line on
  # boards with this little RAM, to save the accounting overhead — found on real hardware
  # 2026-08-10, via /proc/cmdline, on a device where MemoryHigh/MemoryMax had silently never
  # done anything. `cgroup_enable=memory` overrides it back on; without the memory
  # controller, MemoryHigh/MemoryMax on all four units (and the tmpfs cap they double as —
  # see the comment in bloopbox-hardware.service) are inert, not just generous.
  if [[ -z "${BOOT_DIR}" || ! -f "${BOOT_DIR}/cmdline.txt" ]]; then
    warn "no cmdline.txt found — skipping. MemoryHigh/MemoryMax will stay unenforced; add"
    warn "this to the kernel command line by hand: cgroup_enable=memory cgroup_memory=1"
  else
    CMDLINE_TXT="${BOOT_DIR}/cmdline.txt"
    if grep -qw 'cgroup_enable=memory' "${CMDLINE_TXT}"; then
      info "memory cgroup already enabled in ${CMDLINE_TXT}"
    else
      cp -n "${CMDLINE_TXT}" "${CMDLINE_TXT}.bloopbox.bak" 2>/dev/null || true
      # One line, no comments — the firmware parses this literally, so nothing but the
      # parameters themselves can go in it.
      sed -i 's/[[:space:]]*$/ cgroup_enable=memory cgroup_memory=1/' "${CMDLINE_TXT}"
      info "enabled the memory cgroup controller in ${CMDLINE_TXT}"
      info "MemoryHigh/MemoryMax take effect after a reboot"
    fi
  fi
fi

step "starting the services"
if [[ "${NO_START}" == true ]]; then
  info "skipped (--no-start); they will come up on the next boot"
elif [[ "${SYSTEMD_RUNNING}" != true ]]; then
  info "no running systemd (installing into an image?) — enabled only"
else
  systemctl restart bloopbox-net.service
  systemctl restart bloopbox-hardware.service
  systemctl restart bloopbox-whatsapp.service
  sleep 2
  for unit in bloopbox-net bloopbox-hardware bloopbox-whatsapp; do
    if systemctl is-active --quiet "${unit}.service"; then
      info "${unit}: active"
    else
      warn "${unit} is not running — journalctl -u ${unit} -n 40"
    fi
  done
fi

HOSTNAME_NOW="$(hostname 2>/dev/null || echo bloopbox)"
cat <<EOF

Installed.

  settings      http://${HOSTNAME_NOW}.local/          (or :3000/ if port 80 is taken)
  health check  sudo bloopbox-doctor
  audio test    sudo bloopbox-audio-test         (plays a cue, records you, plays it back)
  diagnostics   sudo bloopbox-diagnostics        (a redacted bundle to send somewhere)
  hotspot test  sudo bloopbox-hotspot-test       (drops your ssh session on purpose)
  debug mode    sudo bloopbox-debug on           (verbose logs that survive a reboot, 24h)
  logs          journalctl -u bloopbox-hardware -u bloopbox-whatsapp -u bloopbox-net -f
  config        ${DATA_DIR}/config.json   (saving from the admin panel restarts the daemon)

First run: open the settings page, set a password, link WhatsApp, assign the three buttons.
EOF

# Split deliberately: the HAT is the standard audio hardware now, and it says nothing about how
# many buttons or lamps are wired. Gating the "only button 1" advice on the HAT told every
# full board to leave two thirds of itself disabled.
if [[ "${AUDIO_HAT}" == wm8960 ]]; then
  cat <<'EOF'
Reboot before testing audio — the overlay is firmware — then: sudo bloopbox-audio-test
The HAT's own button is on GPIO17, which is button 1, so channel 1 works with no wiring.
EOF
fi

if [[ "${NO_LEDS}" == true ]]; then
  cat <<'EOF'
No lamps are wired here (--no-leds), so the lights stay dark and setLed() is a no-op. If only
the HAT's button is wired, assign contact 1 and leave 2 and 3 disabled.
EOF
fi
