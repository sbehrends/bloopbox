#!/usr/bin/env bash
#
# Publishes what NetworkManager knows about this device's Wi-Fi, as JSON in a tmpfs, for the
# unprivileged daemon to read.
#
# The hardware server runs as the `bloopbox` user under ProtectSystem=strict, so it cannot
# talk to NetworkManager at all — and should not be able to. Everything privileged happens
# here, as root, and crosses to the daemon as a file it can only read:
#
#   /run/bloopbox-net/net-state.json   root writes, everyone reads   (this script)
#   /run/bloopbox/net-request.json     daemon writes, root reads     (not yet built)
#
# Two directories, one writer each, so neither side can be tricked into acting on something
# it wrote itself, and so this script never chowns the daemon's recording directory out from
# under it.
#
# Never writes a passphrase here: the file is world-readable by design.
#
# No `pipefail`: the nmcli pipelines below would report a SIGPIPE'd producer as a failure.
# For the same reason there is no `cmd | grep -q` anywhere in this file — see CLAUDE.md.
set -u

STATE_DIR="${NET_STATE_DIR:-/run/bloopbox-net}"
STATE_FILE="${STATE_DIR}/net-state.json"

# Must stay comfortably under NET_STATE_MAX_AGE_MS (30s) in src/net/netState.ts, which is
# how the daemon decides this agent has stopped publishing. Keep the two in step.
POLL_SECONDS="${NET_AGENT_POLL_SECONDS:-5}"

# The connection profile the setup hotspot will use. Named here so "are we in AP mode" has
# one answer even before anything brings it up.
AP_CONNECTION="${AP_CONNECTION_NAME:-bloopbox-ap}"

log() { echo "net-agent: $*"; }

mkdir -p "${STATE_DIR}"
chmod 0755 "${STATE_DIR}"

running=true
trap 'running=false' TERM INT

# Atomic, so a reader never sees half a document. Same filesystem, so rename is a rename.
publish() {
  local body="$1"
  local tmp="${STATE_FILE}.tmp"
  printf '%s\n' "${body}" > "${tmp}" || return 0
  chmod 0644 "${tmp}"
  mv -f "${tmp}" "${STATE_FILE}"
}

# Epoch milliseconds. `date +%s%3N` is GNU-only, which is fine — this only ever runs on the
# device — but the fallback keeps the script honest anywhere else.
now_ms() {
  local ms
  ms="$(date +%s%3N 2>/dev/null)"
  case "${ms}" in
    *N* | '') echo "$(($(date +%s) * 1000))" ;;
    *) echo "${ms}" ;;
  esac
}

json_string() {
  # Escapes the two characters that can appear in an SSID and break JSON. SSIDs are
  # arbitrary bytes; anything more exotic than this is not worth a shell JSON encoder,
  # and the daemon treats an unparseable file as "unknown" rather than as an outage.
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "${value}"
}

if ! command -v nmcli >/dev/null 2>&1; then
  # Publish once, then idle. Reporting "no information" is materially different from not
  # running: the daemon distinguishes them, and only this one keeps the LEDs quiet.
  log "no nmcli on PATH — publishing an empty reading and idling"
  while [[ "${running}" == true ]]; do
    publish "{\"version\":1,\"updatedAtMs\":$(now_ms),\"available\":false,\"online\":false,\"ssid\":null,\"signal\":null,\"apActive\":false}"
    sleep "${POLL_SECONDS}" &
    wait $! 2>/dev/null || true
  done
  exit 0
fi

log "publishing to ${STATE_FILE} every ${POLL_SECONDS}s"

while [[ "${running}" == true ]]; do
  ssid=
  signal=null
  online=false
  ap_active=false

  # The active Wi-Fi AP, if any: `active:ssid:signal`, one line per scanned network.
  active_line="$(nmcli -t -f active,ssid,signal dev wifi 2>/dev/null | awk -F: '$1=="yes"{print; exit}')"
  if [[ -n "${active_line}" ]]; then
    ssid="$(echo "${active_line}" | cut -d: -f2)"
    candidate="$(echo "${active_line}" | cut -d: -f3)"
    [[ "${candidate}" =~ ^[0-9]+$ ]] && signal="${candidate}"
  fi

  # Associated is not the same as usable: NetworkManager reports `connected` only once the
  # device has an address. Anything short of that is an outage as far as the LEDs care.
  wifi_state="$(nmcli -t -f TYPE,STATE dev status 2>/dev/null | awk -F: '$1=="wifi"{print $2; exit}')"
  [[ "${wifi_state}" == "connected" ]] && online=true

  # In AP mode the radio is "connected" to a network it is itself hosting, which is not
  # being online. The profile name is the reliable tell; the mode is the cross-check.
  active_profiles="$(nmcli -t -f NAME,TYPE con show --active 2>/dev/null)"
  if [[ "${active_profiles}" == *"${AP_CONNECTION}:"* ]]; then
    ap_active=true
    online=false
    ssid=
    signal=null
  fi

  if [[ -n "${ssid}" ]]; then
    ssid_json="$(json_string "${ssid}")"
  else
    ssid_json=null
  fi

  publish "{\"version\":1,\"updatedAtMs\":$(now_ms),\"available\":true,\"online\":${online},\"ssid\":${ssid_json},\"signal\":${signal},\"apActive\":${ap_active}}"

  # Backgrounded so a SIGTERM lands during the sleep rather than after it.
  sleep "${POLL_SECONDS}" &
  wait $! 2>/dev/null || true
done

log "stopped"
exit 0
