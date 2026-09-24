#!/usr/bin/env bash
#
# Bundles everything needed to debug this device from somewhere else:
#
#   sudo bloopbox-diagnostics
#
# Writes a .tar.gz to /tmp and prints the path. Made for bring-up, where the person holding
# the device and the person reading the logs are not the same person, and "it does not work"
# has to survive being copy-pasted.
#
# **Redaction is the point.** /data/config.json holds the Wi-Fi passphrase, an admin password
# hash and the family's phone numbers. None of that helps anyone debug anything, and a
# diagnostics bundle is the sort of thing that ends up pasted into a chat window, so the
# config is rewritten with those fields replaced before it goes in. Nothing here copies
# /data/auth_info either: those are live WhatsApp credentials, and anyone holding them is
# logged in as the family.
#
# No `pipefail`: several collectors are pipelines whose producers may exit early, and a
# failed collector must never abort the bundle — a partial bundle still explains most faults.
set -u

PREFIX="${PREFIX:-/opt/bloopbox}"
ETC_DIR="${ETC_DIR:-/etc/bloopbox}"
DATA_DIR="${DATA_DIR:-/data}"
NODE="${PREFIX}/node/bin/node"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$(mktemp -d "/tmp/bloopbox-diag-${STAMP}-XXXX")"
BUNDLE="/tmp/bloopbox-diagnostics-${STAMP}.tar.gz"

# Since when. Long enough to hold the last boot and whatever went wrong before it, short
# enough that the bundle stays mailable.
SINCE="${DIAG_SINCE:--2 hours}"

say() { printf '%s\n' "$*" >&2; }

# Runs a command and files its output, whether it works or not: "command not found" is
# itself a finding, and a missing file in the bundle is indistinguishable from a collector
# that was never written.
capture() {
  local name="$1"
  shift
  {
    printf '$ %s\n' "$*"
    "$@" 2>&1 || printf '\n(exited %s)\n' "$?"
  } > "${OUT_DIR}/${name}" 2>&1
}

say "collecting into ${OUT_DIR}"

# ---- what this even is ----
capture 00-uname.txt uname -a
capture 01-os-release.txt cat /etc/os-release
capture 02-release-env.txt cat "${PREFIX}/release.env"
capture 03-model.txt cat /proc/device-tree/model
capture 04-uptime.txt uptime
capture 05-throttled.txt vcgencmd get_throttled
capture 06-temp.txt vcgencmd measure_temp

# ---- the app ----
capture 10-doctor.txt env -i PATH=/usr/local/bin:/usr/bin:/bin sh -c 'cd / && bloopbox-doctor'
capture 11-units.txt systemctl status --no-pager --full \
  bloopbox-hardware.service bloopbox-whatsapp.service bloopbox-net.service \
  bloopbox-firstboot.service bloopbox-ssh-password.service
capture 12-journal-hardware.txt journalctl -u bloopbox-hardware --since "${SINCE}" --no-pager
capture 13-journal-whatsapp.txt journalctl -u bloopbox-whatsapp --since "${SINCE}" --no-pager
capture 14-journal-net.txt journalctl -u bloopbox-net --since "${SINCE}" --no-pager
capture 15-journal-firstboot.txt journalctl -u bloopbox-firstboot --since "${SINCE}" --no-pager
capture 16-journal-boot.txt journalctl -b --no-pager --priority=warning
# Previous boots exist only if debug mode made the journal persistent. When it did, the boot
# before the one you are looking at is usually the interesting one.
capture 17-journal-previous-boot.txt journalctl -b -1 --no-pager --priority=warning
capture 18-debug-status.txt bloopbox-debug status
capture 19-api-status.txt curl -fsS --max-time 5 http://127.0.0.1:3000/api/status

# ---- the network, which is what most of this is for ----
capture 20-net-state.json cat /run/bloopbox-net/net-state.json
capture 21-net-request.json cat /run/bloopbox/net-request.json
capture 22-nmcli-general.txt nmcli general status
capture 23-nmcli-devices.txt nmcli -f DEVICE,TYPE,STATE,CONNECTION dev status
capture 24-nmcli-connections.txt nmcli -f NAME,UUID,TYPE,DEVICE,AUTOCONNECT con show
capture 25-nmcli-wifi.txt nmcli -f IN-USE,SSID,MODE,CHAN,SIGNAL,SECURITY dev wifi list
capture 26-ip-addr.txt ip -brief addr
capture 27-iw-reg.txt iw reg get
capture 28-iw-info.txt iw dev
capture 29-rfkill.txt rfkill list
capture 30-dnsmasq.txt ls -la /var/lib/NetworkManager
capture 31-nm-conf.txt ls -la /etc/NetworkManager/dnsmasq-shared.d/
capture 32-dmesg-wifi.txt dmesg --level=err,warn

