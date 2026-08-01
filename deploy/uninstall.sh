#!/usr/bin/env bash
#
# Removes the daemons and the application.
#
#   sudo /opt/bloopbox/deploy/uninstall.sh              # keeps /data and the env file
#   sudo /opt/bloopbox/deploy/uninstall.sh --purge      # removes those too
#
# Without --purge this is reversible: reinstalling a release picks the parent's settings
# and the WhatsApp pairing straight back up.
set -euo pipefail

PREFIX=/opt/bloopbox
DATA_DIR=/data
ETC_DIR=/etc/bloopbox
SERVICE_USER=bloopbox
PURGE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --purge) PURGE=true; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: sudo ./uninstall.sh [--purge] [--prefix DIR] [--data-dir DIR]

  --purge   Also delete the persistent volume (config, WhatsApp credentials), the
            environment file and the service user. Unlinks the device from WhatsApp.
EOF
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
[[ "${EUID}" -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }

step "stopping and disabling the services"
for unit in bloopbox-hardware bloopbox-whatsapp bloopbox-firstboot bloopbox-net; do
  systemctl disable --now "${unit}.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/${unit}.service"
done
rm -f /etc/systemd/system.conf.d/10-bloopbox-watchdog.conf
[[ -d /run/systemd/system ]] && systemctl daemon-reload

step "removing the application"
rm -rf "${PREFIX}" "${PREFIX}.new" "${PREFIX}.old"
rm -f /usr/local/bin/bloopbox-doctor /usr/local/bin/bloopbox-diagnostics \
      /usr/local/bin/bloopbox-hotspot-test

step "reverting the firmware configuration"
for candidate in /boot/firmware/config.txt /boot/config.txt; do
  if [[ -f "${candidate}" ]] && grep -q '^# >>> bloopbox >>>' "${candidate}"; then
    sed -i '/^# >>> bloopbox >>>/,/^# <<< bloopbox <<</d' "${candidate}"
    echo "    cleaned ${candidate} (pull-ups and watchdog are gone after a reboot)"
  fi
done

if [[ "${PURGE}" == true ]]; then
  step "purging device state"
  rm -rf "${DATA_DIR}" "${ETC_DIR}"
  userdel "${SERVICE_USER}" 2>/dev/null || true
  groupdel "${SERVICE_USER}" 2>/dev/null || true
  echo "    removed ${DATA_DIR}, ${ETC_DIR} and the ${SERVICE_USER} user"
  echo "    the WhatsApp pairing is gone — the phone still lists the linked device, remove it there"
else
  step "kept"
  echo "    ${DATA_DIR} (settings and WhatsApp credentials)"
  echo "    ${ETC_DIR}/environment (bridge token)"
  echo "    pass --purge to remove these too"
fi

printf '\nUninstalled.\n'
