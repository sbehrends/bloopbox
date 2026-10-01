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
#   /run/bloopbox/net-request.json     daemon writes, root reads     (writeAgentRequest)
#
# Two directories, one writer each, so neither side can be tricked into acting on something
# it wrote itself, and so this script never chowns the daemon's recording directory out from
# under it.
#
# The request channel is deliberately wider than networking: `reboot` and `poweroff` arrive
# here too (src/system/power.ts), because this is the only process in the product running as
# root and a box with no power button still has to be able to shut down cleanly. The allowlist
# in consume_request is the whole boundary — it always was, and it is now guarding more.
#
# Never writes a passphrase here: the file is world-readable by design.
#
# No `pipefail`: the nmcli pipelines below would report a SIGPIPE'd producer as a failure.
# For the same reason there is no `cmd | grep -q` anywhere in this file — see CLAUDE.md.
set -u

STATE_DIR="${NET_STATE_DIR:-/run/bloopbox-net}"
STATE_FILE="${STATE_DIR}/net-state.json"

# The other direction: written by the unprivileged daemon in its own runtime directory, and
# read here. Everything in it is validated against a fixed list of actions before anything
# happens, and no part of it is ever evaluated as shell.
#
# Never deleted here, and not because of tidiness: under ProtectSystem=strict that directory is
# read-only to this unit, so an `rm` fails — silently, with the old `rm -f` — and the request
# would run again on every poll. Instead every request carries an id, the id of the last one
# acted on is remembered below and published as `handledRequestId`, and the daemon, which owns
# the file, deletes it once it sees its own id come back.
REQUEST_FILE="${NET_REQUEST_FILE:-/run/bloopbox/net-request.json}"
# In this unit's own runtime directory, which RuntimeDirectoryPreserve keeps across a restart,
# so a restarted agent does not run the last request a second time.
HANDLED_FILE="${STATE_DIR}/handled-request-id"

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

# How long a join is given to *show up as connected* before it is called a failure. Kept under
# the supervisor's joinWindowMs (30s in src/core/networkSupervisor.ts) so the hotspot does not
# come back while this is still waiting. See join_network for why the wait exists at all.
JOIN_CONFIRM_SECONDS="${NET_JOIN_CONFIRM_SECONDS:-25}"

# Fallback regulatory domain, used only when the device has never been told one. Not a
# guess at where every device ships — see ensure_radio_unblocked for why a wrong-but-set
# domain is never overwritten.
AP_COUNTRY="${AP_COUNTRY:-DE}"

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
    ipv4.method shared ipv6.method ignore \
    connection.autoconnect no >/dev/null 2>&1
  # An open network means *no* security setting at all. `wifi-sec.key-mgmt none` reads as
  # "open" but means **static WEP** to NetworkManager: it creates an
  # 802-11-wireless-security setting, then refuses to activate because no WEP key was
  # supplied — `need-auth -> failed (reason 'no-secrets')`, on real hardware, 2026-08-10.
  # Removing the whole setting is the only way to say open. `build-sd-image.sh` already
  # does the equivalent by omitting [wifi-security] when there is no passphrase.
  nmcli con modify "${AP_CONNECTION}" remove 802-11-wireless-security >/dev/null 2>&1
  if nmcli con up "${AP_CONNECTION}" >/dev/null 2>&1; then
    log "hotspot up: ${AP_SSID}"
    LAST_ERROR=
  else
    log "hotspot failed to come up"
    # Published, not just logged: on a screenless device the journal is unreachable, and
    # the daemon already reads lastError out of the state file.
    LAST_ERROR="the setup hotspot would not start — check journalctl -u NetworkManager"
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

