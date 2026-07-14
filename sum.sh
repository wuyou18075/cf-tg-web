#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_NAME="traffic-telegram-report"
readonly REPORT_SCRIPT="/usr/local/sbin/${APP_NAME}"
readonly CONFIG_FILE="/etc/${APP_NAME}.conf"
readonly SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
readonly TIMER_FILE="/etc/systemd/system/${APP_NAME}.timer"

VNSTAT_WAS_INSTALLED=false

log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die()  { printf 'Error: %s\n' "$*" >&2; exit 1; }

require_root()  { [[ "${EUID}" -eq 0 ]] || die 'run as root or use: sudo bash $0'; }

check_debian13() {
  [[ -r /etc/os-release ]] || die 'cannot identify OS.'
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == 'debian' ]] || die "Debian only; current: ${PRETTY_NAME:-unknown}."
  [[ "${VERSION_ID:-}" == '13' ]] || die "Debian 13 only; current: ${VERSION_ID:-unknown}."
  command -v systemctl >/dev/null 2>&1 || die 'no systemd detected.'
}

validate_token() { [[ "$1" =~ ^[0-9]{5,20}:[A-Za-z0-9_-]{20,100}$ ]]; }
validate_chat_id() { [[ "$1" =~ ^-?[0-9]{5,20}$ ]]; }

resolve_token() {
  local val="${ttoken:-}"
  if [[ -z "${val}" ]]; then
    read -r -s -p 'Telegram Bot Token: ' val; printf '\n'
    validate_token "${val}" || die 'Bot Token invalid.'
  fi
  printf '%s' "${val}"
}

resolve_chat_id() {
  local val="${tid:-}"
  if [[ -z "${val}" ]]; then
    read -r -p 'Telegram Chat ID: ' val
    validate_chat_id "${val}" || die 'Chat ID must be a number, may be negative.'
  fi
  printf '%s' "${val}"
}

install_deps() {
  if command -v vnstat >/dev/null 2>&1; then
    log 'vnStat already installed, skipping.'
    VNSTAT_WAS_INSTALLED=false
  else
    VNSTAT_WAS_INSTALLED=true
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl iproute2 jq
  if ${VNSTAT_WAS_INSTALLED}; then
    log 'Installing vnStat...'; apt-get install -y --no-install-recommends vnstat
  fi
}

detect_interface() {
  local ifname
  ifname="$(ip -o route show default 2>/dev/null | awk '{print $5; exit}')"
  [[ -n "${ifname}" ]] || die 'no default route interface found.'
  [[ "${ifname}" =~ ^[A-Za-z0-9_.:-]{1,15}$ ]] || die "bad interface name: ${ifname}"
  [[ -d "/sys/class/net/${ifname}" ]] || die "interface missing: ${ifname}"
  printf '%s' "${ifname}"
}

configure_vnstat() {
  local ifname="$1"; log "Configuring vnStat on ${ifname}..."
  systemctl enable --now vnstat.service
  vnstat --json -i "${ifname}" >/dev/null 2>&1 || vnstat --add -i "${ifname}" >/dev/null
  systemctl restart vnstat.service
}

write_config() {
  local ifname="$1" token="$2" chat_id="$3"
  local tmp
  tmp="$(mktemp)"; chmod 600 "${tmp}"
  printf 'TG_BOT_TOKEN=%s\nTG_CHAT_ID=%s\nINTERFACE=%s\n' \
    "${token}" "${chat_id}" "${ifname}" >"${tmp}"
  install -o root -g root -m 600 "${tmp}" "${CONFIG_FILE}"; rm -f "${tmp}"
}

