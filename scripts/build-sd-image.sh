#!/usr/bin/env bash
#
# Turns a release tarball into a flashable Raspberry Pi OS image with everything already
# installed: both daemons enabled, ffmpeg and libgpiod present, the GPIO pull-ups in
# config.txt, ssh on, a login user, and optionally the family Wi-Fi.
#
#   sudo ./scripts/build-sd-image.sh --wifi-ssid Home --wifi-psk secret --wifi-country DE
#
# Flash the result with Raspberry Pi Imager or dd, put it in the Pi, and the device comes
# up on the network with the admin panel on port 3000. Nothing needs installing over ssh.
#
# Requires Linux and root: it attaches the image to a loop device and chroots into it.
# That rules out running it directly on macOS — use CI (.github/workflows/release.yml),
# a Linux VM, or a privileged container:
#
#   docker run --rm --privileged --platform linux/arm64 -v "$PWD":/repo -w /repo \
#     debian:trixie-slim bash -c 'apt-get update && apt-get install -y --no-install-recommends \
#       curl xz-utils parted e2fsprogs dosfstools openssl ca-certificates && ./scripts/build-sd-image.sh'
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# shellcheck source=../packaging/versions.env
source packaging/versions.env

ARTIFACT=
OUTPUT=
WORK_DIR="${REPO_ROOT}/release/image-work"
NEW_HOSTNAME="${IMAGE_HOSTNAME}"
LOGIN_USER="${IMAGE_USER}"
LOGIN_PASSWORD=
WIFI_SSID=
WIFI_PSK=
WIFI_COUNTRY=
ENABLE_SSH=true
KEEP_IMG=false

usage() {
  cat <<'EOF'
Builds a ready-to-run Raspberry Pi OS image with the messenger preinstalled.

Usage: sudo ./scripts/build-sd-image.sh [options]

Options:
  --artifact PATH     Release tarball (default: newest in ./release)
  --output PATH       Where to write the .img.xz (default: ./release/<name>.img.xz)
  --hostname NAME     Device hostname, also its .local name (default: bloopbox)
  --user NAME         Login user for ssh (default: bloop)
  --password PASS     That user's password (default: generated and written next to the image)
  --wifi-ssid SSID    Wi-Fi network to join on first boot
  --wifi-psk PSK      Wi-Fi passphrase
  --wifi-country CC   Two-letter regulatory domain, e.g. DE. Set this or the radio may
                      refuse some channels.
  --no-ssh            Do not enable ssh
  --keep-img          Leave the uncompressed .img as well
  --work-dir DIR      Scratch space (default: ./release/image-work)
  -h, --help          This message

Without --wifi-ssid the image still boots: it writes bloopbox-wifi.txt onto the boot
partition, which any laptop can fill in before first boot.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --hostname) NEW_HOSTNAME="$2"; shift 2 ;;
    --user) LOGIN_USER="$2"; shift 2 ;;
    --password) LOGIN_PASSWORD="$2"; shift 2 ;;
    --wifi-ssid) WIFI_SSID="$2"; shift 2 ;;
    --wifi-psk) WIFI_PSK="$2"; shift 2 ;;
    --wifi-country) WIFI_COUNTRY="$2"; shift 2 ;;
    --no-ssh) ENABLE_SSH=false; shift ;;
    --keep-img) KEEP_IMG=true; shift ;;
    --work-dir) WORK_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "this needs Linux (loop devices and chroot) — see the header for the container one-liner"
[[ "${EUID}" -eq 0 ]] || die "run this with sudo"

for tool in curl xz losetup parted e2fsck resize2fs mount umount chroot openssl sha256sum; do
  command -v "${tool}" >/dev/null 2>&1 || die "missing ${tool}"
done

if [[ -z "${ARTIFACT}" ]]; then
  ARTIFACT="$(ls -t release/bloopbox-*-linux-"${TARGET_ARCH}".tar.gz 2>/dev/null | head -1 || true)"
fi
[[ -n "${ARTIFACT}" && -f "${ARTIFACT}" ]] \
  || die "no release tarball — run ./scripts/build-release.sh first"