# Deletes the profile this device joined, so it stops autoconnecting to it.
#
# The privileged half of a factory reset. Deleting /data/config.json is not enough on its own:
# wifi-apply.sh only ever *writes* the profile, so with no SSID left to apply it exits early
# and NetworkManager keeps the old one — autoconnect yes, priority 10. The device would come
# back up online, and `NetworkSupervisor` only raises the hotspot for a device that is offline.
#
# Scoped to the profile bloopbox itself manages. Anything the imager seeded is left alone: it
# is not ours to delete, and on a device built with --wifi-ssid it is the network the owner
# deliberately baked in. That device rejoins after a reset instead of offering a hotspot, and
# is re-onboarded over the network it is already on.
forget_network() {
  if [[ "$(nmcli -t -f NAME con show 2>/dev/null | awk -v n="${CONNECTION_NAME}" '$0==n{print "yes"; exit}')" != yes ]]; then
    log "no ${CONNECTION_NAME} profile to forget"
    return 0
  fi
  nmcli con down "${CONNECTION_NAME}" >/dev/null 2>&1
  if nmcli con delete "${CONNECTION_NAME}" >/dev/null 2>&1; then
    log "forgot ${CONNECTION_NAME}"
    LAST_ERROR=
  else
    log "could not delete ${CONNECTION_NAME}"
    LAST_ERROR="could not forget the saved network — check journalctl -u NetworkManager"
    return 1
  fi
}

# True once the radio is actually on `ssid`. NetworkManager only says `connected` after the
# device has an address, which is the same bar the poll loop below uses for `online` — so this
# answers "did it work" the way the rest of the file already means it.
joined_ssid() {
  local want="$1" state current
  state="$(nmcli -t -f TYPE,STATE dev status 2>/dev/null | awk -F: '$1=="wifi"{print $2; exit}')"
  [[ "${state}" == "connected" ]] || return 1
  current="$(nmcli --escape yes -t -f active,ssid dev wifi 2>/dev/null | awk -F: '$1=="yes"{print $2; exit}')"
  # -t escapes a colon inside an SSID as `\:`; undo that before comparing with the raw one.
  current="${current//\\:/:}"
  [[ "${current}" == "${want}" ]]
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
    # Same trap as ap_up: an open network needs the security setting *gone*, not set to
    # `none`, which NetworkManager reads as WEP and then fails for want of a key.
    nmcli con modify "${CONNECTION_NAME}" remove 802-11-wireless-security >/dev/null 2>&1
  fi

  # The hotspot has to go before the join can be attempted: one radio.
  nmcli con down "${AP_CONNECTION}" >/dev/null 2>&1

  # Started, then judged by the outcome — deliberately not `if nmcli con up ...`.
  #
  # `wifi-apply.sh` runs from the hardware unit's ExecStartPre, and the config save that
  # produced this join restarts that unit, so both activate *this same profile* within a
  # second or two of each other. NetworkManager cancels whichever loses with
  # `reason 'new-activation'`, and that one exits non-zero even though the device ends up
  # online. Observed on hardware 2026-08-10, where it told a parent that a correct passphrase
  # was wrong — on the only screen this product has. The end state is the trustworthy answer.
  #
  # `--wait 5` keeps the call from blocking the poll loop for nmcli's 90s default; activation
  # carries on afterwards and the loop below is what actually decides.
  nmcli --wait 5 con up "${CONNECTION_NAME}" >/dev/null 2>&1 || true

  local waited=0
  while [[ "${waited}" -lt "${JOIN_CONFIRM_SECONDS}" ]]; do
    if joined_ssid "${ssid}"; then
      log "joined ${ssid}"
      LAST_ERROR=
      return 0
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done

  # Reported, not retried here. The supervisor raises the hotspot again after its grace
  # period, and the portal reads this line to explain what went wrong.
  log "could not join ${ssid}"
  LAST_ERROR="could not join ${ssid} — wrong passphrase, or out of range"
  return 1
}

# Restarts or halts the machine, asked for from the admin panel's diagnostics card.
#
# `systemctl` rather than `reboot`/`halt` directly, so systemd stops the two daemons the ordinary
# way: the hardware server's SIGTERM handler flushes the stats file, closes the HAL and leaves
# every LED off (see its `shutdown`). Never `--force` — that is the one that skips exactly those
# steps, which on this device means an unread note's file is the thing left half-written.
#
# Backgrounded after a short pause so this script can finish the poll it is in and the admin
# panel's HTTP response can reach the browser before its network goes away.
power_action() {
  local what="$1"
  log "${what} requested from the admin panel"
  (
    sleep 2
    case "${what}" in
      reboot) systemctl reboot ;;
      poweroff) systemctl poweroff ;;
    esac
  ) >/dev/null 2>&1 &
}

