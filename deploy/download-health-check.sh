#!/usr/bin/env bash
set -Eeuo pipefail

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8788/health
printf '\n'
