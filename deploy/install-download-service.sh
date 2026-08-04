#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="/opt/oneui-bot"
SERVICE="oneui-download.service"
UNIT_SOURCE="${PROJECT_DIR}/deploy/${SERVICE}"
UNIT_TARGET="/etc/systemd/system/${SERVICE}"
ENV_FILE="/etc/oneui-bot/oneui-download.env"
DOWNLOAD_DIR="${PROJECT_DIR}/data/firmware"
DOWNLOAD_INDEX_DIR="${PROJECT_DIR}/data/download-state"

log() { printf '[oneui-download-install] %s\n' "$*"; }
die() { printf '[oneui-download-install] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "请使用 sudo 运行此脚本。"
[[ -d "${PROJECT_DIR}/.git" ]] || die "项目目录不存在或不是 Git 仓库：${PROJECT_DIR}"
[[ -f "${UNIT_SOURCE}" ]] || die "缺少服务文件：${UNIT_SOURCE}"
[[ -f "${ENV_FILE}" ]] || die "请先创建受保护的环境文件：${ENV_FILE}"
id oneui >/dev/null 2>&1 || die "系统用户 oneui 不存在。"

if [[ -e "${UNIT_TARGET}" ]] && ! cmp -s "${UNIT_SOURCE}" "${UNIT_TARGET}"; then
  die "检测到已有 ${SERVICE} 且内容不同，为避免覆盖现有服务，脚本停止。"
fi

install -d -o oneui -g oneui -m 0750 "${DOWNLOAD_DIR}"
install -d -o oneui -g oneui -m 0750 "${DOWNLOAD_INDEX_DIR}"
install -m 0644 -o root -g root "${UNIT_SOURCE}" "${UNIT_TARGET}"
systemctl daemon-reload
systemctl enable --now "${SERVICE}"

for _ in $(seq 1 30); do
  if systemctl is-active --quiet "${SERVICE}" && curl -fsS --max-time 2 http://127.0.0.1:8788/health >/dev/null; then
    log "下载接口已启动，仅监听本机 127.0.0.1:8788。"
    exit 0
  fi
  sleep 1
done

systemctl status "${SERVICE}" --no-pager -l || true
journalctl -u "${SERVICE}" -n 80 --no-pager || true
die "下载接口启动或健康检查失败。"