# The AP profile as NetworkManager actually stored it, which is the only way to tell a
# profile we wrote from one an older release left behind.
capture 33-ap-profile.txt nmcli con show bloopbox-ap

# ---- hardware ----
capture 40-gpio-chips.txt ls -la /dev/gpiochip0
capture 41-gpioinfo.txt gpioinfo
capture 42-boot-config.txt grep -v '^#' /boot/firmware/config.txt
capture 43-arecord.txt arecord -l
capture 44-aplay.txt aplay -l
capture 45-amixer.txt amixer scontrols
capture 46-usb.txt lsusb

# ---- resources, because 512 MB is the whole budget ----
capture 50-free.txt free -h
capture 51-df.txt df -h
capture 52-mounts.txt findmnt -t tmpfs
capture 53-recordings.txt ls -la /run/bloopbox
capture 54-top.txt top -b -n 1 -o %MEM

# ---- config, redacted ----
# Rewritten by node rather than sed: the fields that matter are nested, and a regex over
# JSON is how a passphrase ends up in a bundle anyway.
if [[ -r "${DATA_DIR}/config.json" && -x "${NODE}" ]]; then
  "${NODE}" -e '
    const fs = require("node:fs");
    try {
      const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const redact = (value) => (typeof value === "string" && value.length > 0 ? "[redacted]" : value);
      if (config.wifi) config.wifi.password = redact(config.wifi.password);
      if (config.system) config.system.adminPasswordHash = redact(config.system.adminPasswordHash);
      for (const contact of Object.values(config.contacts ?? {})) {
        // Keep the shape — a number vs a group JID vs empty is exactly what goes wrong —
        // without keeping the number.
        if (typeof contact.target === "string" && contact.target.length > 0) {
          contact.target = contact.target.endsWith("@g.us") ? "[group jid redacted]" : "[phone redacted]";
        }
      }
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.log("could not read config.json: " + error.message);
    }
  ' "${DATA_DIR}/config.json" > "${OUT_DIR}/60-config-redacted.json" 2>&1
else
  echo "no readable ${DATA_DIR}/config.json (or no bundled node)" > "${OUT_DIR}/60-config-redacted.json"
fi

# ---- the debug-mode trace, if one was collected ----
# Tail-limited: at 10s a sample this is ~8600 lines a day and the whole point of a bundle is
# that it can be sent somewhere. The full file stays on the device if more is needed.
DIAG_TRACE_LINES="${DIAG_TRACE_LINES:-4000}"
for trace in /var/log/bloopbox/trace.jsonl /var/log/bloopbox/trace.jsonl.1; do
  if [[ -r "${trace}" ]]; then
    tail -n "${DIAG_TRACE_LINES}" "${trace}" > "${OUT_DIR}/70-$(basename "${trace}")"
    say "included $(basename "${trace}") (last ${DIAG_TRACE_LINES} samples of $(wc -l < "${trace}" | tr -d ' '))"
  fi
done

# The environment file carries BRIDGE_TOKEN. Keys only.
if [[ -r "${ETC_DIR}/environment" ]]; then
  sed -E 's/^([A-Z_]+)=.*/\1=[set]/' "${ETC_DIR}/environment" > "${OUT_DIR}/61-environment-keys.txt"
fi

# A last look at what is about to be shipped, so a mistake in the redaction above shows up
# here rather than in someone's chat window.
capture 99-bundle-listing.txt ls -la "${OUT_DIR}"

tar czf "${BUNDLE}" -C "$(dirname "${OUT_DIR}")" "$(basename "${OUT_DIR}")" 2>/dev/null
rm -rf "${OUT_DIR}"

say ""
say "wrote ${BUNDLE} ($(du -h "${BUNDLE}" 2>/dev/null | cut -f1))"
say ""
say "copy it off with:"
say "  scp ${USER:-bloop}@$(hostname 2>/dev/null || echo bloopbox).local:${BUNDLE} ."
printf '%s\n' "${BUNDLE}"
