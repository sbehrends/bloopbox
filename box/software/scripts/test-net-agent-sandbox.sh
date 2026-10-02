#!/usr/bin/env bash
#
# Runs the shipped net agent under its unit's own sandbox, as a transient systemd service, and
# checks that it can still do its job:
#
#   sudo ./scripts/test-net-agent-sandbox.sh
#
# Needs root, a running systemd and `node` on PATH. CI runs it on a hosted runner; a dev machine
# can run it in a systemd container.
#
# Why this exists: test-onboarding.sh runs the agent in a container with no systemd, so no
# sandbox. Under ProtectSystem=strict the agent could not write to the daemon's /run/bloopbox,
# could therefore never delete a request it had handled, and re-ran the same request on every
# poll. Every container test passed. It was found on the bench (review finding 0.8). This runs
# the same script under the same properties, read from bloopbox-net.service itself so the two
# cannot drift, and fails if the agent hits a read-only filesystem anywhere.
#
# The one property added is ReadWritePaths for the fake nmcli's own state directory: the fake
# stands in for NetworkManager, which on a device is a separate, unsandboxed process.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_FILE="${REPO_ROOT}/deploy/systemd/bloopbox-net.service"
UNIT_NAME="bloopbox-net-sandbox-test"

# Outside $HOME on purpose: the unit says ProtectHome=yes, and a CI checkout lives in /home.
STAGE="/opt/bloopbox-sandbox-test"
FAKE_NM_DIR="/run/fake-nm"
DAEMON_DIR="/run/bloopbox"
STATE_DIR="/run/bloopbox-net"
REQUEST_FILE="${DAEMON_DIR}/net-request.json"
STATE_FILE="${STATE_DIR}/net-state.json"

[[ "$(id -u)" == 0 ]] || { echo "error: run as root (the agent is root on the device)" >&2; exit 1; }
command -v systemd-run >/dev/null || { echo "error: needs systemd" >&2; exit 1; }
NODE_BIN="$(command -v node)" || { echo "error: needs node on PATH" >&2; exit 1; }

cleanup() {
  systemctl stop "${UNIT_NAME}" >/dev/null 2>&1 || true
  systemctl reset-failed "${UNIT_NAME}" >/dev/null 2>&1 || true
  rm -rf "${STAGE}" "${FAKE_NM_DIR}" "${STATE_DIR}"
  rm -f "${REQUEST_FILE}"
}
trap cleanup EXIT

# This run's journal only: the unit name is reused, and an earlier run's lines must not count.
INVOCATION=
journal() {
  if [[ -n "${INVOCATION}" ]]; then
    journalctl "_SYSTEMD_INVOCATION_ID=${INVOCATION}" --no-pager "$@"
  else
    journalctl -u "${UNIT_NAME}" --no-pager -n 40 "$@"
  fi
}

fail() {
  echo
  echo "FAIL: $*"
  echo "--- agent journal ---"
  journal || true
  echo "--- nmcli calls ---"
  cat "${FAKE_NM_DIR}/calls.log" 2>/dev/null || true
  exit 1
}

# Polls rather than sleeps: the agent publishes on its own cadence.
await() {
  local label="$1"
  shift
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  fail "timed out waiting for ${label}"
}

state_says() {
  "${NODE_BIN}" -e '
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.exit(String(s[process.argv[2]]) === process.argv[3] ? 0 : 1);
  ' "${STATE_FILE}" "$1" "$2"
}

times_called() { grep -cF "$1" "${FAKE_NM_DIR}/calls.log" || true; }

# The sandbox, straight from the unit: every [Service] setting except how it starts and restarts.
PROPERTIES=()
section=
while IFS= read -r line; do
  case "${line}" in
    '[Service]') section=service ;;
    '['*) section= ;;
    '' | '#'*) ;;
    *)
      [[ "${section}" == service ]] || continue
      case "${line%%=*}" in
        Type | ExecStart* | Restart* | StartLimit*) ;;
        *) PROPERTIES+=("${line}") ;;
      esac
      ;;
  esac
done <"${UNIT_FILE}"
[[ " ${PROPERTIES[*]} " == *" ProtectSystem=strict "* ]] \
  || fail "read no ProtectSystem=strict from ${UNIT_FILE}; the parser and the unit disagree"
SANDBOX=()
for property in "${PROPERTIES[@]}"; do SANDBOX+=(--property "${property}"); done

echo "==> net agent under its unit's sandbox"
printf '    %s\n' "${PROPERTIES[@]}"
echo

cleanup
install -d -m 0755 "${STAGE}/deploy" "${STAGE}/bin"
install -m 0755 "${REPO_ROOT}/deploy/net-agent.sh" "${STAGE}/deploy/net-agent.sh"
install -m 0755 "${REPO_ROOT}/packaging/fake-nmcli.sh" "${STAGE}/bin/nmcli"
install -d -m 0755 "${FAKE_NM_DIR}"
printf 'HomeNet:82:WPA2\nCafe:30:\n' >"${FAKE_NM_DIR}/ssids"
# The daemon's runtime directory, owned by somebody other than root, as it is on the device.
install -d -o nobody -m 0755 "${DAEMON_DIR}"

systemd-run --quiet --unit "${UNIT_NAME}" \
  "${SANDBOX[@]}" \
  --property "ReadWritePaths=${FAKE_NM_DIR}" \
  --setenv "PATH=${STAGE}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  --setenv "NODE_BIN=${NODE_BIN}" \
  --setenv "FAKE_NM_DIR=${FAKE_NM_DIR}" \
  --setenv NET_AGENT_POLL_SECONDS=1 \
  --setenv NET_SCAN_INTERVAL_SECONDS=1 \
  "${STAGE}/deploy/net-agent.sh"
INVOCATION="$(systemctl show --property InvocationID --value "${UNIT_NAME}")"

echo "--- 1. it publishes a reading from inside the sandbox ---"
await "net-state.json" test -f "${STATE_FILE}"
await "a reading that says the agent is alive" state_says available true
echo "net-state.json: $(cat "${STATE_FILE}")"

echo
echo "--- 2. a request from the daemon runs once and is acknowledged ---"
# Written the way the daemon writes it: atomically, by the daemon's own user.
REQUEST='{"action":"ap-up","id":"sandbox-1"}'
runuser -u nobody -- sh -c "printf '%s\n' '${REQUEST}' > '${REQUEST_FILE}.tmp' && mv '${REQUEST_FILE}.tmp' '${REQUEST_FILE}'"
await "the acknowledgement" state_says handledRequestId sandbox-1
await "apActive" state_says apActive true
sleep 3
[[ "$(times_called "802-11-wireless.mode ap")" == 1 ]] \
  || fail "the agent ran the same request $(times_called "802-11-wireless.mode ap") times"
echo "ap-up ran once and was acknowledged"

echo
echo "--- 3. nothing it did hit the read-only filesystem ---"
JOURNAL="$(journal -o cat 2>&1 || true)"
case "${JOURNAL}" in
  *"Read-only file system"* | *"Permission denied"*) fail "the sandbox refused something the agent needs" ;;
esac
systemctl is-active --quiet "${UNIT_NAME}" || fail "the agent is no longer running"
echo "no sandbox refusals in the journal, and the agent is still up"

echo
echo "==> net agent sandbox test passed"
