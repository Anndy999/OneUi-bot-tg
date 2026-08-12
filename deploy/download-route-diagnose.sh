#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE="${DOWNLOAD_SERVICE:-oneui-download.service}"
HEALTH_URL="${DOWNLOAD_HEALTH_URL:-http://127.0.0.1:8788/health}"
DOWNLOAD_DIR="${DOWNLOAD_DIR:-/opt/oneui-bot/data/firmware}"

log() { printf '[oneui-download-diagnose] %s\n' "$*"; }
warn() { printf '[oneui-download-diagnose] WARN: %s\n' "$*" >&2; }

log "service=$(systemctl is-active "${SERVICE}" || true)"
pid="$(systemctl show -p MainPID --value "${SERVICE}" 2>/dev/null || true)"
if [[ "${pid}" =~ ^[1-9][0-9]*$ ]]; then
  ps -p "${pid}" -o pid=,etimes=,%cpu=,%mem=,cmd= || true
  if command -v ss >/dev/null 2>&1; then
    external_connections="$(ss -Htnp state established 2>/dev/null | awk -v pid="pid=${pid}," '$0 ~ pid && $4 !~ /^127\\./ && $5 !~ /^127\\./ {count += 1} END {print count + 0}')"
    log "download-worker-external-tcp-connections=${external_connections}"
  fi
else
  warn 'Download worker PID is unavailable.'
fi

curl -fsS --max-time 5 "${HEALTH_URL}" || warn 'Download health endpoint is unavailable.'
printf '\n'
df -h "${DOWNLOAD_DIR}" || warn "Cannot inspect download directory: ${DOWNLOAD_DIR}"

for key in net.ipv4.tcp_congestion_control net.core.default_qdisc; do
  value="$(sysctl -n "${key}" 2>/dev/null || true)"
  [[ -n "${value}" ]] && log "${key}=${value}"
done

log 'This report intentionally omits FUS URLs, authorization headers, Redis credentials, and environment values.'