# The id of the last request acted on. Loaded once; kept in step with HANDLED_FILE.
HANDLED_ID=
if [[ -r "${HANDLED_FILE}" ]]; then
  HANDLED_ID="$(head -c 80 "${HANDLED_FILE}" | tr -cd 'A-Za-z0-9-')"
fi

# Reads one request and acts on it, once. Unknown actions are logged and dropped: this is the
# privilege boundary, so the allowlist is the whole security model.
consume_request() {
  [[ -e "${REQUEST_FILE}" ]] || return 0
  local id='' action='' ssid='' psk=''
  local -a parsed=()
  if [[ ! -x "${NODE}" ]]; then
    log "no node at ${NODE} — cannot read requests"
    return 0
  fi
  # Four lines out, never eval'd: id, action, ssid, psk. The action is matched against a fixed
  # list below; ssid and psk only ever become arguments to nmcli.
  #
  # Opened without following a symlink and without blocking, then checked to be a small regular
  # file: the directory belongs to the daemon, which serves the open setup hotspot, and root
  # reading whatever it was pointed at — or hanging forever on a FIFO — must not be one bug away.
  #
  # A request with no id (a hand-written one, or bloopbox-hotspot-test from an older release) is
  # named by a hash of its content, so it too runs once rather than on every poll.
  mapfile -t parsed < <("${NODE}" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const line = (value) => String(value ?? "").split("\n")[0] ?? "";
    const blank = () => { for (let i = 0; i < 4; i++) console.log(""); };
    try {
      const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
      const fd = fs.openSync(process.argv[1], O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      let raw;
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size > 4096) { blank(); process.exit(0); }
        raw = fs.readFileSync(fd, "utf8");
      } finally { fs.closeSync(fd); }
      const parsed = JSON.parse(raw);
      const given = typeof parsed?.id === "string" ? parsed.id : "";
      const id = /^[A-Za-z0-9-]{1,64}$/.test(given)
        ? given
        : "sha-" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
      const action = typeof parsed?.action === "string" ? parsed.action : "";
      console.log(id);
      console.log(/^[a-z-]{1,16}$/.test(action) ? action : "");
      console.log(line(parsed?.ssid).slice(0, 32));
      // 8-63 characters is a passphrase; exactly 64 hex characters is the raw PSK itself,
      // which NetworkManager takes as well. Truncating that to 63 made it a wrong passphrase.
      const psk = line(parsed?.psk);
      console.log(/^[0-9A-Fa-f]{64}$/.test(psk) ? psk : psk.slice(0, 63));
    } catch { blank(); }
  ' "${REQUEST_FILE}" 2>/dev/null)
  id="${parsed[0]:-}"
  action="${parsed[1]:-}"
  ssid="${parsed[2]:-}"
  psk="${parsed[3]:-}"

  # Unreadable, not a regular file, or not JSON: nothing to name, so nothing to do until the
  # daemon's next write replaces it.
  [[ -n "${id}" ]] || return 0
  # Already done. The daemon deletes the file once it reads the acknowledgement below.
  [[ "${id}" != "${HANDLED_ID}" ]] || return 0

  # Recorded before acting, not after: a join takes seconds, and an agent restarted mid-join
  # must not run it a second time.
  HANDLED_ID="${id}"
  printf '%s\n' "${id}" > "${HANDLED_FILE}.tmp" && mv -f "${HANDLED_FILE}.tmp" "${HANDLED_FILE}"

  case "${action}" in
    ap-up) ap_up ;;
    ap-down) ap_down ;;
    join) join_network "${ssid}" "${psk}" ;;
    forget) forget_network ;;
    reboot) power_action reboot ;;
    poweroff) power_action poweroff ;;
    # Empty means the file was there but held nothing this script is willing to act on —
    # unparseable, the wrong shape, or an action outside the allowlist. Worth a line: silence
    # here would make a daemon asking for something impossible look like a daemon asking for
    # nothing. The action itself is not echoed; it is untrusted input.
    "") log "dropped a request that carried no usable action" ;;
    *) log "ignoring unknown request: ${action}" ;;
  esac
}

log() { echo "net-agent: $*"; }