ARTIFACT="$(readlink -f "${ARTIFACT}")"
ARTIFACT_NAME="$(basename "${ARTIFACT}")"
APP_VERSION="$(echo "${ARTIFACT_NAME}" | sed -E 's/^bloopbox-(.+)-linux-.*/\1/')"

IMAGE_NAME="bloopbox-${APP_VERSION}-${PI_OS_IMAGE}"
[[ -n "${OUTPUT}" ]] || OUTPUT="${REPO_ROOT}/release/${IMAGE_NAME}.img.xz"

# Cross-architecture chroot needs the static interpreter. Debian's qemu-user-static
# registers itself with binfmt's F flag, so it is picked up even inside the chroot; copying
# it in as well costs nothing and covers hosts where it is not.
QEMU_BINARY=
if [[ "$(uname -m)" != "aarch64" ]]; then
  QEMU_BINARY="$(command -v qemu-aarch64-static || true)"
  [[ -n "${QEMU_BINARY}" ]] \
    || die "building an arm64 image on $(uname -m) needs qemu-user-static (apt install qemu-user-static binfmt-support)"
fi

mkdir -p "${WORK_DIR}" "${WORK_DIR}/cache"
CACHED_XZ="${WORK_DIR}/cache/${PI_OS_IMAGE}.img.xz"
BASE_IMG="${WORK_DIR}/cache/${PI_OS_IMAGE}.img"
TARGET_IMG="${WORK_DIR}/${IMAGE_NAME}.img"
MOUNT_POINT="${WORK_DIR}/mnt"

LOOP_BOOT=
LOOP_ROOT=
cleanup() {
  local status=$?
  set +e
  if mountpoint -q "${MOUNT_POINT}" 2>/dev/null; then
    for target in dev/pts dev proc sys boot/firmware ''; do
      umount -l "${MOUNT_POINT}/${target}" 2>/dev/null
    done
  fi
  for device in "${LOOP_BOOT}" "${LOOP_ROOT}"; do
    [[ -n "${device}" ]] && losetup -d "${device}" 2>/dev/null
  done
  if [[ "${status}" -ne 0 ]]; then
    echo
    echo "error: image build failed — unmounted and detached the loop devices" >&2
  fi
  return "${status}"
}
trap cleanup EXIT

# Attaches one partition of an image file as its own loop device, from the offsets in the
# partition table.
#
# Not `losetup --partscan`: that leaves the kernel to publish /dev/loopNp1 and friends,
# which needs udev. There is no udev in a container, and CI should not depend on there
# being one either. Explicit offsets work everywhere.
attach_partition() {
  local image="$1" number="$2"
  local geometry start size
  geometry="$(parted --machine --script "${image}" unit B print \
              | awk -F: -v n="${number}" '$1 == n { print $2 " " $4 }' | tr -d 'B')"
  [[ -n "${geometry}" ]] || die "partition ${number} not found in ${image}"
  read -r start size <<<"${geometry}"
  losetup --find --show --offset "${start}" --sizelimit "${size}" "${image}"
}

step "fetching ${PI_OS_IMAGE}"
if [[ -f "${BASE_IMG}" ]]; then
  info "using the decompressed image already in ${WORK_DIR}/cache"
else
  if [[ ! -f "${CACHED_XZ}" ]]; then
    curl --fail --location --progress-bar --output "${CACHED_XZ}.part" "${PI_OS_URL}"
    mv "${CACHED_XZ}.part" "${CACHED_XZ}"
  fi
  info "verifying the pinned checksum"
  echo "${PI_OS_SHA256}  ${CACHED_XZ}" | sha256sum --check --quiet \
    || die "checksum mismatch on ${CACHED_XZ} — delete it and retry, or update PI_OS_SHA256"
  info "decompressing"
  xz --decompress --keep --stdout "${CACHED_XZ}" > "${BASE_IMG}.part"
  mv "${BASE_IMG}.part" "${BASE_IMG}"
fi
info "$(du -h "${BASE_IMG}" | cut -f1) base image"

