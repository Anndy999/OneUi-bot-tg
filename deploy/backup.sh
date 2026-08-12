#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="${PROJECT_DIR:-/opt/oneui-bot}"
backup_dir="${BACKUP_DIR:-/opt/oneui-backups}"
env_file="${ONEUI_ENV_FILE:-/etc/oneui-bot/oneui-bot.env}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ -z "${DATABASE_URL:-}" && -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL must be provided through the protected environment" >&2
  exit 1
fi
command -v pg_dump >/dev/null 2>&1 || {
  echo "pg_dump is required for the PostgreSQL backup" >&2
  exit 1
}
command -v tar >/dev/null 2>&1 || {
  echo "tar is required for the project backup" >&2
  exit 1
}

mkdir -p "$backup_dir"
database_dump="$backup_dir/postgres-$timestamp.dump"
project_archive="$backup_dir/project-$timestamp.tar.gz"

pg_dump --dbname="$DATABASE_URL" --format=custom --file="$database_dump"
tar --directory="$project_dir" \
  --exclude='./node_modules' \
  --exclude='./.npm-cache' \
  --exclude='./backups' \
  --exclude='./data/firmware' \
  --exclude='./.env*' \
  --exclude='./*.log' \
  --create --gzip --file="$project_archive" .

printf 'PostgreSQL backup: %s\nProject backup: %s\n' "$database_dump" "$project_archive"
printf 'Firmware payloads are intentionally excluded; the download-state index is retained.\n'
