#!/usr/bin/env bash
#
# Routes the codec's analogue paths — DAC to the output amps, microphone to the ADC — unmutes
# its capture input, then saves the mixer state.
#
# Why this exists at all: on the WM8960 HAT the two `… Output Mixer PCM` switches default to
# **off**, which leaves the DAC wired to nothing. The symptom is total silence while every
# other indicator looks healthy — the card enumerates, `aplay` streams the file and exits 0,
# and every volume control reads a sensible value. Measured on the first real device,
# 2026-08-10, after chasing it through three other suspects first.
#
# The capture side needs three things, all measured on the same device on 2026-08-10 by
# playing a full-scale tone through the HAT's own speaker and reading the level back:
#
#   1. The input PGAs power up **muted** (LINMUTE/RINMUTE default to 1), and setting a gain
#      percentage does not clear a mute bit — a recording of the right length and pure
#      silence. Unmuted below, by ALSA_CAPTURE_MIXER_CONTROL.
#   2. `… Input Mixer Boost` (LMIC2B) defaults **off**, which disconnects the PGA output from
#      the boost mixer that feeds the ADC. Worth 42 dB: with it off the tone read -62 dB,
#      with it on -20 dB.
#   3. The mic boost stage `… Input Boost Mixer LINPUT1` defaults to 0 dB. At 3 (+29 dB) the
#      same tone read -8.4 dB. Without it a voice note is faint static.
#
# 2 and 3 come through ALSA_ENABLE_SWITCHES, which is why entries take an optional value.
# The daemon unmutes too, but this runs before it and before `bloopbox-audio-test`, and
# `alsactl store` below makes it stick — so a bare `arecord` behaves like the product does.
#
# Why it is a boot-time step and not part of install.sh: install.sh runs inside a chroot when
# scripts/build-sd-image.sh builds an SD image, and a chroot has no sound card for `amixer` to
# talk to. It has to happen on the device, after the overlay has loaded.
#
# Driven by ALSA_ENABLE_SWITCHES and ALSA_CAPTURE_MIXER_CONTROL in /etc/bloopbox/environment,
# written by `install.sh --audio-hat wm8960`. Both absent means there is nothing to do, which
# is the plain-USB-adapter case.
set -euo pipefail

SWITCHES="${ALSA_ENABLE_SWITCHES:-}"
CAPTURE_CONTROL="${ALSA_CAPTURE_MIXER_CONTROL:-}"
if [[ -z "${SWITCHES}" && -z "${CAPTURE_CONTROL}" ]]; then
  echo "audio-init: no ALSA_ENABLE_SWITCHES or ALSA_CAPTURE_MIXER_CONTROL set — nothing to route"
  exit 0
fi

# Which card to talk to. Derived from the playback device so the hardware is named in exactly
# one place (the environment file) rather than twice.
CARD="${ALSA_MIXER_CARD:-}"
if [[ -z "${CARD}" ]]; then
  case "${ALSA_PLAYBACK_DEVICE:-}" in
    *CARD=*)
      CARD="${ALSA_PLAYBACK_DEVICE#*CARD=}"
      CARD="${CARD%%,*}"
      ;;
    *) CARD=0 ;;
  esac
fi

# An overlay-provided card can appear a moment after this unit is reached on a cold boot.
# Ten seconds of patience here beats a device that is mute until someone reboots it.
for _ in $(seq 1 20); do
  if amixer -c "${CARD}" scontrols >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! amixer -c "${CARD}" scontrols >/dev/null 2>&1; then
  echo "audio-init: no mixer on card '${CARD}' — is the overlay loaded?" >&2
  exit 1
fi

echo "audio-init: card '${CARD}'"
FAILED=0
# Comma-separated, not space-separated: these control names contain spaces themselves
# ("Left Output Mixer PCM"), so a space is not available as the delimiter.
#
# An entry is `Name` (set it to `on`) or `Name=Value` (set it to Value). The second form
# exists because the WM8960's microphone needs a *gain stage* set, not a switch flipped:
# `Left Input Boost Mixer LINPUT1=3` is +29 dB and the difference between an audible voice
# note and faint noise. No control name contains `=`, so the split is unambiguous.
while IFS= read -r entry; do
  [[ -n "${entry}" ]] || continue
  if [[ "${entry}" == *=* ]]; then
    name="${entry%%=*}"
    value="${entry#*=}"
  else
    name="${entry}"
    value=on
  fi
  if amixer -c "${CARD}" -q sset "${name}" "${value}" 2>/dev/null; then
    printf '  %-7s %s\n' "${value}" "${name}"
  else
    # Loud on purpose. A wrong control name here is the exact failure this script exists to
    # prevent, and the daemon's own mixer calls are non-fatal by design — so if this is not
    # the thing that complains, nothing is.
    echo "  FAILED  ${name} — not a control taking '${value}' on card '${CARD}'" >&2
    FAILED=$((FAILED + 1))
  fi
done <<<"${SWITCHES//,/$'\n'}"

# The capture switch, by the same name the daemon uses for mic gain. A warning rather than a
# failure: not every adapter's capture element has a switch at all, and on those the gain
# alone is the whole story.
if [[ -n "${CAPTURE_CONTROL}" ]]; then
  if amixer -c "${CARD}" -q sset "${CAPTURE_CONTROL}" cap unmute 2>/dev/null; then
    echo "  unmuted ${CAPTURE_CONTROL} (capture)"
  else
    echo "  WARN    ${CAPTURE_CONTROL} could not be unmuted — recordings may be silent" >&2
  fi
fi

if [[ "${FAILED}" -gt 0 ]]; then
  echo "audio-init: ${FAILED} switch(es) could not be set — the device may be silent" >&2
  exit 1
fi

# Persist, so the routing also survives if this unit is ever disabled or reordered.
if alsactl store >/dev/null 2>&1; then
  echo "audio-init: saved mixer state"
else
  echo "audio-init: alsactl store failed — routing applies to this boot only" >&2
fi