step "growing the root filesystem by ${IMAGE_GROW_MB}MB"
# Lite leaves a few hundred MB free, and the payload is the bundled Node runtime plus
# node_modules plus ffmpeg. First boot still expands the partition to fill the real card,
# because cmdline.txt keeps Pi OS's init_resize hook and the root partition stays last.
rm -f "${TARGET_IMG}"
cp --sparse=always "${BASE_IMG}" "${TARGET_IMG}"
truncate --size="+${IMAGE_GROW_MB}M" "${TARGET_IMG}"
parted --script "${TARGET_IMG}" resizepart 2 100%

LOOP_ROOT="$(attach_partition "${TARGET_IMG}" 2)"
LOOP_BOOT="$(attach_partition "${TARGET_IMG}" 1)"
info "attached ${LOOP_ROOT} (rootfs) and ${LOOP_BOOT} (bootfs)"
e2fsck -fy "${LOOP_ROOT}" >/dev/null 2>&1 || true
resize2fs "${LOOP_ROOT}" >/dev/null
info "rootfs is now $(lsblk -no SIZE "${LOOP_ROOT}" | tr -d ' ')"

step "mounting"
mkdir -p "${MOUNT_POINT}"
mount "${LOOP_ROOT}" "${MOUNT_POINT}"
mkdir -p "${MOUNT_POINT}/boot/firmware"
mount "${LOOP_BOOT}" "${MOUNT_POINT}/boot/firmware"
mount --bind /dev "${MOUNT_POINT}/dev"
mount --bind /dev/pts "${MOUNT_POINT}/dev/pts"
mount -t proc proc "${MOUNT_POINT}/proc"
mount -t sysfs sys "${MOUNT_POINT}/sys"
info "$(findmnt -no FSTYPE,SIZE --target "${MOUNT_POINT}" | tr -s ' ') at ${MOUNT_POINT}"

[[ -n "${QEMU_BINARY}" ]] && cp "${QEMU_BINARY}" "${MOUNT_POINT}/usr/bin/"

# ld.so.preload holds the Pi-specific memcpy shim; it makes every chroot command noisy or
# fatal under emulation. Restored before unmounting.
if [[ -s "${MOUNT_POINT}/etc/ld.so.preload" ]]; then
  mv "${MOUNT_POINT}/etc/ld.so.preload" "${MOUNT_POINT}/etc/ld.so.preload.disabled"
fi

# The image's resolv.conf points at a systemd-resolved socket that does not exist here.
if [[ -e "${MOUNT_POINT}/etc/resolv.conf" ]]; then
  mv "${MOUNT_POINT}/etc/resolv.conf" "${MOUNT_POINT}/etc/resolv.conf.orig"
fi
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "${MOUNT_POINT}/etc/resolv.conf"

chroot "${MOUNT_POINT}" /bin/true || die "cannot execute inside the image — is binfmt/qemu set up?"

step "installing runtime packages into the image"
cp "${ARTIFACT}" "${MOUNT_POINT}/tmp/${ARTIFACT_NAME}"
chroot "${MOUNT_POINT}" /bin/bash -euo pipefail -c "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends ${RUNTIME_PACKAGES}
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  echo \"    ffmpeg \$(ffmpeg -version | head -1 | cut -d' ' -f3), libgpiod \$(dpkg-query -W -f='\${Version}' libgpiod3)\"
"

step "naming the device ${NEW_HOSTNAME}"
# Before the install, so the "open http://<host>.local:3000/admin/" line install.sh prints
# names this device rather than whatever is running the build.
echo "${NEW_HOSTNAME}" > "${MOUNT_POINT}/etc/hostname"
# Keep /etc/hosts consistent or sudo complains about resolving the host on every call.
if grep -q '^127.0.1.1' "${MOUNT_POINT}/etc/hosts"; then
  sed -i "s/^127.0.1.1.*/127.0.1.1\t${NEW_HOSTNAME}/" "${MOUNT_POINT}/etc/hosts"
else
  printf '127.0.1.1\t%s\n' "${NEW_HOSTNAME}" >> "${MOUNT_POINT}/etc/hosts"
fi
info "reachable as ${NEW_HOSTNAME}.local"

