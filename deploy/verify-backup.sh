#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir="${1:-${BACKUP_DIR:-/opt/oneui-backups}}"

die() { printf '[oneui-backup-verify] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[oneui-backup-verify] %s\n' "$*"; }

[[ -d "${backup_dir}" ]] || die "Backup directory does not exist: ${backup_dir}"
command -v pg_restore >/dev/null 2>&1 || die 'pg_restore is required to verify PostgreSQL dumps.'
command -v tar >/dev/null 2>&1 || die 'tar is required to verify project archives.'

database_dump="$(find "${backup_dir}" -maxdepth 1 -type f -name 'postgres-*.dump' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)"
project_archive="$(find "${backup_dir}" -maxdepth 1 -type f -name 'project-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)"
[[ -n "${database_dump}" ]] || die 'No PostgreSQL dump was found.'
[[ -n "${project_archive}" ]] || die 'No project archive was found.'

pg_restore --list "${database_dump}" >/dev/null
tar -tzf "${project_archive}" >/dev/null
log "Verified newest PostgreSQL dump and project archive in ${backup_dir}."
