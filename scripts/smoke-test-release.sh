#!/usr/bin/env bash
#
# Runs a built release inside a bare arm64 Debian Trixie container — no Node, no npm, no
# toolchain, nothing the device would not have — and checks that it actually comes up:
#
#   ./scripts/smoke-test-release.sh [path/to/bloopbox-x.y.z-linux-arm64.tar.gz]
#
# What this catches that the build cannot: a missing runtime apt package, a node binary
# that will not execute outside its build image, an installer that assumes a systemd it
# does not have, an asset path that only resolves in the source tree.
#
# What it deliberately does not cover: real GPIO, real ALSA devices and a real WhatsApp
# account. The container runs the mock HAL, so this is a packaging test, not hardware
# bring-up. See PENDING.md.
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

echo "==> smoke testing $(basename "${ARTIFACT}")"
echo "    image     ${RUNTIME_IMAGE}"
echo "    platform  ${TARGET_PLATFORM}"
echo

# The container runs the installer for real (as root, with systemd absent), then starts the
# hardware server the way the unit file would and asks the API whether it is alive.
docker run --rm \
  --platform "${TARGET_PLATFORM}" \
  --volume "${REPO_ROOT}/$(dirname "${ARTIFACT}")":/artifacts:ro \
  --env "ARTIFACT=$(basename "${ARTIFACT}")" \
  --env "RUNTIME_PACKAGES=${RUNTIME_PACKAGES}" \
  "${RUNTIME_IMAGE}" \
  bash -euo pipefail -c '
    echo "--- installing runtime packages (as the device would) ---"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ${RUNTIME_PACKAGES} curl >/dev/null
    echo "ffmpeg $(ffmpeg -version | head -1 | cut -d" " -f3), libgpiod $(dpkg-query -W -f=\${Version} libgpiod3)"

    echo
    echo "--- unpacking ---"
    mkdir -p /opt/staging && cd /opt/staging
    tar xzf "/artifacts/${ARTIFACT}"
    cd bloopbox-*-linux-*

    echo
    echo "--- running install.sh (no systemd in here, so it enables without starting) ---"
    ./install.sh --skip-deps --no-boot-config

    echo
    echo "--- doctor ---"
    # From / on purpose: that is where a parent runs `sudo bloopbox-doctor` from, and
    # a check that resolves node modules against the caller'"'"'s directory passes from inside
    # the unpacked tarball while failing everywhere else.
    DOCTOR_OUTPUT="$( cd / && /usr/local/bin/bloopbox-doctor 2>&1 || true )"
    echo "${DOCTOR_OUTPUT}"
    # Captured rather than piped into grep -q: an early-exiting grep SIGPIPEs doctor, and
    # pipefail then turns a passing check into a failing one.
    case "${DOCTOR_OUTPUT}" in
      *"opengpio addon"*loads*) echo "(doctor verified the addon from outside the app directory)" ;;
      *) echo "FAIL: doctor cannot verify the opengpio addon from outside the app directory"; exit 1 ;;
    esac

    echo
    echo "--- booting the hardware server ---"
    # Same command and environment as the unit file, minus systemd itself. The mock HAL
    # stands in for GPIO that a container does not have.
    set -a
    # shellcheck disable=SC1091
    . /etc/bloopbox/environment
    set +a
    export HAL_DRIVER=mock
    export RECORDING_DIR=/run/bloopbox
    mkdir -p "${RECORDING_DIR}"
    cd /opt/bloopbox
    ./node/bin/node dist/processes/hardware-server.js > /tmp/server.log 2>&1 &
    SERVER_PID=$!

    for attempt in $(seq 1 40); do
      if curl -fsS --max-time 2 http://127.0.0.1:3000/api/status >/dev/null 2>&1; then break; fi
      if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
        echo "FAIL: the server exited during startup"; cat /tmp/server.log; exit 1
      fi
      sleep 0.5
    done

    STATUS="$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/status || true)"
    [[ -n "${STATUS}" ]] || { echo "FAIL: /api/status never answered"; cat /tmp/server.log; exit 1; }
    echo "GET /api/status -> ${STATUS}"

    # The built admin panel has to be served from the same origin on the device; if the
    # dist/public copy landed in the wrong place the daemon silently falls back to no UI.
    curl -fsS --max-time 5 http://127.0.0.1:3000/admin/ | grep -qi "<html" \
      || { echo "FAIL: the admin panel is not being served"; cat /tmp/server.log; exit 1; }
    echo "GET /admin/ -> ok"

    # A generated cue, served from dist/audio/sounds.
    curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3000/sounds/pop.wav \
      || { echo "FAIL: audio cues are not being served"; exit 1; }
    echo "GET /sounds/pop.wav -> ok"

    # Everything under /api except a handful of endpoints sits behind the admin gate, and
    # the gate stands aside only while the device is unconfigured. Fresh install => open.
    curl -fsS --max-time 5 http://127.0.0.1:3000/api/whatsapp >/dev/null \
      || { echo "FAIL: /api/whatsapp did not answer"; exit 1; }
    echo "GET /api/whatsapp -> ok"

    echo
    echo "--- booting the WhatsApp bridge ---"
    # Only the IPC half is under test: the bridge dialling the hardware server over
    # localhost and getting past the x-bridge-token check with the token install.sh
    # generated. Whether WhatsApp itself is reachable is irrelevant here (and it has no
    # credentials to log in with anyway).
    ./node/bin/node dist/processes/whatsapp-bridge.js > /tmp/bridge.log 2>&1 &
    BRIDGE_PID=$!
    for attempt in $(seq 1 30); do
      grep -q "connected to hardware server" /tmp/bridge.log 2>/dev/null && break
      sleep 0.5
    done
    if grep -q "connected to hardware server" /tmp/bridge.log; then
      echo "bridge -> hardware server: linked"
    else
      echo "FAIL: the bridge never linked to the hardware server (bridge token mismatch?)"
      cat /tmp/bridge.log
      exit 1
    fi

    kill "${BRIDGE_PID}" 2>/dev/null || true
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${BRIDGE_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true

    echo
    echo "--- server log ---"
    tail -20 /tmp/server.log
  '

echo
echo "==> smoke test passed"
