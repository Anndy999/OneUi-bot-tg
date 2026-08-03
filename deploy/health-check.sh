#!/usr/bin/env bash
set -euo pipefail

host="${VPS_HOST:-127.0.0.1}"
port="${VPS_PORT:-8787}"
url="http://${host}:${port}/health"

command -v curl >/dev/null 2>&1 || {
  echo "curl is required for the health check" >&2
  exit 1
}

curl --fail --silent --show-error --max-time 10 "$url"
printf '\n'
