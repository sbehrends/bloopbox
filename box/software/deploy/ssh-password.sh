#!/usr/bin/env bash
#
# Gives this device its own ssh password, once, on the first boot of a flashed image.
#
# An image built by scripts/build-sd-image.sh without --password ships no usable password:
# userconf.txt carries the hash of a throwaway nobody ever saw, so nothing baked into a
# published image can log in, and every card flashed from it ends up different. The builder
# leaves a marker naming the login user; this script generates the real password, applies it,
# and records it where the admin panel can show it to the parent who owns the box.
#
# Runs as root from bloopbox-ssh-password.service, before sshd starts, and only while the
# marker exists — so a tarball install over ssh, which never writes the marker, never has its
# password changed underneath it.
#
# Order matters for crash safety: the record is written first, the password applied second and
# the marker removed last. A power cut anywhere in between leaves the marker, and the next boot
# generates, records and applies a fresh one, so the record and the account cannot disagree.
set -euo pipefail

ETC_DIR="${ETC_DIR:-/etc/bloopbox}"
DATA_DIR="${DATA_DIR:-/data}"
SERVICE_USER="${SERVICE_USER:-bloopbox}"
MARKER="${ETC_DIR}/ssh-password.pending"
RECORD="${DATA_DIR}/ssh-password"
# 14 characters from a 62-symbol alphabet is ~83 bits: far beyond guessing over ssh, and still
# short enough to type from a phone screen.
PASSWORD_LENGTH=14

log() { echo "ssh-password: $*"; }

if [[ ! -f "${MARKER}" ]]; then
  log "no ${MARKER} — this device's password is not ours to manage"
  exit 0
fi

LOGIN_USER="$(tr -d '[:space:]' < "${MARKER}")"
# The marker is written by the image builder, but it is still a name headed for chpasswd.
if [[ ! "${LOGIN_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  log "refusing an invalid user name in ${MARKER}"
  exit 1
fi
if ! getent passwd "${LOGIN_USER}" >/dev/null; then
  # userconfig.service renames the image's `pi` account on first boot. If it has not yet, the
  # marker stays and the next boot tries again.
  log "no user ${LOGIN_USER} yet — leaving the marker for the next boot"
  exit 1
fi

# From the kernel's CSPRNG. Read in one go rather than streamed through a pipe, so `pipefail`
# never sees a producer killed by an early-exiting consumer.
RAW="$(head -c 48 /dev/urandom | base64 -w0)"
PASSWORD="${RAW//[^A-Za-z0-9]/}"
PASSWORD="${PASSWORD:0:${PASSWORD_LENGTH}}"
if [[ "${#PASSWORD}" -ne "${PASSWORD_LENGTH}" ]]; then
  log "could not generate a password"
  exit 1
fi

install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${DATA_DIR}"
# Written beside its final name and renamed into place, so the panel never reads half a file.
# Owned by root and only group-readable: the daemon may show it but cannot rewrite it.
TMP="$(mktemp "${DATA_DIR}/.ssh-password.XXXXXX")"
trap 'rm -f "${TMP}"' EXIT
printf 'user=%s\npassword=%s\n' "${LOGIN_USER}" "${PASSWORD}" > "${TMP}"
chown "root:${SERVICE_USER}" "${TMP}"
chmod 0640 "${TMP}"
sync "${TMP}"
mv -f "${TMP}" "${RECORD}"
trap - EXIT
sync "${DATA_DIR}"

printf '%s:%s\n' "${LOGIN_USER}" "${PASSWORD}" | chpasswd
rm -f "${MARKER}"
log "set a per-device password for ${LOGIN_USER}; the admin panel shows it under Advanced"
