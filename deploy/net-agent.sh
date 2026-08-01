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

# The networks in range, as a JSON array, for the setup portal's picker.
#
# Refreshed on a slow cadence of its own, not every poll: a rescan takes seconds and disturbs
# an associated link. And it is captured *before* the hotspot goes up, because a radio hosting
# an access point cannot scan — so the list a parent picks from is the room as it was moments
# earlier, which is the best that one radio allows.
SCAN_INTERVAL_SECONDS="${NET_SCAN_INTERVAL_SECONDS:-30}"
SCAN_JSON='[]'
SCAN_AT=0

refresh_scan() {
  local rescan="${1:-yes}"
  local line ssid signal security first entry
  local -a seen=()
  entry=''
  first=yes

  while IFS= read -r line; do
    # -t escapes the field separator inside values, so an SSID containing a colon arrives as
    # `a\:b`. Split on unescaped colons by swapping the escaped ones out first.
    line="${line//\\:/$'\x01'}"
    ssid="${line%%:*}"; line="${line#*:}"
    signal="${line%%:*}"; line="${line#*:}"
    security="${line}"
    ssid="${ssid//$'\x01'/:}"

    [[ -z "${ssid}" ]] && continue
    # nmcli lists one row per BSS, so a mesh or an extender appears several times. Keep the
    # first, which is the strongest: the list is already sorted by signal.
    local duplicate=no seen_one
    for seen_one in ${seen[@]+"${seen[@]}"}; do
      [[ "${seen_one}" == "${ssid}" ]] && { duplicate=yes; break; }
    done
    [[ "${duplicate}" == yes ]] && continue
    seen+=("${ssid}")

    [[ "${signal}" =~ ^[0-9]+$ ]] || signal=0
    [[ "${first}" == yes ]] && first=no || entry+=','
    entry+="{\"ssid\":$(json_string "${ssid}"),\"signal\":${signal},\"secure\":$([[ -n "${security}" ]] && echo true || echo false)}"

    # A picker is a list a parent reads, not an inventory. Twenty is already more than any
    # home has, and the file is read every two seconds by the daemon.
    [[ "${#seen[@]}" -ge 20 ]] && break
  done < <(nmcli --escape yes -t -f SSID,SIGNAL,SECURITY dev wifi list --rescan "${rescan}" 2>/dev/null)

  SCAN_JSON="[${entry}]"
  SCAN_AT="$(date +%s)"
}