step "installing the application into the image"
chroot "${MOUNT_POINT}" /bin/bash -euo pipefail -c "
  cd /tmp
  tar xzf '${ARTIFACT_NAME}'
  cd 'bloopbox-${APP_VERSION}-linux-${TARGET_ARCH}'
  # Packages are in already, and there is no systemd to start anything: the units are
  # enabled offline and come up on first boot.
  ./install.sh --skip-deps --no-start
  cd /
  rm -rf '/tmp/${ARTIFACT_NAME}' '/tmp/bloopbox-${APP_VERSION}-linux-${TARGET_ARCH}'
"

step "configuring access"
if [[ -z "${LOGIN_PASSWORD}" ]]; then
  LOGIN_PASSWORD="$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)"
  GENERATED_PASSWORD=true
else
  GENERATED_PASSWORD=false
fi
PASSWORD_HASH="$(openssl passwd -6 "${LOGIN_PASSWORD}")"

# Handed to Pi OS's own mechanism rather than by creating a second account here: the image
# ships a `pi` user (uid 1000) plus an enabled userconfig.service, and that service renames
# it and sets the password from this file on first boot. Left absent, the same service
# instead starts an interactive setup wizard on tty1 — and this device has no screen.
printf '%s:%s\n' "${LOGIN_USER}" "${PASSWORD_HASH}" > "${MOUNT_POINT}/boot/firmware/userconf.txt"
info "login user ${LOGIN_USER} (renamed from pi on first boot, keeping its group memberships)"

if [[ "${ENABLE_SSH}" == true ]]; then
  # sshswitch.service watches for this marker and enables sshd on first boot.
  touch "${MOUNT_POINT}/boot/firmware/ssh"
  info "ssh enabled"
fi

if [[ -n "${WIFI_SSID}" ]]; then
  # Seeded as a NetworkManager keyfile so the very first boot is already online. The
  # runtime path (deploy/wifi-apply.sh) uses the same connection name, so a later change
  # from the admin panel or the boot partition edits this one rather than competing with it.
  CONNECTION_FILE="${MOUNT_POINT}/etc/NetworkManager/system-connections/bloopbox.nmconnection"
  mkdir -p "$(dirname "${CONNECTION_FILE}")"
  {
    echo '[connection]'
    echo 'id=bloopbox'
    echo 'type=wifi'
    echo 'autoconnect=true'
    echo 'autoconnect-priority=10'
    echo
    echo '[wifi]'
    echo 'mode=infrastructure'
    echo "ssid=${WIFI_SSID}"
    echo
    if [[ -n "${WIFI_PSK}" ]]; then
      echo '[wifi-security]'
      echo 'key-mgmt=wpa-psk'
      echo "psk=${WIFI_PSK}"
      echo
    fi
    echo '[ipv4]'
    echo 'method=auto'
    echo
    echo '[ipv6]'
    echo 'method=auto'
  } > "${CONNECTION_FILE}"
  # NetworkManager refuses to load a keyfile that others can read.
  chmod 0600 "${CONNECTION_FILE}"
  info "wi-fi ${WIFI_SSID} seeded"

  if [[ -n "${WIFI_COUNTRY}" ]]; then
    chroot "${MOUNT_POINT}" raspi-config nonint do_wifi_country "${WIFI_COUNTRY}" >/dev/null 2>&1 \
      && info "wi-fi country ${WIFI_COUNTRY}" \
      || info "could not preset the wi-fi country (set it later with raspi-config)"
  fi
else
  info "no wi-fi supplied — the parent fills in bloopbox-wifi.txt before first boot"
fi

# The one file a parent may need to touch, on the only partition Windows and macOS can
# both read. deploy/wifi-apply.sh consumes and then deletes it, on every boot.
cat > "${MOUNT_POINT}/boot/firmware/bloopbox-wifi.txt" <<EOF
# Wi-Fi for bloopbox.
#
# Fill in the two lines below, save the file, and put the card back in the device. It is
# read and then deleted on the next boot, so the password does not stay on this partition.
#
# This is also how to move the device to a different network later, and the way back in if
# it ever loses Wi-Fi: the admin panel is unreachable when the device is offline, this file
# is not.

ssid=${WIFI_SSID}
psk=${WIFI_PSK}
country=${WIFI_COUNTRY:-DE}
EOF

cat > "${MOUNT_POINT}/boot/firmware/bloopbox-README.txt" <<EOF
bloopbox — ${APP_VERSION}
Built $(date -u +%Y-%m-%dT%H:%M:%SZ) on ${PI_OS_IMAGE}

