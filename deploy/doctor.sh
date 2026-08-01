#!/usr/bin/env bash
#
# On-device health check:  sudo bloopbox-doctor
#
# `npm run doctor` cannot run here — it is a tsx script and the device has no
# devDependencies — so this covers the same ground in bash, plus what only exists once
# installed: the services, the GPIO character devices, the persistent volume.
#
# Exits non-zero if anything required is missing, so it is usable from a provisioning
# script as well as by hand.
#
# No `pipefail` on purpose: nearly every check here is `something | grep -q`, and grep
# exiting at the first match SIGPIPEs the producer, which pipefail would then report as a
# failed check. `ffmpeg -encoders | grep libopus` fails that way every time.
set -u

PREFIX="${PREFIX:-/opt/bloopbox}"
ETC_DIR="${ETC_DIR:-/etc/bloopbox}"
SERVICE_USER="${SERVICE_USER:-bloopbox}"

FAILURES=0
WARNINGS=0

# Runs a check as the unprivileged service user, which is the only answer that matters for
# "can the daemon read this". runuser ships with util-linux, sudo may not be installed at
# all; returns 127 when neither is available so callers can warn instead of failing.
as_service_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "${SERVICE_USER}" -- "$@" 2>/dev/null
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n -u "${SERVICE_USER}" -- "$@" 2>/dev/null
  else
    return 127
  fi
}

pass() { printf '  \033[32m✓\033[0m %-26s %s\n' "$1" "${2:-}"; }
fail() { printf '  \033[31m✗\033[0m %-26s %s\n' "$1" "${2:-}"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  \033[33m–\033[0m %-26s %s\n' "$1" "${2:-}"; WARNINGS=$((WARNINGS + 1)); }
section() { printf '\n%s\n' "$1"; }

# Values the daemons actually run with, not the defaults.
CONFIG_PATH=/data/config.json
RECORDING_DIR=/run/bloopbox
# Published by deploy/net-agent.sh, read by src/net/netState.ts. The age limit is that
# module's NET_STATE_MAX_AGE_MS; keep the two in step.
NET_STATE_FILE=/run/bloopbox-net/net-state.json
NET_STATE_MAX_AGE_SECONDS=30
if [[ -r "${ETC_DIR}/environment" ]]; then
  # shellcheck disable=SC1091
  source "${ETC_DIR}/environment"
fi

echo "bloopbox doctor — $(uname -srm)"
if [[ "${EUID}" -ne 0 ]]; then
  echo "note: not running as root — the checks that step into the ${SERVICE_USER} account will be skipped"
fi
if [[ -r "${PREFIX}/release.env" ]]; then
  # shellcheck disable=SC1091
  source "${PREFIX}/release.env"
  echo "release ${APP_VERSION:-?} (${GIT_SHA:-?}) built ${BUILD_DATE:-?} for ${TARGET_OS:-?}"
fi

section "runtime"
if [[ -x "${PREFIX}/node/bin/node" ]]; then
  if node_version="$("${PREFIX}/node/bin/node" --version 2>&1)"; then
    pass "bundled node" "${node_version}"
  else
    fail "bundled node" "will not execute: ${node_version}"
  fi
else
  fail "bundled node" "${PREFIX}/node/bin/node is missing — is the app installed?"
fi

if [[ -f "${PREFIX}/dist/processes/hardware-server.js" ]]; then
  pass "application" "${PREFIX}"
else
  fail "application" "${PREFIX}/dist is missing"
fi

# The one native module. Without it the GPIO HAL cannot load and the device has no buttons.
if [[ -f "${PREFIX}/node_modules/opengpio/build/Release/opengpio.node" ]]; then
  # From ${PREFIX}, or node resolves the module against whatever directory doctor was run
  # from and reports a perfectly good addon as broken.
  if ( cd "${PREFIX}" && "${PREFIX}/node/bin/node" -e "require('opengpio')" ) 2>/dev/null; then
    pass "opengpio addon" "loads (libgpiod v2)"
  else
    fail "opengpio addon" "present but will not load — apt install libgpiod3"
  fi
else
  fail "opengpio addon" "not built — this release was packaged wrong"
fi

section "external tools"
if command -v "${FFMPEG_PATH:-ffmpeg}" >/dev/null 2>&1; then
  pass "ffmpeg" "$("${FFMPEG_PATH:-ffmpeg}" -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"
  if "${FFMPEG_PATH:-ffmpeg}" -hide_banner -encoders 2>/dev/null | grep -qE 'libopus| opus '; then
    pass "ffmpeg opus encoder" "available"
  else
    fail "ffmpeg opus encoder" "missing — WhatsApp voice notes require Opus"
  fi
else
  fail "ffmpeg" "not on PATH — apt install ffmpeg"
fi

for tool in arecord aplay amixer; do
  if command -v "${tool}" >/dev/null 2>&1; then
    pass "${tool}" "present"
  else
    fail "${tool}" "missing — apt install alsa-utils"
  fi
done

section "audio devices"
if command -v arecord >/dev/null 2>&1; then
  if arecord -l 2>/dev/null | grep -q '^card'; then
    pass "capture device" "$(arecord -l 2>/dev/null | grep '^card' | head -1 | cut -c1-60)"
  else
    fail "capture device" "none — is the USB microphone plugged in?"
  fi
  if aplay -l 2>/dev/null | grep -q '^card'; then
    pass "playback device" "$(aplay -l 2>/dev/null | grep '^card' | head -1 | cut -c1-60)"
  else
    fail "playback device" "none — is the USB speaker plugged in?"
  fi
fi

section "gpio"
if compgen -G "/dev/gpiochip*" >/dev/null; then
  pass "gpio character devices" "$(echo /dev/gpiochip* | tr ' ' ',')"
  as_service_user test -r /dev/gpiochip0
  case "$?" in
    0) pass "gpio readable by ${SERVICE_USER}" "yes" ;;
    127) warn "gpio readable by ${SERVICE_USER}" "not tested (no runuser or sudo)" ;;
    *) warn "gpio readable by ${SERVICE_USER}" "no — check the gpio group and udev rules" ;;
  esac
