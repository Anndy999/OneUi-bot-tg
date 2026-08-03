#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="/opt/oneui-bot"
SERVICE="oneui-bot.service"
ENV_FILE="/etc/oneui-bot/oneui-bot.env"
HEALTH_URL="http://127.0.0.1:8787/health"
NPM_BIN="/home/oneui/.nvm/versions/node/v22.23.2/bin/npm"

log() { printf "[oneui-update] %s\n" "$*"; }
die() { printf "[oneui-update] ERROR: %s\n" "$*" >&2; exit 1; }
git_cmd() { git -c "safe.directory=${PROJECT_DIR}" "$@"; }

[[ "${EUID}" -eq 0 ]] || die "请使用 sudo 运行此脚本。"
[[ -d "${PROJECT_DIR}/.git" ]] || die "项目尚未配置 Git 仓库。"
[[ -f "${ENV_FILE}" ]] || die "缺少运行时环境文件：${ENV_FILE}"
[[ -x "${NPM_BIN}" ]] || die "未找到 OneUI Node.js/npm：${NPM_BIN}"

cd "${PROJECT_DIR}"
branch="$(git_cmd branch --show-current)"
[[ "${branch}" == "main" ]] || die "当前分支不是 main：${branch}"
[[ -z "$(git_cmd status --porcelain --untracked-files=all)" ]] || die "工作目录有未提交变更，停止更新以避免覆盖本地修改。"

previous_commit="$(git_cmd rev-parse HEAD)"
log "从 origin/main 获取更新。"
git_cmd fetch --prune origin main
git_cmd pull --ff-only origin main

if [[ "$(git_cmd rev-parse HEAD)" == "${previous_commit}" ]]; then
  log "没有新的代码提交，重新验证当前部署。"
fi

log "安装锁定依赖。"
"${NPM_BIN}" ci --ignore-scripts
log "运行测试。"
"${NPM_BIN}" test
log "运行安全扫描。"
"${NPM_BIN}" run security-check
log "运行生产依赖审计。"
"${NPM_BIN}" audit --omit=dev --audit-level=high

systemctl daemon-reload
log "仅重启 ${SERVICE}。PostgreSQL 和 Redis 不重启。"
systemctl restart "${SERVICE}"

for _ in $(seq 1 30); do
  if systemctl is-active --quiet "${SERVICE}" && curl -fsS --max-time 2 "${HEALTH_URL}" >/dev/null; then
    log "更新成功，健康检查通过。"
    systemctl is-active "${SERVICE}"
    exit 0
  fi
  sleep 1
done

systemctl status "${SERVICE}" --no-pager -l || true
journalctl -u "${SERVICE}" -n 80 --no-pager || true
die "更新后健康检查失败；未自动覆盖本地 Git 状态。"
