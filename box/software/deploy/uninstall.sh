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
for unit in bloopbox-hardware bloopbox-whatsapp bloopbox-firstboot bloopbox-net bloopbox-debug-sampler \
            bloopbox-ssh-password bloopbox-audio-init; do
  systemctl disable --now "${unit}.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/${unit}.service"
done
rm -f /etc/systemd/system.conf.d/10-bloopbox-watchdog.conf
[[ -d /run/systemd/system ]] && systemctl daemon-reload

step "removing the application"
rm -rf "${PREFIX}" "${PREFIX}.new" "${PREFIX}.old"
rm -f /usr/local/bin/bloopbox-doctor /usr/local/bin/bloopbox-diagnostics \
      /usr/local/bin/bloopbox-hotspot-test /usr/local/bin/bloopbox-debug \
      /usr/local/bin/bloopbox-audio-test
# The journal settings: install.sh's own (RAM, capped), and debug mode's (persistent) under both
# the name it has now and the one it had before 2026-09-24. Debug mode also leaves the trace and
# a deadline file. None of it is wanted once bloopbox is gone.
rm -f /etc/systemd/journald.conf.d/50-bloopbox.conf \
      /etc/systemd/journald.conf.d/90-bloopbox-debug.conf \
      /etc/systemd/journald.conf.d/10-bloopbox-debug.conf
[[ -d /run/systemd/system ]] && { systemctl restart systemd-journald 2>/dev/null || true; }
rm -rf /var/log/bloopbox

step "removing the network configuration"
# The setup hotspot's wildcard DNS. Left behind, every name looked up on any future shared-mode
# network this Pi hosts would resolve to 10.42.0.1.
rm -f /etc/NetworkManager/dnsmasq-shared.d/bloopbox.conf
# The setup hotspot's profile (net-agent.sh's ap_up). Never the active connection outside setup,
# and nothing but bloopbox would ever bring it up.
if command -v nmcli >/dev/null 2>&1 && nmcli connection delete bloopbox-ap >/dev/null 2>&1; then
  echo "    deleted the bloopbox-ap hotspot connection"
fi
# The `bloopbox` profile — the home network — is left for --purge, at the very end: it is very
# likely the connection this uninstall is being run over.

step "reverting the firmware configuration"
for candidate in /boot/firmware/config.txt /boot/config.txt; do
  if [[ -f "${candidate}" ]] && grep -q '^# >>> bloopbox >>>' "${candidate}"; then
    sed -i '/^# >>> bloopbox >>>/,/^# <<< bloopbox <<</d' "${candidate}"
    echo "    cleaned ${candidate} (pull-ups and watchdog are gone after a reboot)"
  fi
done
# install.sh appends the memory cgroup switch to cmdline.txt, and writes the .bloopbox.bak beside
# it only when it did — so the backup is the proof the parameters are ours to take out. Without
# one they were there before bloopbox and stay.
for candidate in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
  if [[ -f "${candidate}" && -f "${candidate}.bloopbox.bak" ]]; then
    sed -i 's/ cgroup_enable=memory cgroup_memory=1//' "${candidate}"
    echo "    cleaned ${candidate} (the memory cgroup controller is off again after a reboot)"
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
  echo "    ${DATA_DIR} (settings, WhatsApp credentials, waiting notes and activity totals)"
  echo "    ${ETC_DIR}/environment (bridge token)"
  echo "    the bloopbox Wi-Fi connection (the network this box joined)"
  echo "    pass --purge to remove these too"
fi

# Last of all, because deleting the profile drops the connection if it is the active one — over
# ssh on Wi-Fi, that is this session. Everything above has already happened by then. Only the
# profile bloopbox created (wifi-apply.sh, net-agent.sh's join); anything the imager seeded is
# not ours and stays, and is what the Pi falls back to.
if [[ "${PURGE}" == true ]] && command -v nmcli >/dev/null 2>&1; then
  printf '\nUninstalled. Forgetting the bloopbox Wi-Fi connection — an ssh session over it ends here.\n'
  nmcli connection delete bloopbox >/dev/null 2>&1 || true
  exit 0
fi

printf '\nUninstalled.\n'
