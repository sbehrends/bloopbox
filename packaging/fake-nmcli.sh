#!/usr/bin/env bash
#
# A stand-in for nmcli, so the onboarding flow can be exercised without a radio.
#
# `deploy/net-agent.sh` is the only privileged part of first-boot setup, and everything it
# does it does by shelling out to nmcli. A container has no wireless interface and no
# NetworkManager, so the real thing cannot run — but the agent cannot tell the difference
# between nmcli and this, which means the agent's own logic, the state it publishes and the
# requests it consumes can all be tested for real.
#
# It keeps its world in files under ${FAKE_NM_DIR} and appends every invocation to a log the
# test asserts against. Only the subcommands the agent actually issues are implemented; a
# request for anything else is logged and fails, so a new nmcli call in the agent shows up as
# a test failure rather than as silence.
#
# What this cannot tell you: whether a Pi's radio can host an AP, whether NetworkManager
# accepts these arguments, whether DHCP hands out a lease, or whether a phone's captive-portal
# probe fires. Those need hardware — see docs/hardware-bringup.md.
set -uo pipefail

FAKE_NM_DIR="${FAKE_NM_DIR:-/run/fake-nm}"
mkdir -p "${FAKE_NM_DIR}"

PROFILES="${FAKE_NM_DIR}/profiles"       # one connection name per line
ACTIVE="${FAKE_NM_DIR}/active"           # the active profile name, or absent
SSIDS="${FAKE_NM_DIR}/ssids"             # what a scan finds: ssid:signal:security
CALLS="${FAKE_NM_DIR}/calls.log"         # every invocation, for assertions
touch "${PROFILES}" "${CALLS}"
[[ -s "${SSIDS}" ]] || printf 'HomeNet:82:WPA2\nNeighbour:41:WPA2\nCafe:30:\n' > "${SSIDS}"

echo "nmcli $*" >> "${CALLS}"

active_profile() { [[ -f "${ACTIVE}" ]] && cat "${ACTIVE}" || true; }
has_profile() { grep -qxF "$1" "${PROFILES}" 2>/dev/null; }

# The agent passes -t/-f/--escape before the object, so the object is not at a fixed position.
args=("$@")
object=
for arg in "${args[@]}"; do
  case "${arg}" in
    dev | device | con | connection) object="${arg}"; break ;;
  esac
done

fields=
for i in "${!args[@]}"; do
  [[ "${args[$i]}" == "-f" ]] && fields="${args[$((i + 1))]}"
done

case "${object}" in
  dev | device)
    # `dev wifi list` and `dev wifi` are the scan; `dev status` is the interface table.
    if [[ " ${args[*]} " == *" wifi "* ]]; then
      if [[ "${fields}" == "active,ssid,signal" ]]; then
        # Which network we are associated with. In AP mode the agent never asks.
        current="$(active_profile)"
        if [[ -n "${current}" && "${current}" != "${AP_CONNECTION_NAME:-bloopbox-ap}" ]]; then
          printf 'yes:%s:82\n' "$(cat "${FAKE_NM_DIR}/joined-ssid" 2>/dev/null || echo HomeNet)"
        fi
        exit 0
      fi
      # SSID:SIGNAL:SECURITY, which is what refresh_scan parses.
      cat "${SSIDS}"
      exit 0
    fi
    case "${fields}" in
      DEVICE,TYPE) printf 'wlan0:wifi\nlo:loopback\n' ;;
      TYPE,STATE)
        current="$(active_profile)"
        if [[ -n "${current}" && "${current}" != "${AP_CONNECTION_NAME:-bloopbox-ap}" ]]; then
          printf 'wifi:connected\n'
        else
          printf 'wifi:disconnected\n'
        fi
        ;;
      *) printf 'wlan0:wifi\n' ;;
    esac
    exit 0
    ;;

  con | connection)
    case "${args[*]}" in
      *" add "*)
        # con-name is the profile being created.
        for i in "${!args[@]}"; do
          [[ "${args[$i]}" == "con-name" ]] && echo "${args[$((i + 1))]}" >> "${PROFILES}"
        done
        exit 0
        ;;
      *" modify "*) exit 0 ;;
      *" up "*)
        for i in "${!args[@]}"; do
          if [[ "${args[$i]}" == "up" ]]; then
            name="${args[$((i + 1))]:-}"
            # Bringing up a profile that was never created is the failure the agent expects
            # when a passphrase is wrong or the network is out of range.
            has_profile "${name}" || exit 1
            echo "${name}" > "${ACTIVE}"
            exit 0
          fi
        done
        exit 1
        ;;
      *" down "*)
        for i in "${!args[@]}"; do
          if [[ "${args[$i]}" == "down" ]]; then
            [[ "$(active_profile)" == "${args[$((i + 1))]:-}" ]] && rm -f "${ACTIVE}"
            exit 0
          fi
        done
        exit 0
        ;;
      *" show "*)
        if [[ " ${args[*]} " == *" --active "* ]]; then
          current="$(active_profile)"
          [[ -n "${current}" ]] && printf '%s:802-11-wireless\n' "${current}"
        else
          while IFS= read -r name; do [[ -n "${name}" ]] && printf '%s\n' "${name}"; done < "${PROFILES}"
        fi
        exit 0
        ;;
    esac
    exit 0
    ;;
esac

echo "fake-nmcli: unhandled invocation: $*" >&2
exit 2
