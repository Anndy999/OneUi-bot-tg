#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/oneui-bot}"
BOT_SERVICE="${BOT_SERVICE:-oneui-bot.service}"
DOWNLOAD_SERVICE="${DOWNLOAD_SERVICE:-oneui-download.service}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-oneui-postgresql.service}"
REDIS_SERVICE="${REDIS_SERVICE:-oneui-redis.service}"
BOT_ENV_FILE="${BOT_ENV_FILE:-/etc/oneui-bot/oneui-bot.env}"
DOWNLOAD_ENV_FILE="${DOWNLOAD_ENV_FILE:-/etc/oneui-bot/oneui-download.env}"
NODE_BIN="${NODE_BIN:-/home/oneui/.nvm/versions/node/v22.23.2/bin/node}"
NPM_BIN="${NPM_BIN:-/home/oneui/.nvm/versions/node/v22.23.2/bin/npm}"

log() { printf '[oneui-preflight] %s\n' "$*"; }
warn() { printf '[oneui-preflight] WARN: %s\n' "$*" >&2; }
die() { printf '[oneui-preflight] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die 'Run with sudo.'
[[ -d "${PROJECT_DIR}/.git" ]] || die "Not a Git checkout: ${PROJECT_DIR}"
[[ -x "${NODE_BIN}" ]] || die "Node.js executable not found: ${NODE_BIN}"
[[ -x "${NPM_BIN}" ]] || die "npm executable not found: ${NPM_BIN}"
[[ -f "${BOT_ENV_FILE}" ]] || die "Missing protected bot environment file: ${BOT_ENV_FILE}"

for file in "${BOT_ENV_FILE}" "${DOWNLOAD_ENV_FILE}"; do
  [[ -f "${file}" ]] || continue
  mode="$(stat -c '%a' "${file}")"
  (( 8#${mode} <= 8#640 )) || die "Protected environment file is too broadly readable: ${file}"
done

for service in "${POSTGRES_SERVICE}" "${REDIS_SERVICE}"; do
  systemctl is-active --quiet "${service}" || die "Required dependency is not active: ${service}"
done

git -c "safe.directory=${PROJECT_DIR}" -C "${PROJECT_DIR}" rev-parse --verify HEAD >/dev/null
if [[ -n "$(git -c "safe.directory=${PROJECT_DIR}" -C "${PROJECT_DIR}" status --porcelain --untracked-files=all)" ]]; then
  die 'Working tree has local changes; preserve or commit them before updating.'
fi

if systemctl is-active --quiet "${BOT_SERVICE}"; then
  curl -fsS --max-time 3 http://127.0.0.1:8787/health >/dev/null || warn 'Bot service is active but its health endpoint is not ready.'
else
  warn 'Bot service is currently inactive; the update may be a repair deployment.'
fi

if systemctl is-active --quiet "${DOWNLOAD_SERVICE}"; then
  curl -fsS --max-time 3 http://127.0.0.1:8788/health >/dev/null || warn 'Download service is active but its health endpoint is not ready.'
fi

free_bytes="$(df -PB1 "${PROJECT_DIR}" | awk 'NR==2 {print $4}')"
[[ "${free_bytes}" =~ ^[0-9]+$ ]] || die 'Unable to read free disk capacity.'
(( free_bytes >= 5 * 1024 * 1024 * 1024 )) || die 'Less than 5 GiB remains on the project filesystem.'

log 'Passed: protected files, dependencies, checkout, executables, and disk capacity are ready.'
