#!/usr/bin/env bash
#
# Installs the Kids WhatsApp Voice Messenger on a Raspberry Pi. Run from inside an
# unpacked release tarball:
#
#   tar xzf kids-messenger-0.1.0-linux-arm64.tar.gz
#   sudo ./kids-messenger-0.1.0-linux-arm64/install.sh
#
# Safe to re-run: an upgrade swaps the application directory and leaves /data (config,
# WhatsApp credentials) and /etc/kids-messenger/environment (the bridge token) untouched.
#
# scripts/build-sd-image.sh runs this same script inside a mounted Pi OS root, which is
# why every step either works offline or is skippable, and why services are enabled but
# not started when no systemd is running.
set -euo pipefail

PREFIX=/opt/kids-messenger
DATA_DIR=/data
SERVICE_USER=kidsmsg
ETC_DIR=/etc/kids-messenger
BOOT_DIR=
SKIP_DEPS=false
NO_START=false
NO_BOOT_CONFIG=false
NO_WATCHDOG=false
SIMULATOR=false
FORCE=false

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Installs the Kids WhatsApp Voice Messenger and its two systemd services.

Usage: sudo ./install.sh [options]

Options:
  --prefix DIR       Application directory (default: /opt/kids-messenger)
  --data-dir DIR     Writable volume for config.json and WhatsApp auth (default: /data)
  --user NAME        System user the daemons run as (default: kidsmsg)
  --boot-dir DIR     Firmware config location (default: autodetected /boot/firmware)
  --skip-deps        Do not apt-get install ffmpeg / alsa-utils / libgpiod3
  --no-boot-config   Do not touch config.txt (skips the GPIO pull-ups the buttons need)
  --no-watchdog      Do not enable the hardware watchdog
  --no-start         Install and enable, but do not start the services
  --simulator        Run the browser simulator HAL instead of real GPIO (for a test box)
  --force            Continue even if the architecture or OS looks wrong
  -h, --help         This message
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
    --force) FORCE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

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
  # opengpio addon links against. Nothing here compiles.
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends ffmpeg alsa-utils libgpiod3
  info "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
fi

step "creating the ${SERVICE_USER} user"
if ! getent group "${SERVICE_USER}" >/dev/null; then
  groupadd --system "${SERVICE_USER}"
fi
if ! getent passwd "${SERVICE_USER}" >/dev/null; then
  useradd --system --gid "${SERVICE_USER}" --no-create-home \
          --home-dir /nonexistent --shell /usr/sbin/nologin \
          --comment "Kids WhatsApp Voice Messenger" "${SERVICE_USER}"
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
  # crashes it in a way that looks like a bug in the new version.
  for unit in kids-messenger-hardware kids-messenger-whatsapp; do
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

ln -sf "${PREFIX}/deploy/doctor.sh" /usr/local/bin/kids-messenger-doctor
info "kids-messenger-doctor is on PATH"

step "writing ${ETC_DIR}/environment"
install -d -m 0755 "${ETC_DIR}"
if [[ -f "${ETC_DIR}/environment" ]]; then
  info "kept the existing file (it holds the bridge token both daemons agree on)"
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
  info "generated a bridge token"
fi
chown "root:${SERVICE_USER}" "${ETC_DIR}/environment"
chmod 0640 "${ETC_DIR}/environment"

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
  rm -f /etc/systemd/system.conf.d/10-kids-messenger-watchdog.conf
else
  # A screenless appliance in a child's room has nobody to notice a wedged kernel. The
  # BCM watchdog is enabled in config.txt below; this is the userspace half.
  install -d -m 0755 /etc/systemd/system.conf.d
  cat > /etc/systemd/system.conf.d/10-kids-messenger-watchdog.conf <<'EOF'
# Installed by kids-messenger. Reboots the device if systemd stops petting /dev/watchdog.
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
  systemctl enable kids-messenger-hardware.service kids-messenger-whatsapp.service \
                   kids-messenger-firstboot.service >/dev/null
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
    cp -n "${CONFIG_TXT}" "${CONFIG_TXT}.kids-messenger.bak" 2>/dev/null || true
    # Replace our own block rather than appending a second copy on every upgrade.
    if grep -q '^# >>> kids-messenger >>>' "${CONFIG_TXT}"; then
      sed -i '/^# >>> kids-messenger >>>/,/^# <<< kids-messenger <<</d' "${CONFIG_TXT}"
    fi
    {
      echo '# >>> kids-messenger >>>'
      echo '# Button inputs with firmware pull-ups. This is where the pull-ups come from:'
      echo '# opengpio 2.0.2 transposes bias and debounce when calling its native binding,'
      echo '# so asking the library for them leaves the lines floating. Applied before'
      echo '# userspace starts and survives any library change. See CLAUDE.md.'
      echo 'gpio=17,27,22=ip,pu'
      if [[ "${NO_WATCHDOG}" != true ]]; then
        echo '# Hardware watchdog, petted by systemd (see system.conf.d).'
        echo 'dtparam=watchdog=on'
      fi
      echo '# <<< kids-messenger <<<'
    } >> "${CONFIG_TXT}"
    info "updated ${CONFIG_TXT} (backup at ${CONFIG_TXT}.kids-messenger.bak)"
    info "the pull-ups and the watchdog take effect after a reboot"
  fi
fi

step "starting the services"
if [[ "${NO_START}" == true ]]; then
  info "skipped (--no-start); they will come up on the next boot"
elif [[ "${SYSTEMD_RUNNING}" != true ]]; then
  info "no running systemd (installing into an image?) — enabled only"
else
  systemctl restart kids-messenger-hardware.service
  systemctl restart kids-messenger-whatsapp.service
  sleep 2
  for unit in kids-messenger-hardware kids-messenger-whatsapp; do
    if systemctl is-active --quiet "${unit}.service"; then
      info "${unit}: active"
    else
      warn "${unit} is not running — journalctl -u ${unit} -n 40"
    fi
  done
fi

HOSTNAME_NOW="$(hostname 2>/dev/null || echo kids-messenger)"
cat <<EOF

Installed.

  admin panel   http://${HOSTNAME_NOW}.local:3000/admin/
  health check  sudo kids-messenger-doctor
  logs          journalctl -u kids-messenger-hardware -u kids-messenger-whatsapp -f
  config        ${DATA_DIR}/config.json   (saving from the admin panel restarts the daemon)

First run: open the admin panel, set a password, link WhatsApp, assign the three buttons.
EOF
