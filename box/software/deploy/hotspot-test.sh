#!/usr/bin/env bash
#
# Brings the setup hotspot up on purpose, holds it while you look at it from a phone, and
# puts the device back on the real network afterwards:
#
#   sudo bloopbox-hotspot-test              # 180s window
#   sudo bloopbox-hotspot-test --seconds 300
#   sudo bloopbox-hotspot-test --keep-daemon  # leave the web server up, to browse over the AP
#   sudo bloopbox-hotspot-test --status       # just read the last run's log
#
# **This will drop your ssh session.** A Pi Zero 2 W has one radio: becoming an access point
# means leaving your network, and there is no ethernet to fall back to. So the work is
# detached from the terminal that started it — the session dies, the test carries on, and the
# log is waiting when you reconnect. Nothing here is safe to run over the Wi-Fi link *without*
# that detachment, which is why the script re-execs itself rather than trusting the operator
# to remember `nohup`.
#
# The restore runs from an EXIT trap, so a crash, a kill or a failed step still ends with the
# radio back on the home network. That matters more than the test result: a device stuck in AP
# mode with nobody in the room is a device you have to walk over to and re-flash.
#
# No `pipefail`: the nmcli pipelines below have producers that exit early, and reporting that
# as a failed step would take the wrong branch (see CLAUDE.md).
set -u

PREFIX="${PREFIX:-/opt/bloopbox}"
REQUEST_FILE="${NET_REQUEST_FILE:-/run/bloopbox/net-request.json}"
STATE_FILE="${NET_STATE_FILE:-/run/bloopbox-net/net-state.json}"
AP_CONNECTION="${AP_CONNECTION_NAME:-bloopbox-ap}"
WIFI_CONNECTION="${WIFI_CONNECTION_NAME:-bloopbox}"
LOG=/tmp/bloopbox-hotspot-test.log

SECONDS_UP=180
KEEP_DAEMON=false
# How long the radio gets to change mode before anything is judged. Generous: NetworkManager
# reports the profile active before the interface has finished becoming an access point.
SETTLE_SECONDS="${AP_SETTLE_SECONDS:-20}"
CHILD=false
STATUS_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seconds) SECONDS_UP="$2"; shift 2 ;;
    --keep-daemon) KEEP_DAEMON=true; shift ;;
    --status) STATUS_ONLY=true; shift ;;
    --child) CHILD=true; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ "${STATUS_ONLY}" == true ]]; then
  [[ -r "${LOG}" ]] || { echo "no ${LOG} — has the test been run?"; exit 1; }
  cat "${LOG}"
  exit 0
fi