# NetworkManager's own shared mode: DHCP, DNS and 10.42.0.1 without hostapd, and teardown is
# one command. Needs dnsmasq-base installed.
ap_up() {
  local device
  device="$(wifi_device)"
  # Last chance to see the room: once this interface is an access point it cannot scan, and
  # the portal it is about to serve is mostly a list of networks.
  refresh_scan yes
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

# Joins the network the portal was given: teach the profile, drop the hotspot, associate.
#
# The credentials arrive as arguments, never as anything evaluated — an SSID is arbitrary
# bytes chosen by a stranger's router, and this runs as root.
join_network() {
  local ssid="$1" psk="$2" device
  device="$(wifi_device)"
  [[ -z "${ssid}" ]] && { log "join asked for with no ssid"; return 1; }

  if [[ "$(nmcli -t -f NAME con show 2>/dev/null | awk -v n="${CONNECTION_NAME}" '$0==n{print "yes"; exit}')" != yes ]]; then
    nmcli con add type wifi ifname "${device}" con-name "${CONNECTION_NAME}" ssid "${ssid}" \
      >/dev/null 2>&1 || { log "could not create ${CONNECTION_NAME}"; return 1; }
  fi
  nmcli con modify "${CONNECTION_NAME}" \
    802-11-wireless.mode infrastructure 802-11-wireless.ssid "${ssid}" \
    connection.interface-name "${device}" \
    connection.autoconnect yes connection.autoconnect-priority 10 >/dev/null 2>&1

  if [[ -n "${psk}" ]]; then
    nmcli con modify "${CONNECTION_NAME}" \
      wifi-sec.key-mgmt wpa-psk wifi-sec.psk "${psk}" >/dev/null 2>&1
  else
    nmcli con modify "${CONNECTION_NAME}" wifi-sec.key-mgmt none >/dev/null 2>&1
  fi

  # The hotspot has to go before the join can be attempted: one radio.
  nmcli con down "${AP_CONNECTION}" >/dev/null 2>&1
  if nmcli con up "${CONNECTION_NAME}" >/dev/null 2>&1; then
    log "joined ${ssid}"
    LAST_ERROR=
  else
    # Reported, not retried here. The supervisor raises the hotspot again after its grace
    # period, and the portal reads this line to explain what went wrong.
    log "could not join ${ssid}"
    LAST_ERROR="could not join ${ssid} — wrong passphrase, or out of range"
  fi
}

# Reads one request, acts on it, deletes it. Unknown actions are logged and dropped: this is
# the privilege boundary, so the allowlist is the whole security model.
consume_request() {
  [[ -r "${REQUEST_FILE}" ]] || return 0
  local action= ssid= psk=
  if [[ -x "${NODE}" ]]; then
    # Three lines out, never eval'd: action, ssid, psk. The action is matched against a fixed
    # list below; the other two only ever become arguments to nmcli.
    mapfile -t parsed < <("${NODE}" -e '
      const fs = require("node:fs");
      const line = (value) => String(value ?? "").split("\n")[0] ?? "";
      try {
        const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const action = typeof parsed?.action === "string" ? parsed.action : "";
        console.log(/^[a-z-]{1,16}$/.test(action) ? action : "");
        console.log(line(parsed?.ssid).slice(0, 32));
        console.log(line(parsed?.psk).slice(0, 63));
      } catch { console.log(""); console.log(""); console.log(""); }
    ' "${REQUEST_FILE}" 2>/dev/null)
    action="${parsed[0]:-}"
    ssid="${parsed[1]:-}"
    psk="${parsed[2]:-}"
  else
    log "no node at ${NODE} — cannot read requests"
  fi
  # Deleted before acting, not after: a join takes seconds, and a request still sitting there
  # when the next poll comes round would be run twice.
  rm -f "${REQUEST_FILE}"

  case "${action}" in
    ap-up) ap_up ;;
    ap-down) ap_down ;;
    join) join_network "${ssid}" "${psk}" ;;
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
    publish "{\"version\":1,\"updatedAtMs\":$(now_ms),\"available\":false,\"online\":false,\"ssid\":null,\"signal\":null,\"apActive\":false,\"apSsid\":null,\"scan\":[],\"scanAgeSeconds\":0,\"lastError\":null}"
    sleep "${POLL_SECONDS}" &
    wait $! 2>/dev/null || true
  done
  exit 0
fi

log "publishing to ${STATE_FILE} every ${POLL_SECONDS}s; hotspot would be ${AP_SSID}"

LAST_ERROR=

while [[ "${running}" == true ]]; do
  consume_request

  # Not while hosting the hotspot: the radio cannot do both, and the list captured just
  # before it went up is the one the portal should be showing anyway.
  if [[ "${ap_active:-false}" != true && $(( $(date +%s) - SCAN_AT )) -ge "${SCAN_INTERVAL_SECONDS}" ]]; then
    refresh_scan yes
  fi

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

  if [[ -n "${LAST_ERROR}" ]]; then
    last_error_json="$(json_string "${LAST_ERROR}")"
  else
    last_error_json=null
  fi

  publish "{\"version\":1,\"updatedAtMs\":$(now_ms),\"available\":true,\"online\":${online},\"ssid\":${ssid_json},\"signal\":${signal},\"apActive\":${ap_active},\"apSsid\":$(json_string "${AP_SSID}"),\"scan\":${SCAN_JSON},\"scanAgeSeconds\":$(( $(date +%s) - SCAN_AT )),\"lastError\":${last_error_json}}"

  # Backgrounded so a SIGTERM lands during the sleep rather than after it.
  sleep "${POLL_SECONDS}" &
  wait $! 2>/dev/null || true
done

log "stopped"
exit 0
