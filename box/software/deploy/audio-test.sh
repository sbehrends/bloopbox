#!/usr/bin/env bash
#
# On-device speaker and microphone test:  sudo bloopbox-audio-test
#
# Proves the audio half of the device end to end, in the order a failure is easiest to
# read: the card exists -> the codec answers on I2C -> the mixer has the controls the
# daemon sets -> the speaker plays a real product cue -> the microphone hears something ->
# what it heard plays back. Nothing here touches WhatsApp or GPIO.
#
# Uses the devices out of /etc/bloopbox/environment, so it tests what the daemon will
# actually open rather than whatever ALSA's default happens to be. Stop the services first
# if a recording is in progress — this opens the same card.
#
# `set -o pipefail` is safe here only because no check pipes into `grep -q`; the producer
# would take a SIGPIPE and fail the whole script. Output is captured into variables and
# matched with `[[ ]]` instead. See box/software/CLAUDE.md.
set -euo pipefail

PREFIX="${PREFIX:-/opt/bloopbox}"
ETC_DIR="${ETC_DIR:-/etc/bloopbox}"
SECONDS_TO_RECORD=5
# Below this peak the capture is silence, not a quiet room: a muted or unrouted input
# reads as -91 dB (the S16 noise floor), while a still room with a live mic sits far above.
SILENCE_CEILING_DB=-60

usage() {
  cat <<'EOF'
Tests the speaker and the microphone with the devices the daemon uses.

Usage: sudo bloopbox-audio-test [options]

Options:
  --seconds N     How long to record (default: 5)
  -h, --help      This message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seconds) SECONDS_TO_RECORD="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