This card is ready to run. Put it in the Pi and power up.

  Wi-Fi        edit bloopbox-wifi.txt on this partition before first boot
  Admin panel  http://${NEW_HOSTNAME}.local:3000/admin/
  ssh          ${LOGIN_USER}@${NEW_HOSTNAME}.local
  Health       sudo bloopbox-doctor
  Logs         journalctl -u bloopbox-hardware -u bloopbox-whatsapp -f

First boot takes a minute or so: the root filesystem is expanded to fill the card and the
device reboots once. The LEDs run a chase while it starts, then go dark when it is ready.

Open the admin panel to set a password, link WhatsApp and assign the three buttons.
EOF

step "unmounting"
if [[ -e "${MOUNT_POINT}/etc/ld.so.preload.disabled" ]]; then
  mv "${MOUNT_POINT}/etc/ld.so.preload.disabled" "${MOUNT_POINT}/etc/ld.so.preload"
fi
rm -f "${MOUNT_POINT}/etc/resolv.conf"
if [[ -e "${MOUNT_POINT}/etc/resolv.conf.orig" ]]; then
  mv "${MOUNT_POINT}/etc/resolv.conf.orig" "${MOUNT_POINT}/etc/resolv.conf"
fi
[[ -n "${QEMU_BINARY}" ]] && rm -f "${MOUNT_POINT}/usr/bin/$(basename "${QEMU_BINARY}")"

FREE_SPACE="$(df -h --output=avail "${MOUNT_POINT}" | tail -1 | tr -d ' ')"
info "${FREE_SPACE} free in the image"

umount "${MOUNT_POINT}/dev/pts" "${MOUNT_POINT}/dev" "${MOUNT_POINT}/proc" "${MOUNT_POINT}/sys"
umount "${MOUNT_POINT}/boot/firmware"
umount "${MOUNT_POINT}"

# Zeroing the free blocks makes the compressed image dramatically smaller. Optional tool.
if command -v zerofree >/dev/null 2>&1; then
  e2fsck -fy "${LOOP_ROOT}" >/dev/null 2>&1 || true
  zerofree "${LOOP_ROOT}" && info "zeroed free space"
fi

losetup -d "${LOOP_ROOT}" "${LOOP_BOOT}"
LOOP_ROOT=
LOOP_BOOT=

step "compressing"
mkdir -p "$(dirname "${OUTPUT}")"
rm -f "${OUTPUT}"
xz --threads=0 --stdout "${TARGET_IMG}" > "${OUTPUT}"
( cd "$(dirname "${OUTPUT}")" && sha256sum "$(basename "${OUTPUT}")" > "$(basename "${OUTPUT}").sha256" )

if [[ "${KEEP_IMG}" == true ]]; then
  mv "${TARGET_IMG}" "$(dirname "${OUTPUT}")/"
  info "kept the uncompressed image"
else
  rm -f "${TARGET_IMG}"
fi

CREDENTIALS="$(dirname "${OUTPUT}")/${IMAGE_NAME}.credentials.txt"
cat > "${CREDENTIALS}" <<EOF
${IMAGE_NAME}

hostname   ${NEW_HOSTNAME}
ssh user   ${LOGIN_USER}
password   ${LOGIN_PASSWORD}
wi-fi      ${WIFI_SSID:-(not set — edit bloopbox-wifi.txt on the boot partition)}

The admin panel password is separate and is set during onboarding, in the browser.
EOF
chmod 0600 "${CREDENTIALS}"

printf '\n==> %s (%s)\n' "${OUTPUT}" "$(du -h "${OUTPUT}" | cut -f1)"
printf '    credentials in %s\n' "${CREDENTIALS}"
if [[ "${GENERATED_PASSWORD}" == true ]]; then
  printf '    generated ssh password for %s: %s\n' "${LOGIN_USER}" "${LOGIN_PASSWORD}"
fi
cat <<EOF

Flash it:
  Raspberry Pi Imager -> Use custom -> ${OUTPUT}
  or: xzcat ${OUTPUT} | sudo dd of=/dev/sdX bs=4M status=progress conv=fsync
EOF