else
  warn "gpio character devices" "none (not a Pi, or simulator mode)"
fi

BOOT_CONFIG=
for candidate in /boot/firmware/config.txt /boot/config.txt; do
  [[ -f "${candidate}" ]] && { BOOT_CONFIG="${candidate}"; break; }
done
if [[ -n "${BOOT_CONFIG}" ]]; then
  if grep -q '^gpio=17,27,22=ip,pu' "${BOOT_CONFIG}"; then
    pass "firmware pull-ups" "${BOOT_CONFIG}"
  else
    fail "firmware pull-ups" "missing from ${BOOT_CONFIG} — the button lines will float"
  fi
else
  warn "firmware pull-ups" "no config.txt (not a Pi)"
fi

section "storage"
if [[ -d "$(dirname "${CONFIG_PATH}")" ]]; then
  data_dir="$(dirname "${CONFIG_PATH}")"
  as_service_user test -w "${data_dir}"
  case "$?" in
    0) pass "persistent volume" "${data_dir} writable by ${SERVICE_USER}" ;;
    127) warn "persistent volume" "$(stat -c '%A %U:%G' "${data_dir}") (cannot test as ${SERVICE_USER} here)" ;;
    *) fail "persistent volume" "${data_dir} is not writable by ${SERVICE_USER}" ;;
  esac
  if [[ -f "${CONFIG_PATH}" ]]; then
    if "${PREFIX}/node/bin/node" -e "JSON.parse(require('node:fs').readFileSync('${CONFIG_PATH}','utf8'))" 2>/dev/null; then
      configured="$("${PREFIX}/node/bin/node" -e "
        const c = JSON.parse(require('node:fs').readFileSync('${CONFIG_PATH}','utf8'));
        const assigned = Object.values(c.contacts ?? {}).filter((x) => x.enabled).length;
        console.log((c.system?.configured ? 'onboarded' : 'NOT onboarded') + ', ' + assigned + ' button(s) assigned');
      " 2>/dev/null)"
      pass "config.json" "valid — ${configured}"
    else
      fail "config.json" "will not parse — the daemon is running on shipped defaults"
    fi
  else
    warn "config.json" "absent — the device boots into onboarding"
  fi
else
  fail "persistent volume" "$(dirname "${CONFIG_PATH}") does not exist"
fi

RECORDING_FSTYPE="$(findmnt -n -o FSTYPE --target "${RECORDING_DIR}" 2>/dev/null)"
if [[ "${RECORDING_FSTYPE}" == tmpfs ]]; then
  pass "recordings on tmpfs" "${RECORDING_DIR} ($(findmnt -n -o SIZE --target "${RECORDING_DIR}" 2>/dev/null))"
elif [[ ! -d /run/systemd/system ]]; then
  # RuntimeDirectory= is what puts this on /run, and systemd has not applied it here —
  # inside a chroot or a container, so "on disk" says nothing about the real device.
  warn "recordings on tmpfs" "cannot tell without systemd running (saw ${RECORDING_FSTYPE:-nothing})"
else
  fail "recordings on tmpfs" "${RECORDING_DIR} is ${RECORDING_FSTYPE} — audio must live in RAM"
fi

