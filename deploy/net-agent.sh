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

# The other direction: written by the unprivileged daemon in its own runtime directory,
# consumed and deleted here. Everything in it is validated against a fixed list of actions
# before anything happens, and no part of it is ever evaluated as shell.
REQUEST_FILE="${NET_REQUEST_FILE:-/run/bloopbox/net-request.json}"

# Used to read the request file: node is bundled with the release, jq is not.
PREFIX="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE_BIN:-${PREFIX}/node/bin/node}"

# Must stay comfortably under NET_STATE_MAX_AGE_MS (30s) in src/net/netState.ts, which is
# how the daemon decides this agent has stopped publishing. Keep the two in step.
POLL_SECONDS="${NET_AGENT_POLL_SECONDS:-5}"

# The connection profile the setup hotspot uses. Named here so "are we in AP mode" has one
# answer, and so teardown never has to guess.
AP_CONNECTION="${AP_CONNECTION_NAME:-bloopbox-ap}"

# The connection wifi-apply.sh maintains from config.json — what "the real network" means.
CONNECTION_NAME="${WIFI_CONNECTION_NAME:-bloopbox}"

# The network a parent looks for. Suffixed with the last four of the Pi's serial so two boxes
# in one house are tellable apart — not a secret, and not treated as one: the hotspot is open
# (see PENDING.md for why a published passphrase would be worth nothing).
serial_suffix() {
  local serial
  serial="$(awk -F': *' '/^Serial/{print $2; exit}' /proc/cpuinfo 2>/dev/null)"
  if [[ -n "${serial}" ]]; then
    echo "${serial: -4}" | tr '[:lower:]' '[:upper:]'
  else
    echo "0000"
  fi
}
AP_SSID="${AP_SSID:-bloopbox-$(serial_suffix)}"

# The Wi-Fi interface, asked for rather than assumed to be wlan0 — but falling back to it,
# because an AP profile bound to `ifname *` has no device to pick when it activates.
wifi_device() {
  local device
  device="$(nmcli -t -f DEVICE,TYPE dev status 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}')"
  echo "${device:-wlan0}"
}

# NetworkManager's own shared mode: DHCP, DNS and 10.42.0.1 without hostapd, and teardown is
# one command. Needs dnsmasq-base installed.
ap_up() {
  local device
  device="$(wifi_device)"
  if [[ "$(nmcli -t -f NAME con show 2>/dev/null | awk -v n="${AP_CONNECTION}" '$0==n{print "yes"; exit}')" != yes ]]; then
    nmcli con add type wifi ifname "${device}" con-name "${AP_CONNECTION}" ssid "${AP_SSID}" \
      >/dev/null 2>&1 || { log "could not create ${AP_CONNECTION}"; return 1; }
  fi
  # Rewritten every time rather than assumed: an upgrade may change what we want here, and a
  # profile left over from an older release would otherwise stay wrong forever.
  nmcli con modify "${AP_CONNECTION}" \
    connection.interface-name "${device}" \
    802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.ssid "${AP_SSID}" \
    wifi-sec.key-mgmt none ipv4.method shared ipv6.method ignore \
    connection.autoconnect no >/dev/null 2>&1
  if nmcli con up "${AP_CONNECTION}" >/dev/null 2>&1; then
    log "hotspot up: ${AP_SSID}"
  else
    log "hotspot failed to come up"
    return 1
  fi
}

# Down, then straight into an attempt at the real network — one radio, so the only way to try
# is to stop being an access point first.
ap_down() {
  nmcli con down "${AP_CONNECTION}" >/dev/null 2>&1
  log "hotspot down"
  if nmcli con up "${CONNECTION_NAME}" >/dev/null 2>&1; then
    log "rejoined ${CONNECTION_NAME}"
  else
    log "no luck rejoining ${CONNECTION_NAME} yet"
  fi
}

# Reads one request, acts on it, deletes it. Unknown actions are logged and dropped: this is
# the privilege boundary, so the allowlist is the whole security model.
consume_request() {
  [[ -r "${REQUEST_FILE}" ]] || return 0
  local action=
  if [[ -x "${NODE}" ]]; then
    action="$("${NODE}" -e '
      const fs = require("node:fs");
      try {
        const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const action = parsed && typeof parsed.action === "string" ? parsed.action : "";
        console.log(/^[a-z-]{1,16}$/.test(action) ? action : "");
      } catch { console.log(""); }
    ' "${REQUEST_FILE}" 2>/dev/null)"
  else
    log "no node at ${NODE} — cannot read requests"
  fi
  rm -f "${REQUEST_FILE}"

  case "${action}" in
    ap-up) ap_up ;;
    ap-down) ap_down ;;
    # Empty means the file was there but held nothing this script is willing to act on —
    # unparseable, the wrong shape, or an action outside the allowlist. Worth a line: silence
    # here would make a daemon asking for something impossible look like a daemon asking for
    # nothing. The action itself is not echoed; it is untrusted input.
    "") log "dropped a request that carried no usable action" ;;
    *) log "ignoring unknown request: ${action}" ;;
  esac
}

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

log "publishing to ${STATE_FILE} every ${POLL_SECONDS}s; hotspot would be ${AP_SSID}"

while [[ "${running}" == true ]]; do
  consume_request

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
