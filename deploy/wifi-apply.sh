#!/usr/bin/env bash
#
# Teaches NetworkManager the Wi-Fi network this device should join. There is no screen and
# no keyboard, so the credentials arrive one of two ways:
#
#   1. A text file on the boot partition — /boot/firmware/kids-messenger-wifi.txt — which
#      any laptop can write, because that partition is FAT. This wins when present, and is
#      deleted once applied: it is the recovery path when the device cannot get online and
#      the admin panel is therefore unreachable.
#
#   2. The wifi section of /data/config.json, which the admin panel writes. Saving there
#      restarts the hardware server, and this script runs as its ExecStartPre, so a
#      network change from the admin panel is applied on the restart it already causes.
#
# Always exits 0. Nothing here is worth refusing to boot the device over, and the LED
# ladder already reports "Wi-Fi down" in a way a parent can act on.
#
# No `pipefail`: the `nmcli | grep -q` checks below would report a SIGPIPE'd nmcli as a
# failure and take the wrong branch.
set -u

PREFIX="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${PREFIX}/node/bin/node"
CONFIG_PATH="${CONFIG_PATH:-/data/config.json}"
CONNECTION_NAME=kids-messenger

BOOT_FILE=
for candidate in /boot/firmware/kids-messenger-wifi.txt /boot/kids-messenger-wifi.txt; do
  [[ -f "${candidate}" ]] && { BOOT_FILE="${candidate}"; break; }
done

log() { echo "wifi-apply: $*"; }

if ! command -v nmcli >/dev/null 2>&1; then
  log "no nmcli — leaving networking to whatever manages it here"
  exit 0
fi

SSID=
PSK=
COUNTRY=
SOURCE=

if [[ -n "${BOOT_FILE}" ]]; then
  # ssid=..., psk=..., country=... — one per line, # comments allowed. Deliberately not
  # sourced as shell: this file is written by a parent on a Windows laptop.
  while IFS='=' read -r key value; do
    key="${key%%[[:space:]]*}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    case "${key,,}" in
      ssid) SSID="${value}" ;;
      psk|password|passphrase) PSK="${value}" ;;
      country) COUNTRY="${value}" ;;
    esac
  done < <(grep -v '^[[:space:]]*#' "${BOOT_FILE}" | grep '=')
  SOURCE="${BOOT_FILE}"
elif [[ -r "${CONFIG_PATH}" && -x "${NODE}" ]]; then
  # Read with node rather than jq: node is bundled, jq is not.
  mapfile -t parsed < <("${NODE}" -e '
    const fs = require("node:fs");
    try {
      const wifi = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).wifi ?? {};
      console.log(wifi.ssid ?? "");
      console.log(wifi.password ?? "");
    } catch {
      console.log("");
      console.log("");
    }
  ' "${CONFIG_PATH}" 2>/dev/null)
  SSID="${parsed[0]:-}"
  PSK="${parsed[1]:-}"
  SOURCE="${CONFIG_PATH}"
fi

if [[ -z "${SSID}" ]]; then
  log "no SSID configured yet — nothing to do"
  exit 0
fi

if [[ -n "${COUNTRY}" ]]; then
  # The 2.4 GHz channel set is region-locked; without a country the radio may refuse to
  # associate with channels 12-14.
  raspi-config nonint do_wifi_country "${COUNTRY}" >/dev/null 2>&1 \
    || iw reg set "${COUNTRY}" >/dev/null 2>&1 \
    || log "could not set the Wi-Fi country to ${COUNTRY}"
fi

ACTIVE_SSID="$(nmcli -t -f active,ssid dev wifi 2>/dev/null | awk -F: '$1=="yes"{print $2; exit}')"
if [[ "${ACTIVE_SSID}" == "${SSID}" ]]; then
  log "already associated with ${SSID}"
else
  if nmcli -t -f NAME con show 2>/dev/null | grep -qx "${CONNECTION_NAME}"; then
    nmcli con modify "${CONNECTION_NAME}" wifi.ssid "${SSID}" >/dev/null
  else
    nmcli con add type wifi con-name "${CONNECTION_NAME}" ifname '*' ssid "${SSID}" >/dev/null
  fi

  if [[ -n "${PSK}" ]]; then
    nmcli con modify "${CONNECTION_NAME}" \
      wifi-sec.key-mgmt wpa-psk wifi-sec.psk "${PSK}" >/dev/null
  else
    nmcli con modify "${CONNECTION_NAME}" wifi-sec.key-mgmt none >/dev/null
  fi

  # Preferred over anything the imager seeded, but those stay as a fallback: if this
  # network is wrong, the device can still come back on the old one.
  nmcli con modify "${CONNECTION_NAME}" \
    connection.autoconnect yes connection.autoconnect-priority 10 >/dev/null

  if nmcli con up "${CONNECTION_NAME}" >/dev/null 2>&1; then
    log "joined ${SSID} (from ${SOURCE})"
  else
    # Not fatal: NetworkManager keeps retrying, and the radio may simply be out of range.
    log "configured ${SSID} (from ${SOURCE}) but could not associate yet"
  fi
fi

if [[ -n "${BOOT_FILE}" ]]; then
  # The passphrase does not need to stay in clear text on a partition every computer can
  # read. Write the file again to change networks.
  rm -f "${BOOT_FILE}"
  log "removed ${BOOT_FILE}"
fi

exit 0
