#!/usr/bin/env bash
#
# Exercises first-boot onboarding against a built release, inside a bare arm64 Trixie
# container:
#
#   ./scripts/test-onboarding.sh [path/to/bloopbox-x.y.z-linux-arm64.tar.gz]
#
# The flow a parent meets on a device that has never seen a network — hotspot up, portal
# served, pick a network, join — is the one path that cannot be reached from a laptop and
# cannot be reached over the network it is trying to configure. Until this existed, none of
# it had run anywhere.
#
# It runs for real: the shipped net-agent.sh, the shipped units, the shipped daemon, the
# shipped portal. The single substitution is `nmcli` (packaging/fake-nmcli.sh), because a
# container has no radio and no NetworkManager. The agent cannot tell, so its own logic —
# what it publishes, what it consumes, what it asks nmcli for — is genuinely under test.
#
# What this does NOT cover, and no container can: whether a Pi's radio hosts an AP at all,
# whether NetworkManager accepts these arguments, whether DHCP hands out a lease, whether a
# phone's captive-portal probe fires, and whether a thumb can complete the flow on a phone
# screen. That is hardware bring-up — docs/hardware-bringup.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# shellcheck source=../packaging/versions.env
source packaging/versions.env

ARTIFACT="${1:-}"
if [[ -z "${ARTIFACT}" ]]; then
  ARTIFACT="$(ls -t release/bloopbox-*-linux-"${TARGET_ARCH}".tar.gz 2>/dev/null | head -1 || true)"
fi
[[ -n "${ARTIFACT}" && -f "${ARTIFACT}" ]] \
  || { echo "error: no release tarball found — run ./scripts/build-release.sh first" >&2; exit 1; }

echo "==> onboarding test against $(basename "${ARTIFACT}")"
echo "    image     ${RUNTIME_IMAGE}"
echo "    platform  ${TARGET_PLATFORM}"
echo