# cfg80211 refuses to let the radio transmit — not just "join a network", *scan* included —
# until something has told it a regulatory domain. `scripts/build-sd-image.sh` only calls
# `raspi-config nonint do_wifi_country` when a Wi-Fi SSID was supplied at build time, so an
# image built with none (the onboarding case this whole file exists for) leaves the country
# unset forever. Found on real hardware 2026-08-10: with no country ever set, `wlan0` read as
# `unavailable` rather than `disconnected` — `rfkill list` showed the wifi radio soft-blocked,
# `iw reg get` read `country 00: DFS-UNSET`, and NetworkManager's own `WirelessEnabled` toggle
# was independently `false` on top of that. All three block scanning as well as the hotspot,
# so this runs once at startup, before the main loop's first publish — not only inside ap_up.
#
# Never overwrites a domain that is already set: "00" is cfg80211's own placeholder for
# "nobody has said yet", and a device already told where it lives should never be silently
# relocated to AP_COUNTRY.
ensure_radio_unblocked() {
  command -v rfkill >/dev/null 2>&1 && rfkill unblock wifi >/dev/null 2>&1
  nmcli radio wifi on >/dev/null 2>&1

  command -v iw >/dev/null 2>&1 || return 0
  local domain
  domain="$(iw reg get 2>/dev/null | awk '/^country/{print $2; exit}' | tr -d ':')"
  if [[ -z "${domain}" || "${domain}" == "00" ]]; then
    if iw reg set "${AP_COUNTRY}" >/dev/null 2>&1; then
      log "no regulatory domain was set — defaulted to ${AP_COUNTRY}"
    else
      log "no regulatory domain was set, and could not default to ${AP_COUNTRY}"
    fi
  fi
}

ensure_radio_unblocked

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

# The acknowledgement published with every reading: the id of the last request acted on.
handled_json() {
  if [[ -n "${HANDLED_ID}" ]]; then json_string "${HANDLED_ID}"; else printf 'null'; fi
}

# The control characters JSON forbids raw inside a string, each beside its \u escape. Built
# once rather than per call. U+0001 to U+001F only: NUL cannot be held in a bash string at all,
# so it never reaches json_string.
JSON_CONTROL_CHARS=()
JSON_CONTROL_ESCAPES=()
for code in {1..31}; do
  # printf -v, not $(...): command substitution strips a trailing newline, which would turn
  # U+000A into an empty pattern.
  printf -v char '%b' "\\0$(printf '%03o' "${code}")"
  printf -v escape '\\u%04x' "${code}"
  JSON_CONTROL_CHARS+=("${char}")
  JSON_CONTROL_ESCAPES+=("${escape}")
done
unset code char escape

# A JSON string literal for any value bash can hold.
#
# Not just `\` and `"`, and this is not pedantry. An SSID is arbitrary bytes chosen by whoever
# owns the router next door, and the scan list publishes every one in range. A single raw tab or
# newline in one of them used to make the whole of net-state.json unparseable, which the daemon
# reads as "unknown" — and unknown never raises the setup hotspot. A stranger's router name
# could switch off this device's only recovery path. scripts/test-onboarding.sh scans an SSID
# with a tab in it to keep this true.
#
# Bytes that are not valid UTF-8 are passed through: the daemon decodes the file as UTF-8,
# which turns them into U+FFFD rather than failing the parse.
json_string() {
  local value="$1" i
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  for i in "${!JSON_CONTROL_CHARS[@]}"; do
    # Replacement quoted: bash 5.2's patsub_replacement gives an unquoted one's backslashes
    # and ampersands meaning.
    value="${value//"${JSON_CONTROL_CHARS[i]}"/"${JSON_CONTROL_ESCAPES[i]}"}"
  done
  printf '"%s"' "${value}"
}

# Whether the wall clock has been set from the network, as a JSON literal: true, false, or null
# for "cannot tell".
#
# A Pi has no real-time clock. Until NTP answers, it boots with the time the last shutdown saved
# (fake-hwclock / timesyncd's clock file) — hours or days behind after a spell unplugged — and
# quiet hours, the purge TTL and debug mode's deadline all read that clock. Published so the
# daemon can at least say so; what quiet hours should *do* about it is an open product decision
# (PENDING.md).
#
# Asked through timedatectl, which is a D-Bus call to systemd-timedated — a process activated on
# demand — so it is refreshed on a slow cadence of its own, not every poll. null rather than false
# when the tool or the answer is missing: unknown is not the same as unsynced.
TIME_SYNC_INTERVAL_SECONDS="${NET_TIME_SYNC_INTERVAL_SECONDS:-30}"
TIME_SYNCED_JSON=null
TIME_SYNC_AT=0

