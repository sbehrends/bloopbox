#!/usr/bin/env bash
#
# Turns the device into something you can reconstruct afterwards:
#
#   sudo bloopbox-debug on              # 24 hours, then it turns itself off
#   sudo bloopbox-debug on --hours 4
#   sudo bloopbox-debug status
#   sudo bloopbox-debug off
#   sudo bloopbox-debug off --purge     # and delete the collected history
#
# Three things, none of which are on by default:
#
#   1. LOG_LEVEL=debug for both daemons. That is what turns on the state timeline (every
#      observable change, so you can replay what the lights did) and the raw button edges,
#      including presses the debouncer discards — "the button did nothing" leaves no other
#      trace.
#   2. A persistent journal. bloopbox keeps the journal in RAM (install.sh's 50-bloopbox.conf),
#      so **every log line is lost on reboot** — including the ones explaining the reboot. This is the
#      single most valuable thing here and the reason the mode exists.
#   3. A sampler recording what the device *is*, every 10s, as JSON Lines: memory per unit,
#      temperature, throttling, the network reading, the device's own status.
#
# It costs SD card writes, which is why it expires. `off` keeps everything collected so far —
# the point was to read it — and only `--purge` throws it away.
#
# No `pipefail`: journalctl and systemctl pipelines have producers that exit early.
set -u

PREFIX="${PREFIX:-/opt/bloopbox}"
ETC_DIR="${ETC_DIR:-/etc/bloopbox}"
ENVIRONMENT="${ETC_DIR}/environment"
DEADLINE_FILE="${ETC_DIR}/debug-until"
TRACE_DIR="${DEBUG_TRACE_DIR:-/var/log/bloopbox}"
# 90-, so it sorts after install.sh's 50-bloopbox.conf (Storage=volatile) and wins: journald
# applies every drop-in in file-name order and the last assignment stands. Neither file edits the
# other — turning this mode on and off is adding and removing this one.
JOURNAL_DROPIN=/etc/systemd/journald.conf.d/90-bloopbox-debug.conf
# What releases before 2026-09-24 called it. It sorts before 50-bloopbox.conf and would lose to
# it, so it is removed wherever it is found.
LEGACY_JOURNAL_DROPIN=/etc/systemd/journald.conf.d/10-bloopbox-debug.conf
SAMPLER=bloopbox-debug-sampler.service
UNITS=(bloopbox-hardware.service bloopbox-whatsapp.service)