write_reporter() {
  local tmp_report
  tmp_report="$(mktemp)"; chmod 600 "${tmp_report}"
  cat >"${tmp_report}" <<'REPORTER_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONFIG="/etc/traffic-telegram-report.conf"
TG_BOT_TOKEN=""
TG_CHAT_ID=""
INTERFACE=""

log_error()  { printf 'Error: %s\n' "$*" >&2; }

load_config() {
  [[ -r "${CONFIG}" ]] || {
    log_error "config unreadable: ${CONFIG}"; return 1
  }
  while IFS='=' read -r key val; do
    case "${key}" in
      TG_BOT_TOKEN) TG_BOT_TOKEN="${val}" ;;
      TG_CHAT_ID)   TG_CHAT_ID="${val}"   ;;
      INTERFACE)    INTERFACE="${val}"     ;;
    esac
  done <"${CONFIG}"
  [[ "${TG_BOT_TOKEN}" =~ ^[0-9]{5,20}:[A-Za-z0-9_-]{20,100}$ ]] || {
    log_error "TG_BOT_TOKEN invalid."; return 1; }
  [[ "${TG_CHAT_ID}" =~ ^-?[0-9]{5,20}$ ]] || {
    log_error "TG_CHAT_ID invalid."; return 1; }
  [[ "${INTERFACE}" =~ ^[A-Za-z0-9_.:-]{1,15}$ ]] || {
    log_error "INTERFACE invalid."; return 1; }
}

require_cmds() {
  for cmd in curl date hostname jq numfmt vnstat; do
    command -v "${cmd}" >/dev/null 2>&1 || {
      log_error "missing command: ${cmd}"; return 1; }
  done
}

vnstat_json() {
  local out="" i=0
  for i in 1 2 3; do
    out="$(vnstat --json -i "${INTERFACE}" 2>/dev/null)" &&
      jq -e '.interfaces[0].traffic' >/dev/null 2>&1 <<<"${out}" && {
      printf '%s' "${out}"; return 0; }
    sleep 2
  done
  log_error "cannot read traffic data for interface ${INTERFACE}."
  return 1
}

extract_bytes() {
  local json="$1" period="$2" dir="$3" year="$4" month="$5" day="${6:-0}"
  jq -r --arg p "${period}" --arg d "${dir}" \
    --argjson Y "${year}" --argjson M "${month}" --argjson D "${day}" '
    .interfaces[0].traffic[$p]
    | map(select(
        .date.year == $Y
        and .date.month == $M
        and ($p != "day" or .date.day == $D)
      ))
    | first
    | if . == null then 0 else .[$d] // 0 end
  ' <<<"${json}"
}

fmt() {
  local bytes="$1"
  [[ "${bytes}" =~ ^[0-9]+$ ]] || { printf '0B'; return; }
  numfmt --to=iec-i --suffix=B --format='%.2f' "${bytes}"
}

send_tg() {
  local msg="$1" api_url="" resp=""
  api_url="https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage"
  resp="$({
    printf 'url = "%s"\n' "${api_url}"
  } | curl --config - --silent --show-error --fail-with-body \
    --connect-timeout 10 --max-time 30 --retry 2 \
    --request POST \
    --data-urlencode "chat_id=${TG_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    --data "disable_web_page_preview=true")" || {
    log_error "Telegram API request failed."; return 1; }
  jq -e '.ok == true' >/dev/null 2>&1 <<<"${resp}" || {
    log_error "Telegram failed: $(jq -r '.description // "unknown"' <<<"${resp}")"
    return 1
  }
}