docker run --rm \
  --platform "${TARGET_PLATFORM}" \
  --volume "${REPO_ROOT}/$(dirname "${ARTIFACT}")":/artifacts:ro \
  --volume "${REPO_ROOT}/packaging/fake-nmcli.sh":/usr/local/bin/nmcli:ro \
  --env "ARTIFACT=$(basename "${ARTIFACT}")" \
  --env "RUNTIME_PACKAGES=${RUNTIME_PACKAGES}" \
  "${RUNTIME_IMAGE}" \
  bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ${RUNTIME_PACKAGES} curl >/dev/null

    mkdir -p /opt/staging && cd /opt/staging
    tar xzf "/artifacts/${ARTIFACT}"
    cd bloopbox-*-linux-*
    ./install.sh --skip-deps --no-boot-config >/dev/null
    echo "installed $(ls -d /opt/bloopbox >/dev/null && echo ok)"

    fail() { echo; echo "FAIL: $*"; echo "--- agent ---"; tail -30 /tmp/agent.log 2>/dev/null; echo "--- server ---"; tail -30 /tmp/server.log 2>/dev/null; exit 1; }
    # Polls rather than sleeps: the agent publishes on its own cadence, and a fixed wait is
    # either slower than it needs to be or flaky under load.
    await() {
      local label="$1"; shift
      for _ in $(seq 1 60); do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 0.5
      done
      fail "timed out waiting for ${label}"
    }
    state_says() {
      /opt/bloopbox/node/bin/node -e "
        const s = JSON.parse(require(\"node:fs\").readFileSync(\"/run/bloopbox-net/net-state.json\",\"utf8\"));
        process.exit(String(s[process.argv[1]]) === process.argv[2] ? 0 : 1);
      " "$1" "$2"
    }
    called() { grep -qF "$1" /run/fake-nm/calls.log; }
    # Captured, then matched: `curl | grep -q` under pipefail fails when grep exits first.
    status_says() {
      case "$(curl -fsS --max-time 2 http://127.0.0.1:3000/api/status)" in
        *"$1"*) return 0 ;;
        *) return 1 ;;
      esac
    }
    # How many times the agent asked nmcli for something. Read from the file, not a pipe.
    times_called() { grep -cF "$1" /run/fake-nm/calls.log || true; }
    acknowledged() {
      /opt/bloopbox/node/bin/node -e "
        const s = JSON.parse(require(\"node:fs\").readFileSync(\"/run/bloopbox-net/net-state.json\",\"utf8\"));
        process.exit(typeof s.handledRequestId === \"string\" && s.handledRequestId.length > 0 ? 0 : 1);
      "
    }

    # The room the fake radio finds. One neighbour has a tab in its SSID: SSIDs are arbitrary
    # bytes chosen by strangers, and a raw control character once made the whole state file
    # unparseable — which the daemon reads as "unknown", and unknown never raises the hotspot.
    mkdir -p /run/fake-nm
    printf "HomeNet:82:WPA2\nTab\tNeighbour:41:WPA2\nCafe:30:\n" > /run/fake-nm/ssids

    echo
    echo "--- 1. the root agent comes up and publishes a reading ---"
    # Exactly as bloopbox-net.service starts it.
    NET_AGENT_POLL_SECONDS=1 NET_SCAN_INTERVAL_SECONDS=1 \
      /opt/bloopbox/deploy/net-agent.sh > /tmp/agent.log 2>&1 &
    AGENT_PID=$!
    await "net-state.json" test -f /run/bloopbox-net/net-state.json
    await "a reading that says the agent is alive" state_says available true
    echo "net-state.json: $(cat /run/bloopbox-net/net-state.json)"
    # Always published, as true, false or null. A container has no timedated to ask, so null
    # (cannot tell) is the honest answer here — and false would be a lie.
    /opt/bloopbox/node/bin/node -e "
      const s = JSON.parse(require(\"node:fs\").readFileSync(\"/run/bloopbox-net/net-state.json\",\"utf8\"));
      process.exit(\"timeSynced\" in s && (s.timeSynced === null || typeof s.timeSynced === \"boolean\") ? 0 : 1);
    " || fail "the reading carries no timeSynced"
    echo "timeSynced is published"

    echo
    echo "--- 2. it scans, so the portal has something to offer ---"
    await "a scan list" bash -c "grep -q HomeNet /run/bloopbox-net/net-state.json"
    echo "scan reached the state file"
    # Parsed, not grepped: the failure this guards against is a file that is not JSON at all.
    /opt/bloopbox/node/bin/node -e "
      const s = JSON.parse(require(\"node:fs\").readFileSync(\"/run/bloopbox-net/net-state.json\",\"utf8\"));
      process.exit(s.scan.some((n) => n.ssid === \"Tab\tNeighbour\") ? 0 : 1);
    " || fail "an SSID with a tab in it did not survive into valid JSON: $(cat /run/bloopbox-net/net-state.json)"
    echo "an SSID with a control character is escaped, and the file still parses"

    echo
    echo "--- 3. ap-up raises the hotspot ---"
    mkdir -p /run/bloopbox
    echo "{\"action\":\"ap-up\"}" > /run/bloopbox/net-request.json
    await "apActive" state_says apActive true
    called "802-11-wireless.mode ap" || fail "the AP profile was not put into ap mode"
    called "ipv4.method shared" || fail "the AP profile did not use NetworkManager shared mode (no DHCP for the phone)"
    echo "hotspot up, and asked for ap mode + shared ipv4"

    echo
    echo "--- 3b. the request runs once, and is acknowledged rather than deleted ---"
    # On a device the agent cannot delete this file: the runtime directory of the daemon is read-only
    # to it under ProtectSystem=strict. A request that ran again on every poll would bounce the
    # radio every five seconds, so absence of a repeat is the thing to prove — which takes a
    # wait of a few polls, not a condition.
    await "an acknowledgement" acknowledged
    sleep 3
    [[ "$(times_called "802-11-wireless.mode ap")" == 1 ]] \
      || fail "the agent ran the same ap-up more than once: $(times_called "802-11-wireless.mode ap") times"
    echo "ap-up ran once; acknowledged as $(/opt/bloopbox/node/bin/node -p "JSON.parse(require(\"node:fs\").readFileSync(\"/run/bloopbox-net/net-state.json\",\"utf8\")).handledRequestId")"

    echo
    echo "--- 4. the daemon sees the hotspot and offers setup ---"
    set -a; . /etc/bloopbox/environment; set +a
    export HAL_DRIVER=mock RECORDING_DIR=/run/bloopbox PORTAL_PORT=8080
    cd /opt/bloopbox
    ./node/bin/node dist/processes/hardware-server.js > /tmp/server.log 2>&1 &
    SERVER_PID=$!
    await "the API" curl -fsS --max-time 2 http://127.0.0.1:3000/api/status
    # Polled, not read once: the boot chase is held for BOOT_ANIMATION_MS before real status
    # is allowed through, so an immediate read always says BOOTING.
    await "the setup rung" status_says SETUP_PORTAL
    echo "GET /api/status -> $(curl -fsS http://127.0.0.1:3000/api/status)"
    echo "the LED ladder is on the setup rung"

    echo
    echo "--- 5. the portal is served, and offers the networks the agent found ---"
    PORTAL_HTML="$(curl -fsS --max-time 5 http://127.0.0.1:8080/portal/ || true)"
    case "${PORTAL_HTML}" in
      *"<html"* | *"<HTML"*) : ;;
      *) fail "the portal is not being served on the captive-portal port" ;;
    esac
    SCAN="$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/wifi/scan)"
    echo "GET /api/wifi/scan -> ${SCAN}"
    case "${SCAN}" in
      *HomeNet*) : ;;
      *) fail "the portal would show an empty network list" ;;
    esac

    echo
    echo "--- 6. a phone probing for a captive portal is redirected ---"
    PROBE="$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" --max-time 5 http://127.0.0.1:3000/generate_204)"
    echo "GET /generate_204 -> ${PROBE}"
    case "${PROBE}" in
      302*) echo "probe redirected to the portal" ;;
      *) fail "a phone would see no captive portal (got: ${PROBE})" ;;
    esac

    echo
    echo "--- 7. setup refuses to finish without a password for the panel ---"
    # Network and password are one step on an unconfigured device, deliberately: the hotspot
    # is open, so a join that did not set a password would leave the settings API reachable
    # by anyone in range of the house.
    NOPASS="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -X POST \
      http://127.0.0.1:3000/api/wifi/join -H "content-type: application/json" \
      -d "{\"ssid\":\"HomeNet\",\"psk\":\"correct-horse\"}")"
    [[ "${NOPASS}" == 400 ]] || fail "a join with no admin password should be refused, got ${NOPASS}"
    echo "POST /api/wifi/join without a password -> 400, as it should be"

    echo
    echo "--- 8. joining from the portal reaches the agent and the hotspot stands down ---"
    JOIN="$(curl -fsS --max-time 10 -X POST http://127.0.0.1:3000/api/wifi/join \
      -H "content-type: application/json" \
      -d "{\"ssid\":\"HomeNet\",\"psk\":\"correct-horse\",\"adminPassword\":\"parent-secret\"}" || true)"
    echo "POST /api/wifi/join -> ${JOIN}"
    # Parsed rather than pattern-matched: the JSON is full of quotes and this whole script is
    # already inside a single-quoted docker argument.
    /opt/bloopbox/node/bin/node -e "
      const body = JSON.parse(process.argv[1]);
      process.exit(body.ok === true && body.handedToAgent === true ? 0 : 1);
    " "${JOIN}" || fail "the join was not accepted, or never reached the agent: ${JOIN}"
    # The daemon exits here on purpose — a config write restarts it so the new values apply.
    # systemd brings it back on the device; nothing does in this container, and nothing below
    # needs it.
    await "the join to reach nmcli" called "802-11-wireless.ssid HomeNet"
    called "wifi-sec.psk" || fail "the passphrase never reached the profile"
    await "the hotspot to stand down" state_says apActive false
    await "the device to come online" state_says online true
    echo "joined: $(cat /run/bloopbox-net/net-state.json)"
    sleep 3
    [[ "$(times_called "802-11-wireless.ssid HomeNet")" == 1 ]] \
      || fail "the join ran more than once: $(times_called "802-11-wireless.ssid HomeNet") times"
    echo "the join ran once"

    echo
    echo "--- 9. a raw 64-hex PSK reaches the profile whole ---"
    # 8-63 characters is a passphrase; exactly 64 hex characters is the key itself. The agent
    # used to cut every psk at 63, which turned a correct raw key into a wrong passphrase.
    RAW_PSK="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    echo "{\"action\":\"join\",\"ssid\":\"HomeNet\",\"psk\":\"${RAW_PSK}\",\"id\":\"raw-psk-1\"}" \
      > /run/bloopbox/net-request.json
    await "the raw PSK to reach nmcli intact" called "wifi-sec.psk ${RAW_PSK}"
    echo "all 64 characters arrived"

    kill "${SERVER_PID}" "${AGENT_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" "${AGENT_PID}" 2>/dev/null || true

    echo
    echo "--- nmcli calls the agent made ---"
    cat /run/fake-nm/calls.log
  '

echo
echo "==> onboarding test passed"