# Argument validation first, so a typo is reported as a typo rather than as a permission
# problem the operator then goes and "fixes".
[[ "${SECONDS_UP}" =~ ^[0-9]+$ ]] || { echo "--seconds wants a number" >&2; exit 2; }
[[ "${EUID}" -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }

if [[ "${CHILD}" != true ]]; then
  # Detach, then get out of the way. `setsid` so the process leaves this session entirely:
  # sshd kills the whole session's process group when the link drops, and `nohup` alone only
  # covers the HUP.
  child_args=(--child --seconds "${SECONDS_UP}")
  [[ "${KEEP_DAEMON}" == true ]] && child_args+=(--keep-daemon)
  setsid nohup "$0" "${child_args[@]}" >/dev/null 2>&1 &
  cat <<EOF

Hotspot test started, detached. This terminal is about to lose the device.

  1. Wait ~20 seconds, then look for an open network called bloopbox-XXXX on a phone.
  2. Join it. It should get an address in 10.42.0.x with no passphrase.
  3. The LEDs should be double-pulsing: on-off-on, then dark for most of two seconds.
  4. After ${SECONDS_UP}s the device leaves the hotspot and rejoins your Wi-Fi by itself.

The web server is stopped for the duration unless you passed --keep-daemon, so
http://10.42.0.1:3000/admin/ will not answer. That is this script, not the hotspot.

Then reconnect and read the result:

  sudo bloopbox-hotspot-test --status

EOF
  exit 0
fi

exec > "${LOG}" 2>&1

step() { printf '\n==> [%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
info() { printf '    %s\n' "$*"; }

wifi_device() {
  local device
  device="$(nmcli -t -f DEVICE,TYPE dev status 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}')"
  echo "${device:-wlan0}"
}
DEVICE="$(wifi_device)"

snapshot() {
  info "nmcli device : $(nmcli -t -f DEVICE,STATE,CONNECTION dev status 2>/dev/null | awk -F: -v d="${DEVICE}" '$1==d{print $2" / "$3}')"
  info "iw type      : $(iw dev "${DEVICE}" info 2>/dev/null | awk '/type/{print $2; exit}')"
  info "addresses    : $(ip -brief addr show "${DEVICE}" 2>/dev/null | tr -s ' ')"
  info "agent says   : $(cat "${STATE_FILE}" 2>/dev/null || echo '(no reading)')"
}

ask_agent() {
  # The same file the daemon writes, so this exercises the real path rather than a private
  # one. The agent picks it up within its poll interval. A fresh id each time, because the agent
  # acts on each id once: asking for ap-up twice in a row must raise the hotspot twice.
  printf '{"action":"%s","id":"hotspot-test-%s-%s"}\n' "$1" "$(date +%s)" "${RANDOM}" > "${REQUEST_FILE}"
  info "asked the agent for $1"
}

restored=false
restore() {
  [[ "${restored}" == true ]] && return 0
  restored=true
  step "restoring"
  # Directly, not through the agent: this runs from an EXIT trap, and the trap may be firing
  # because the agent is the thing that died.
  nmcli con down "${AP_CONNECTION}" >/dev/null 2>&1
  nmcli con up "${WIFI_CONNECTION}" >/dev/null 2>&1 \
    || nmcli dev connect "${DEVICE}" >/dev/null 2>&1 \
    || info "could not bring ${WIFI_CONNECTION} back up — NetworkManager may still retry"
  systemctl start bloopbox-hardware.service >/dev/null 2>&1
  sleep 5
  snapshot
  step "done"
}
trap restore EXIT INT TERM

step "before"
snapshot
STARTED_ON="$(nmcli -t -f active,ssid dev wifi 2>/dev/null | awk -F: '$1=="yes"{print $2; exit}')"
info "started on: ${STARTED_ON:-(nothing)}"

if [[ "${KEEP_DAEMON}" == true ]]; then
  step "leaving the hardware daemon running (--keep-daemon)"
  # So the admin panel can be reached over the hotspot, which is the only way to prove DHCP,
  # routing and the web server all work together from a phone. The catch: on a *configured*
  # device the supervisor will step aside about 60s in to retry the real network, so keep the
  # window short or expect the AP to vanish mid-look. On an unconfigured device it never
  # steps aside — nothing to rejoin — which is exactly the first-boot case this imitates.
  info "browse to http://10.42.0.1:3000/admin/ once you have joined the hotspot"
  [[ "${SECONDS_UP}" -gt 55 ]] && info "note: >55s window on a configured device will be cut short by the supervisor"
else
  step "stopping the hardware daemon for the duration"
  # Not because it interferes with the radio, but because its supervisor would notice the
  # hotspot and start managing it — stepping aside every 60s to retry the real network, which
  # is correct behaviour and completely wrong for a test that wants the AP held still.
  systemctl stop bloopbox-hardware.service >/dev/null 2>&1
  info "stopped: no LEDs, no buttons and no admin panel for the next ${SECONDS_UP}s"
fi

step "raising the hotspot"
ask_agent ap-up
sleep "${SETTLE_SECONDS}"
snapshot

AP_TYPE="$(iw dev "${DEVICE}" info 2>/dev/null | awk '/type/{print $2; exit}')"
if [[ "${AP_TYPE}" == "AP" ]]; then
  info "PASS: ${DEVICE} is in AP mode"
else
  info "FAIL: ${DEVICE} reports type '${AP_TYPE:-unknown}', not AP"
  info "      most likely: the profile would not activate. journalctl -u NetworkManager -n 50"
fi

if [[ -n "$(ip -4 -brief addr show "${DEVICE}" 2>/dev/null | grep -o '10\.42\.[0-9]*\.1' || true)" ]]; then
  info "PASS: shared-mode address is up (10.42.0.1)"
else
  info "FAIL: no 10.42.0.x address — ipv4.method shared did not take"
  info "      most likely: dnsmasq-base is missing. dpkg -l dnsmasq-base"
fi

step "holding for ${SECONDS_UP}s — join it from a phone now"
info "the SSID should be $(nmcli -t -f 802-11-wireless.ssid con show "${AP_CONNECTION}" 2>/dev/null | cut -d: -f2)"
sleep "${SECONDS_UP}"

step "did anything connect?"
LEASES="/var/lib/NetworkManager/dnsmasq-${DEVICE}.leases"
if [[ -s "${LEASES}" ]]; then
  info "PASS: NetworkManager's dnsmasq handed out a lease"
  sed 's/^/      /' "${LEASES}"
else
  info "no DHCP lease recorded in ${LEASES}"
  info "      if nothing joined, that is expected; if a phone joined and got no address,"
  info "      that is the finding"
fi
info "stations associated: $(iw dev "${DEVICE}" station dump 2>/dev/null | grep -c '^Station' || echo 0)"

step "bringing it down through the agent (the same path the supervisor uses)"
ask_agent ap-down
sleep "${SETTLE_SECONDS}"
snapshot

REJOINED="$(nmcli -t -f active,ssid dev wifi 2>/dev/null | awk -F: '$1=="yes"{print $2; exit}')"
if [[ -n "${REJOINED}" ]]; then
  info "PASS: back on ${REJOINED} after the hotspot came down"
else
  info "FAIL: not associated with anything yet — the restore below will try again"
  info "      worth knowing for the driver: the radio may need longer between AP teardown"
  info "      and a join attempt than the agent currently allows"
fi