build_and_send() {
  local json="" year="" month="" day=""
  local tr_rx=0 tr_tx=0 mr_rx=0 mr_tx=0
  local title="Traffic Report"
  local msg=""

  json="$(vnstat_json)"
  year="$(date '+%Y')"
  month="$((10#$(date '+%m')))"
  day="$((10#$(date '+%d')))"

  tr_rx="$(extract_bytes "${json}" day  rx "${year}" "${month}" "${day}")"
  tr_tx="$(extract_bytes "${json}" day  tx "${year}" "${month}" "${day}")"
  mr_rx="$(extract_bytes "${json}" month rx "${year}" "${month}")"
  mr_tx="$(extract_bytes "${json}" month tx "${year}" "${month}")"

  [[ "${1:-}" == "--test" ]] && title="[Install Test]"

  msg="${title}
Host: $(hostname)
Interface: ${INTERFACE}
Time: $(date '+%F %T %Z')

Today (up to send time)
Inbound:  $(fmt "${tr_rx}")
Outbound: $(fmt "${tr_tx}")
Total:    $(fmt "$((tr_rx + tr_tx))")

Month (${year}-$(printf '%02d' "${month}"))
Inbound:  $(fmt "${mr_rx}")
Outbound: $(fmt "${mr_tx}")
Total:    $(fmt "$((mr_rx + mr_tx))")"

  send_tg "${msg}"
}

main() {
  umask 077; export LC_ALL=C
  load_config; require_cmds; build_and_send "$@"
}

main "$@"
REPORTER_EOF

  install -o root -g root -m 750 "${tmp_report}" "${REPORT_SCRIPT}"
  rm -f "${tmp_report}"
}

write_service_unit() {
  cat >"${SERVICE_FILE}" <<'SERVICE_EOF'
[Unit]
Description=Send vnStat traffic report to Telegram
After=network-online.target vnstat.service
Wants=network-online.target vnstat.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/traffic-telegram-report
User=root
Group=root
UMask=0077
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
RestrictAddressFamilies=AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
SERVICE_EOF
}

write_timer_unit() {
  cat >"${TIMER_FILE}" <<'TIMER_EOF'
[Unit]
Description=Run Telegram traffic report daily at 20:00

[Timer]
OnCalendar=*-*-* 20:00:00
Persistent=true
AccuracySec=1min
Unit=traffic-telegram-report.service

[Install]
WantedBy=timers.target
TIMER_EOF
  systemctl daemon-reload
  systemctl enable --now "${APP_NAME}.timer"
}

send_test() {
  log 'Sending test message...'; "${REPORT_SCRIPT}" --test || \
    die 'Test send failed. Check Bot is in chat and Chat ID is correct.'
}

print_summary() {
  local ifname="$1"
  printf '\nInstall complete.\n'
  printf '  Interface:   %s\n'   "${ifname}"
  printf '  Schedule:    20:00 daily (server local time)\n'
  printf '  Config:      %s (root only)\n'  "${CONFIG_FILE}"
  printf '  Status:      systemctl status %s.timer\n'   "${APP_NAME}"
  printf '  Manual run:  systemctl start %s.service\n'  "${APP_NAME}"
  printf '  Logs:        journalctl -u %s.service\n'    "${APP_NAME}"
  printf '  Uninstall:   bash $0 --uninstall\n'
  if ${VNSTAT_WAS_INSTALLED}; then
    printf '\nNote: vnStat newly installed; stats start now, no backfill.\n'
  else
    printf '\nvnStat existed; historical stats preserved.\n'
  fi
}

uninstall_app() {
  systemctl disable --now "${APP_NAME}.timer" >/dev/null 2>&1 || true
  rm -f "${REPORT_SCRIPT}" "${CONFIG_FILE}" "${SERVICE_FILE}" "${TIMER_FILE}"
  systemctl daemon-reload; systemctl reset-failed >/dev/null 2>&1 || true
  log 'Uninstalled traffic report service; vnStat DB kept.'
}

main() {
  local ifname token chat_id
  require_root
  if [[ "${1:-}" == '--uninstall' ]]; then uninstall_app; return; fi
  check_debian13
  token="$(resolve_token)"; chat_id="$(resolve_chat_id)"
  install_deps
  ifname="$(detect_interface)"
  configure_vnstat "${ifname}"
  write_config "${ifname}" "${token}" "${chat_id}"
  write_reporter
  write_service_unit
  write_timer_unit
  send_test
  print_summary "${ifname}"
}

main "$@"