section "audio cues"
# Asks the shipped code rather than repeating the cue list here, so this cannot drift when
# a cue is added to src/audio/cues.ts.
if cue_report="$("${PREFIX}/node/bin/node" --input-type=module -e "
      const { missingCues } = await import('${PREFIX}/dist/audio/soundFiles.js');
      const { ALL_AUDIO_CUES } = await import('${PREFIX}/dist/audio/cues.js');
      const absent = missingCues();
      console.log(absent.length === 0 ? 'ok all ' + ALL_AUDIO_CUES.length + ' present' : 'missing ' + absent.join(', '));
    " 2>/dev/null)"; then
  case "${cue_report}" in
    ok*) pass "cue files" "${cue_report#ok }" ;;
    *) fail "cue files" "${cue_report} — bad release, the device would be mute" ;;
  esac
else
  fail "cue files" "could not read the cue list from ${PREFIX}/dist"
fi

section "services"
if [[ -d /run/systemd/system ]]; then
  for unit in bloopbox-hardware bloopbox-whatsapp bloopbox-net; do
    state="$(systemctl is-active "${unit}.service" 2>/dev/null || true)"
    enabled="$(systemctl is-enabled "${unit}.service" 2>/dev/null || true)"
    if [[ "${state}" == "active" ]]; then
      pass "${unit}" "active, ${enabled}"
    else
      fail "${unit}" "${state:-unknown} — journalctl -u ${unit} -n 40"
    fi
  done

  if [[ -r "${ETC_DIR}/environment" ]] && grep -q '^BRIDGE_TOKEN=..' "${ETC_DIR}/environment"; then
    pass "bridge token" "set"
  else
    fail "bridge token" "missing from ${ETC_DIR}/environment"
  fi

  if command -v curl >/dev/null 2>&1; then
    if status="$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/status 2>/dev/null)"; then
      pass "api" "$(echo "${status}" | head -c 100)"
    else
      fail "api" "no answer on http://127.0.0.1:3000/api/status"
    fi
  fi
else
  warn "services" "no running systemd"
fi

section "network"
# What the daemon is allowed to know about the Wi-Fi. It runs unprivileged and cannot ask
# NetworkManager itself, so a missing or stale reading here means the LEDs cannot report a
# Wi-Fi outage at all — the daemon treats "no reading" as "unknown", never as an error.
#
# Guarded like the services section: in a container (scripts/smoke-test-release.sh) there is
# no NetworkManager and no agent to publish, and that is not a fault in the release.
if [[ -d /run/systemd/system ]]; then
  if command -v nmcli >/dev/null 2>&1; then
    ACTIVE_SSID="$(nmcli -t -f active,ssid dev wifi 2>/dev/null | awk -F: '$1=="yes"{print $2; exit}')"
    if [[ -n "${ACTIVE_SSID}" ]]; then
      pass "wifi" "associated with ${ACTIVE_SSID}"
    else
      warn "wifi" "not associated with any network"
    fi
  else
    fail "nmcli" "not installed — wifi-apply.sh and the net agent both need it"
  fi

  if [[ -r "${NET_STATE_FILE}" ]]; then
    # Freshness, not content: a file that stopped updating is the failure mode that matters,
    # and it is indistinguishable from a healthy one by eye.
    AGE_SECONDS=$(( $(date +%s) - $(stat -c %Y "${NET_STATE_FILE}" 2>/dev/null || echo 0) ))
    if [[ "${AGE_SECONDS}" -le "${NET_STATE_MAX_AGE_SECONDS}" ]]; then
      pass "net state" "published ${AGE_SECONDS}s ago"
    else
      fail "net state" "${NET_STATE_FILE} is ${AGE_SECONDS}s old — is bloopbox-net running?"
    fi

    as_service_user test -r "${NET_STATE_FILE}"
    case "$?" in
      0) pass "net state readable" "by ${SERVICE_USER}" ;;
      127) warn "net state readable" "$(stat -c '%A %U:%G' "${NET_STATE_FILE}") (cannot test as ${SERVICE_USER} here)" ;;
      *) fail "net state readable" "${SERVICE_USER} cannot read ${NET_STATE_FILE}" ;;
    esac
  else
    fail "net state" "${NET_STATE_FILE} is missing — is bloopbox-net running?"
  fi
else
  warn "network" "no running systemd — not checked"
fi

printf '\n'
if [[ "${FAILURES}" -gt 0 ]]; then
  printf '%s failed check(s), %s warning(s).\n' "${FAILURES}" "${WARNINGS}"
  exit 1
fi
printf 'All required checks passed'
[[ "${WARNINGS}" -gt 0 ]] && printf ' (%s warning(s))' "${WARNINGS}"
printf '.\n'