HOURS=24
PURGE=false
ACTION="${1:-status}"
[[ $# -gt 0 ]] && shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --purge) PURGE=true; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ "${HOURS}" =~ ^[0-9]+$ ]] || { echo "--hours wants a number" >&2; exit 2; }

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

require_root() {
  [[ "${EUID}" -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }
}

# One line, replaced rather than appended: the environment file is read by systemd, which
# takes the last assignment, and an accumulating list of LOG_LEVEL lines is a puzzle nobody
# needs at 1am.
set_log_level() {
  local level="$1"
  [[ -f "${ENVIRONMENT}" ]] || { info "no ${ENVIRONMENT} — is bloopbox installed?"; return 1; }
  # `grep -q FILE`, not `cmd | grep -q`: the ban in CLAUDE.md is about SIGPIPE'ing a producer
  # in a pipeline, which this is not.
  if grep -q '^LOG_LEVEL=' "${ENVIRONMENT}" 2>/dev/null; then
    sed -i "s/^LOG_LEVEL=.*/LOG_LEVEL=${level}/" "${ENVIRONMENT}"
  else
    printf 'LOG_LEVEL=%s\n' "${level}" >> "${ENVIRONMENT}"
  fi
  info "LOG_LEVEL=${level}"
}

restart_daemons() {
  # A restart, not a reload: config and log level are both read once at startup, which is the
  # same reason saving a setting restarts the device (see CLAUDE.md).
  systemctl restart "${UNITS[@]}" 2>/dev/null
  info "restarted the daemons"
}

case "${ACTION}" in
  on)
    require_root
    step "log level"
    set_log_level debug || exit 1

    step "persistent journal"
    # Without this the journal lives in /run and dies with the boot. The cap matters as much
    # as the persistence: this is an SD card, and an uncapped journal fills it.
    install -d -m 0755 /etc/systemd/journald.conf.d
    rm -f "${LEGACY_JOURNAL_DROPIN}"
    cat > "${JOURNAL_DROPIN}" <<'EOF'
# Written by `bloopbox-debug on`. Removed by `bloopbox-debug off --purge`.
#
# The journal normally lives in RAM (50-bloopbox.conf, from install.sh), so a reboot takes
# the evidence with it. During bring-up that is exactly backwards: the reboot is usually the
# thing being investigated. This file sorts after that one, so its Storage= wins.
[Journal]
Storage=persistent
SystemMaxUse=128M
SystemMaxFileSize=16M
EOF
    install -d -m 2755 /var/log/journal
    systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1
    systemctl restart systemd-journald 2>/dev/null
    info "journal survives reboots now (capped at 128M)"

    step "sampler"
    date -d "+${HOURS} hours" +%s > "${DEADLINE_FILE}" 2>/dev/null \
      || date -v "+${HOURS}H" +%s > "${DEADLINE_FILE}" 2>/dev/null \
      || echo $(( $(date +%s) + HOURS * 3600 )) > "${DEADLINE_FILE}"
    systemctl start "${SAMPLER}" 2>/dev/null
    info "sampling every 10s into ${TRACE_DIR}/trace.jsonl"
    info "expires $(date -d "@$(cat "${DEADLINE_FILE}")" 2>/dev/null || cat "${DEADLINE_FILE}")"

    restart_daemons

    cat <<EOF

Debug mode is on. Reproduce the problem, then:

  sudo bloopbox-diagnostics     # bundles the journal, the trace and the rest
  sudo bloopbox-debug off       # or wait ${HOURS}h and it turns itself off

EOF
    ;;

  off)
    require_root
    # Order matters here, and not for tidiness. The sampler calls this script when its
    # deadline passes — so `systemctl stop` on the sampler kills this process too, being in
    # the same cgroup. Everything else therefore happens *first*, and stopping the sampler is
    # the last thing we do. Getting this backwards left LOG_LEVEL=debug set forever on a
    # device that thought it had turned debug mode off.
    step "deadline"
    rm -f "${DEADLINE_FILE}"
    info "cleared"

    step "log level"
    set_log_level info || true

    if [[ "${PURGE}" == true ]]; then
      step "purging"
      # Only on request. Turning debug mode off is what you do *before* reading the history,
      # so deleting it here by default would throw away the entire point of having collected
      # it.
      # Removing the drop-in is the whole of "back to RAM": install.sh's 50-bloopbox.conf,
      # which this one was overriding, takes over again at the journald restart below.
      rm -f "${JOURNAL_DROPIN}" "${LEGACY_JOURNAL_DROPIN}" "${TRACE_DIR}"/trace.jsonl*
      systemctl restart systemd-journald 2>/dev/null
      journalctl --vacuum-time=1s >/dev/null 2>&1
      rm -rf /var/log/journal
      info "history deleted, journal back in RAM"
    else
      info "kept ${TRACE_DIR} and the persistent journal — collect them before purging"
    fi

    restart_daemons

    step "sampler"
    # Last. See the note at the top of this branch.
    systemctl stop "${SAMPLER}" 2>/dev/null
    info "stopped"
    ;;

  status)
    LEVEL="$(grep '^LOG_LEVEL=' "${ENVIRONMENT}" 2>/dev/null | tail -1 | cut -d= -f2)"
    SAMPLER_STATE="$(systemctl is-active "${SAMPLER}" 2>/dev/null)"
    printf 'log level     %s\n' "${LEVEL:-(unset, so info)}"
    printf 'sampler       %s\n' "${SAMPLER_STATE:-unknown}"
    if [[ -r "${DEADLINE_FILE}" ]]; then
      printf 'expires       %s\n' "$(date -d "@$(cat "${DEADLINE_FILE}")" 2>/dev/null || cat "${DEADLINE_FILE}")"
    else
      printf 'expires       (no deadline set)\n'
    fi
    # Asked of the drop-in, not of /var/log/journal: plain Debian creates that directory on its
    # own, and with 50-bloopbox.conf's Storage=volatile its mere existence persists nothing.
    if [[ -f "${JOURNAL_DROPIN}" || -f "${LEGACY_JOURNAL_DROPIN}" ]]; then
      printf 'journal       persistent, %s\n' "$(journalctl --disk-usage 2>/dev/null | sed 's/^.*take up //')"
    else
      printf 'journal       volatile (RAM) — lost on reboot\n'
    fi
    if [[ -f "${TRACE_DIR}/trace.jsonl" ]]; then
      printf 'trace         %s, %s samples\n' \
        "$(du -h "${TRACE_DIR}/trace.jsonl" | cut -f1)" \
        "$(wc -l < "${TRACE_DIR}/trace.jsonl" | tr -d ' ')"
    else
      printf 'trace         none collected\n'
    fi
    ;;

  *)
    echo "usage: bloopbox-debug {on|off|status} [--hours N] [--purge]" >&2
    exit 2
    ;;
esac
