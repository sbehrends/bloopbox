#!/usr/bin/env bash
#
# Appends one JSON line every few seconds describing what the device is doing. Started and
# stopped by `bloopbox-debug`, never enabled by default.
#
# Logs say what happened; this says what things *were*. The questions it exists to answer are
# the ones a journal cannot:
#
#   - how much memory the two daemons actually use (the MemoryMax figures in the units are a
#     guess, and PENDING.md says so)
#   - whether the Pi is throttling, which on a Zero 2 W in a toy enclosure is a real risk
#   - what the network was doing minute by minute across a hotspot cycle
#   - what state the device was in when the thing you are debugging happened
#
# JSON Lines, so it can be read with `tail`, filtered with `grep`, and charted later without
# a parser. One flat object per line: nothing nests, so `jq -r '.ts, .memHardware'` works
# without knowing the shape.
#
# No `pipefail`: several samples are pipelines whose producers exit early, and a sample that
# cannot be taken is written as null rather than allowed to kill the sampler.
set -u

TRACE_DIR="${DEBUG_TRACE_DIR:-/var/log/bloopbox}"
TRACE_FILE="${TRACE_DIR}/trace.jsonl"
DEADLINE_FILE="${DEBUG_DEADLINE_FILE:-/etc/bloopbox/debug-until}"
STATE_FILE="${NET_STATE_FILE:-/run/bloopbox-net/net-state.json}"
RECORDING_DIR="${RECORDING_DIR:-/run/bloopbox}"
INTERVAL="${DEBUG_SAMPLE_SECONDS:-10}"

# Rotate at this size, keep one previous file. The card is the constraint: at 10s and ~400
# bytes a line this is about 3.5 MB a day, so 8 MB is a couple of days of history and a hard
# ceiling on what debug mode can cost.
MAX_BYTES="${DEBUG_TRACE_MAX_BYTES:-8388608}"

mkdir -p "${TRACE_DIR}"
chmod 0755 "${TRACE_DIR}"

running=true
trap 'running=false' TERM INT

# Numeric or `null`. Everything downstream treats a missing sample as missing rather than as
# zero, which is the difference between "no reading" and "0 bytes of memory".
number_or_null() {
  local value="$1"
  [[ "${value}" =~ ^[0-9]+$ ]] && echo "${value}" || echo null
}

unit_memory() {
  local raw
  raw="$(systemctl show -p MemoryCurrent --value "$1" 2>/dev/null)"
  number_or_null "${raw}"
}

rotate_if_needed() {
  local size
  size="$(stat -c %s "${TRACE_FILE}" 2>/dev/null || echo 0)"
  if [[ "${size}" -ge "${MAX_BYTES}" ]]; then
    mv -f "${TRACE_FILE}" "${TRACE_FILE}.1"
  fi
}

# Past the deadline, debug mode turns itself off. Left running it would write to the card
# forever, and the person who switched it on is by then debugging something else.
expired() {
  local deadline now
  [[ -r "${DEADLINE_FILE}" ]] || return 1
  deadline="$(cat "${DEADLINE_FILE}" 2>/dev/null)"
  [[ "${deadline}" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  [[ "${now}" -ge "${deadline}" ]]
}

while [[ "${running}" == true ]]; do
  if expired; then
    echo "debug-sampler: deadline reached — turning debug mode off"
    # Ends this service as a side effect, which is the intent: one place decides what debug
    # mode means, and it is not this script.
    /usr/local/bin/bloopbox-debug off >/dev/null 2>&1 || true
    break
  fi

  rotate_if_needed

  # `date -Is` is GNU. The device is Linux so it works there; the fallback keeps the script
  # honest anywhere else, because a sample with an empty timestamp is not a sample.
  TS="$(date -Is 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  TEMP="$(vcgencmd measure_temp 2>/dev/null | tr -dc '0-9.')"
  THROTTLED="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
  LOAD="$(awk '{print $1}' /proc/loadavg 2>/dev/null)"
  MEM_FREE_KB="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"
  RECORDINGS="$(find "${RECORDING_DIR}" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')"
  RECORDING_BYTES="$(du -sb "${RECORDING_DIR}" 2>/dev/null | cut -f1)"

  # The device's own view, which is the one that matters for "what were the lights doing".
  # Whole, not picked apart: it is already JSON, and re-encoding it here would be one more
  # place to keep in step with the payload.
  STATUS="$(curl -fsS --max-time 3 http://127.0.0.1:3000/api/status 2>/dev/null)"
  [[ -z "${STATUS}" ]] && STATUS=null

  NET="$(cat "${STATE_FILE}" 2>/dev/null)"
  [[ -z "${NET}" ]] && NET=null

  printf '{"ts":"%s","temp":%s,"throttled":"%s","load":%s,"memAvailableKb":%s,"memHardware":%s,"memWhatsapp":%s,"memNet":%s,"recordings":%s,"recordingBytes":%s,"status":%s,"net":%s}\n' \
    "${TS}" \
    "$(number_or_null "${TEMP%%.*}")" \
    "${THROTTLED:-unknown}" \
    "${LOAD:-null}" \
    "$(number_or_null "${MEM_FREE_KB}")" \
    "$(unit_memory bloopbox-hardware.service)" \
    "$(unit_memory bloopbox-whatsapp.service)" \
    "$(unit_memory bloopbox-net.service)" \
    "$(number_or_null "${RECORDINGS}")" \
    "$(number_or_null "${RECORDING_BYTES}")" \
    "${STATUS}" \
    "${NET}" \
    >> "${TRACE_FILE}"

  # Backgrounded so a SIGTERM lands during the sleep rather than after it.
  sleep "${INTERVAL}" &
  wait $! 2>/dev/null || true
done

echo "debug-sampler: stopped"
exit 0