refresh_time_synced() {
  local now elapsed
  now="$(date +%s)"
  elapsed=$(( now - TIME_SYNC_AT ))
  # A negative gap is the clock itself being corrected backwards — the very event this reports
  # on. Without this the next refresh would wait until the wall clock caught back up.
  (( elapsed >= 0 && elapsed < TIME_SYNC_INTERVAL_SECONDS )) && return 0
  TIME_SYNC_AT="${now}"
  if ! command -v timedatectl >/dev/null 2>&1; then
    TIME_SYNCED_JSON=null
    return 0
  fi
  case "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" in
    yes) TIME_SYNCED_JSON=true ;;
    no) TIME_SYNCED_JSON=false ;;
    *) TIME_SYNCED_JSON=null ;;
  esac
}

# Initialised before either loop below can assign to it: the no-nmcli branch also consumes
# requests now, and some of the handlers set this.
LAST_ERROR=

if ! command -v nmcli >/dev/null 2>&1; then
  # Publish once, then idle. Reporting "no information" is materially different from not
  # running: the daemon distinguishes them, and only this one keeps the LEDs quiet.
  log "no nmcli on PATH — publishing an empty reading and idling"
  while [[ "${running}" == true ]]; do
    # Still read, because reboot and poweroff do not need NetworkManager and a box that cannot
    # be shut down from the panel is exactly the box somebody unplugs mid-write.
    consume_request
    # The clock has nothing to do with NetworkManager, so it is still worth reporting here.
    refresh_time_synced
    publish "{\"version\":1,\"updatedAtMs\":$(now_ms),\"available\":false,\"online\":false,\"ssid\":null,\"signal\":null,\"apActive\":false,\"apSsid\":null,\"scan\":[],\"scanAgeSeconds\":0,\"lastError\":null,\"handledRequestId\":$(handled_json),\"timeSynced\":${TIME_SYNCED_JSON}}"
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

  # Whether we are hosting comes first, and not for tidiness: the scan below is guarded on
  # it, and a guard reading last time round's answer would rescan on the very first poll of
  # an agent that started while the hotspot was already up — which is a rescan on an
  # interface in AP mode, the one thing this radio cannot do.
  #
  # In AP mode the radio is "connected" to a network it is itself hosting, which is not being
  # online. The profile name is the reliable tell.
  active_profiles="$(nmcli -t -f NAME,TYPE con show --active 2>/dev/null)"
  [[ "${active_profiles}" == *"${AP_CONNECTION}:"* ]] && ap_active=true

  # The list captured just before the hotspot went up is the one the portal should show.
  if [[ "${ap_active}" != true && $(( $(date +%s) - SCAN_AT )) -ge "${SCAN_INTERVAL_SECONDS}" ]]; then
    refresh_scan yes
  fi

  if [[ "${ap_active}" != true ]]; then
    # The associated AP, if any: `active:ssid:signal`, one line per network in the last scan.
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

  # Zero when nothing has been scanned yet, not epoch-minus-nothing: an age of 1.7 billion
  # seconds beside an empty list is a puzzle, and the empty list already says everything.
  if [[ "${SCAN_AT}" -eq 0 ]]; then
    scan_age=0
  else
    scan_age=$(( $(date +%s) - SCAN_AT ))
  fi

  refresh_time_synced

  publish "{\"version\":1,\"updatedAtMs\":$(now_ms),\"available\":true,\"online\":${online},\"ssid\":${ssid_json},\"signal\":${signal},\"apActive\":${ap_active},\"apSsid\":$(json_string "${AP_SSID}"),\"scan\":${SCAN_JSON},\"scanAgeSeconds\":${scan_age},\"lastError\":${last_error_json},\"handledRequestId\":$(handled_json),\"timeSynced\":${TIME_SYNCED_JSON}}"

  # Backgrounded so a SIGTERM lands during the sleep rather than after it.
  sleep "${POLL_SECONDS}" &
  wait $! 2>/dev/null || true
done

log "stopped"
exit 0