FAILURES=0
pass() { printf '  \033[32m✓\033[0m %-26s %s\n' "$1" "${2:-}"; }
fail() { printf '  \033[31m✗\033[0m %-26s %s\n' "$1" "${2:-}"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  \033[33m–\033[0m %-26s %s\n' "$1" "${2:-}"; }
section() { printf '\n%s\n' "$1"; }

if [[ -r "${ETC_DIR}/environment" ]]; then
  # shellcheck disable=SC1091
  source "${ETC_DIR}/environment"
fi

# The same defaults src/hal/gpioDriver.ts applies, so an unset variable here behaves
# exactly as it will in the daemon.
PLAYBACK_DEVICE="${ALSA_PLAYBACK_DEVICE:-default}"
CAPTURE_DEVICE="${ALSA_CAPTURE_DEVICE:-default}"
MIXER_CONTROL="${ALSA_MIXER_CONTROL:-PCM}"
CAPTURE_MIXER_CONTROL="${ALSA_CAPTURE_MIXER_CONTROL:-Mic}"
RATE="${CAPTURE_RATE:-16000}"
FFMPEG="${FFMPEG_PATH:-ffmpeg}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT
RECORDING="${WORK_DIR}/mic-test.wav"

echo "bloopbox audio test — $(uname -srm)"
echo "  playback  ${PLAYBACK_DEVICE}"
echo "  capture   ${CAPTURE_DEVICE}  (${RATE} Hz mono)"

section "sound cards"
if [[ -r /proc/asound/cards ]]; then
  # No emptiness guard on the line: `[[ -n x ]] && printf` as the last command in a loop body
  # returns 1 on a blank line, and under `set -e` that aborts the whole script.
  while IFS= read -r line; do
    printf '    %s\n' "${line}"
  done < /proc/asound/cards
else
  fail "/proc/asound/cards" "no ALSA at all — is alsa-utils installed?"
fi

# aplay -L lists every name a -D argument may take. Matching the configured one here turns
# "aplay: unable to open" three steps later into a named failure now.
if command -v aplay >/dev/null 2>&1; then
  PCM_NAMES="$(aplay -L 2>/dev/null || true)"
  if [[ "${PLAYBACK_DEVICE}" == default ]]; then
    warn "playback device" "ALSA default — set ALSA_PLAYBACK_DEVICE to name a card"
  elif [[ "${PCM_NAMES}" == *"${PLAYBACK_DEVICE}"* ]]; then
    pass "playback device" "${PLAYBACK_DEVICE}"
  else
    fail "playback device" "${PLAYBACK_DEVICE} is not in aplay -L"
  fi
else
  fail "aplay" "missing — apt install alsa-utils"
fi

# The WM8960 codec sits at 0x1a on i2c-1. This is the check that tells a HAT which is not
# seated apart from an overlay which did not load: no 1a means the kernel never saw it.
if command -v i2cdetect >/dev/null 2>&1 && [[ -e /dev/i2c-1 ]]; then
  I2C_SCAN="$(i2cdetect -y 1 2>/dev/null || true)"
  # A detected address is the only place "1a" appears: the row labels are 00:..70: and every
  # other cell is `--` or a two-digit address.
  if [[ "${I2C_SCAN}" == *"1a"* ]]; then
    pass "codec on i2c-1" "0x1a answering"
  else
    warn "codec on i2c-1" "nothing at 0x1a — expected for a USB adapter, not for a WM8960"
  fi
fi

section "mixer"
if command -v amixer >/dev/null 2>&1; then
  CONTROLS="$(amixer scontrols 2>/dev/null || true)"
  if [[ -z "${CONTROLS}" ]]; then
    fail "mixer controls" "amixer scontrols returned nothing"
  else
    for control in "${MIXER_CONTROL}" "${CAPTURE_MIXER_CONTROL}"; do
      if [[ "${CONTROLS}" == *"'${control}'"* ]]; then
        pass "control ${control}" "present"
      else
        fail "control ${control}" "not in amixer scontrols — the daemon's volume/gain is inert"
      fi
    done
    # Best effort, and deliberately not fatal: the daemon treats mixer failures the same
    # way. On the WM8960 the capture path also needs its input boost switches on, and those
    # control names vary by kernel — `amixer contents` is where to look if the mic is silent.
    amixer -M sset "${MIXER_CONTROL}" 80% >/dev/null 2>&1 || true
    amixer -M sset "${CAPTURE_MIXER_CONTROL}" 80% cap >/dev/null 2>&1 || true
    amixer sset 'Capture Switch' on >/dev/null 2>&1 || true
  fi
else
  fail "amixer" "missing — apt install alsa-utils"
fi

section "speaker"
# The boot sound: the longest designed cue, so it exercises more of the speaker's range than a
# 140ms chime and is the one whose loudness is worth judging by ear (docs/hardware-bringup.md).
CUE="${PREFIX}/dist/audio/sounds/boot.wav"
if [[ ! -r "${CUE}" ]]; then
  warn "product cue" "${CUE} missing — falling back to a generated tone"
  CUE="${WORK_DIR}/tone.wav"
  "${FFMPEG}" -hide_banner -loglevel error -f lavfi \
    -i "sine=frequency=880:duration=1:sample_rate=48000" -ac 1 "${CUE}" || true
fi
if [[ -r "${CUE}" ]]; then
  echo "    playing $(basename "${CUE}") — you should hear it now"
  if aplay -D "${PLAYBACK_DEVICE}" -q "${CUE}"; then
    pass "playback" "aplay finished cleanly"
  else
    fail "playback" "aplay failed on ${PLAYBACK_DEVICE}"
  fi
else
  fail "playback" "no file to play"
fi

section "microphone"
echo "    recording ${SECONDS_TO_RECORD}s — say something (the bar is the live level)"
if arecord -D "${CAPTURE_DEVICE}" -f S16_LE -r "${RATE}" -c 1 -t wav \
           -d "${SECONDS_TO_RECORD}" -V mono "${RECORDING}"; then
  pass "capture" "arecord finished cleanly"
else
  fail "capture" "arecord failed on ${CAPTURE_DEVICE}"
fi

if [[ -s "${RECORDING}" ]]; then
  # volumedetect prints to stderr; the peak is the only number that answers "did the
  # microphone hear anything at all", which is the question a level meter answers by eye.
  DETECT="$("${FFMPEG}" -hide_banner -nostats -i "${RECORDING}" \
            -af volumedetect -f null - 2>&1 || true)"
  PEAK_LINE="${DETECT##*max_volume: }"
  PEAK_DB="${PEAK_LINE%% dB*}"
  if [[ "${PEAK_LINE}" == "${DETECT}" ]]; then
    warn "peak level" "ffmpeg did not report one — is ${FFMPEG} on PATH?"
  elif [[ "${PEAK_DB%%.*}" =~ ^-?[0-9]+$ ]] && (( ${PEAK_DB%%.*} > SILENCE_CEILING_DB )); then
    pass "peak level" "${PEAK_DB} dB"
  else
    fail "peak level" "${PEAK_DB} dB — that is silence, not a quiet room"
  fi

  echo "    playing it back"
  if aplay -D "${PLAYBACK_DEVICE}" -q "${RECORDING}"; then
    pass "round trip" "recorded and played back"
  else
    fail "round trip" "recorded but could not play it back"
  fi
else
  fail "recording" "no audio was written"
fi

section "result"
if (( FAILURES > 0 )); then
  echo "  ${FAILURES} failed."
  echo
  echo "  Silent speaker or silent mic, in the order worth trying:"
  echo "    systemctl status bloopbox-audio-init   the analogue routing, and whether it applied"
  echo "    aplay -L                       the exact names ALSA_PLAYBACK_DEVICE may take"
  echo "    amixer contents                every control, including the WM8960 input boosts"
  echo "    dmesg | tail -40               whether the overlay loaded at boot"
  echo "    sudo bloopbox-doctor           the rest of the device"
  echo
  echo "  A quiet-but-not-silent mic on the WM8960 is one of these three, measured in that"
  echo "  order — see docs/hardware.md. All three are set by bloopbox-audio-init:"
  echo "    amixer sget Capture                          must read [on], not muted"
  echo "    amixer sget 'Left Input Mixer Boost'         must be [on]   — worth 42 dB"
  echo "    amixer sget 'Left Input Boost Mixer LINPUT1' must be 3      — worth 29 dB"
  exit 1
fi
echo "  Speaker and microphone both work."
