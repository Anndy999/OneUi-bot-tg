#!/usr/bin/env bash
set -Eeuo pipefail

# One-time VPS bootstrap for the isolated OneUI runtime.
# Run as root from the VPS: sudo bash /opt/oneui-bot/deploy/oneui-vps-bootstrap.sh

PROJECT_DIR="/opt/oneui-bot"
APP_USER="oneui"
PG_SERVICE="oneui-postgresql.service"
REDIS_SERVICE="oneui-redis.service"
APP_SERVICE="oneui-bot.service"
PG_PORT="55432"
REDIS_PORT="56379"
APP_PORT="8787"
NODE_BIN="/home/oneui/.nvm/versions/node/v22.23.2/bin/node"
NPM_BIN="/home/oneui/.nvm/versions/node/v22.23.2/bin/npm"
PG_DATA_DIR="/var/lib/oneui-postgresql/data"
REDIS_DATA_DIR="/var/lib/oneui-redis"
SYSTEM_DIR="/etc/oneui-bot"
ENV_FILE="${SYSTEM_DIR}/oneui-bot.env"
SNAPSHOT="${PROJECT_DIR}/migration-data/cloudflare-monitor-state.json"

log() { printf '[oneui-bootstrap] %s\n' "$*"; }
die() { printf '[oneui-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

POLICY_RC_BACKUP=""
restore_policy_rc() {
  if [[ -n "${POLICY_RC_BACKUP}" && -f "${POLICY_RC_BACKUP}" ]]; then
    cp -p "${POLICY_RC_BACKUP}" /usr/sbin/policy-rc.d
    rm -f "${POLICY_RC_BACKUP}"
  elif [[ "${POLICY_RC_BACKUP}" == "__oneui_absent__" ]]; then
    rm -f /usr/sbin/policy-rc.d
  fi
}
trap restore_policy_rc EXIT

[[ "${EUID}" -eq 0 ]] || die "请使用 sudo 运行此脚本。"
[[ -d "${PROJECT_DIR}" && -f "${PROJECT_DIR}/package.json" ]] || die "项目目录不存在：${PROJECT_DIR}"
id "${APP_USER}" >/dev/null 2>&1 || die "系统用户不存在：${APP_USER}"
[[ -x "${NODE_BIN}" && -x "${NPM_BIN}" ]] || die "未找到 OneUI Node.js/npm：${NODE_BIN}"

if [[ -e "/etc/systemd/system/${APP_SERVICE}" ]]; then
  die "检测到已有 ${APP_SERVICE}，为避免覆盖现有服务，脚本停止。"
fi

if [[ -e "/etc/systemd/system/${PG_SERVICE}" || -e "/etc/systemd/system/${REDIS_SERVICE}" ]]; then
  die "检测到已有 OneUI 专用 systemd 单元；为避免覆盖或删除现有配置，脚本停止。"
fi

if [[ -e "${ENV_FILE}" ]]; then
  die "检测到已有 ${ENV_FILE}，脚本不会覆盖现有密钥配置。"
fi

if systemctl is-active --quiet postgresql.service 2>/dev/null || systemctl is-active --quiet redis-server.service 2>/dev/null; then
  die "检测到默认 PostgreSQL 或 Redis 正在运行；脚本不会触碰现有服务。"
fi

read -r -s -p "请输入 Telegram Bot Token（输入不回显）：" TELEGRAM_BOT_TOKEN
printf '\n'
[[ -n "${TELEGRAM_BOT_TOKEN}" ]] || die "TELEGRAM_BOT_TOKEN 不能为空。"
read -r -p "请输入 Telegram 管理员 Chat ID：" TELEGRAM_CHAT_ID
[[ -n "${TELEGRAM_CHAT_ID}" ]] || die "TELEGRAM_CHAT_ID 不能为空。"

log "安装 PostgreSQL 和 Redis 软件包；不会启动或修改同名默认服务。"
export DEBIAN_FRONTEND=noninteractive
# Prevent package post-install scripts from starting default services.
if [[ -e /usr/sbin/policy-rc.d ]]; then
  POLICY_RC_BACKUP="$(mktemp)"
  cp -p /usr/sbin/policy-rc.d "${POLICY_RC_BACKUP}"
else
  POLICY_RC_BACKUP="__oneui_absent__"
fi
cat > /usr/sbin/policy-rc.d <<'EOF'
#!/bin/sh
exit 101
EOF
chmod 755 /usr/sbin/policy-rc.d
apt-get update
apt-get install -y postgresql postgresql-client redis-server openssl curl
restore_policy_rc
trap - EXIT

command -v systemctl >/dev/null || die "systemd 不可用。"
if [[ ! -d "${PROJECT_DIR}/node_modules" ]]; then
  log "项目依赖目录不存在，执行 npm ci --ignore-scripts。"
  runuser -u oneui -- env HOME=/home/oneui "${NPM_BIN}" ci --ignore-scripts --prefix "${PROJECT_DIR}"
fi
PG_BIN_DIR="$(pg_config --bindir)"
[[ -x "${PG_BIN_DIR}/initdb" && -x "${PG_BIN_DIR}/postgres" ]] || die "未找到 PostgreSQL 初始化程序。"

if ! id oneui-postgres >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/oneui-postgresql --shell /usr/sbin/nologin oneui-postgres
fi
if ! id oneui-redis >/dev/null 2>&1; then
  useradd --system --home-dir "${REDIS_DATA_DIR}" --shell /usr/sbin/nologin oneui-redis
fi

install -d -o oneui-postgres -g oneui-postgres -m 700 "${PG_DATA_DIR}"
install -d -o oneui-redis -g oneui-redis -m 750 "${REDIS_DATA_DIR}"
install -d -o root -g oneui -m 751 "${SYSTEM_DIR}"

if [[ ! -f "${PG_DATA_DIR}/PG_VERSION" ]]; then
  runuser -u oneui-postgres -- "${PG_BIN_DIR}/initdb" \
    --pgdata="${PG_DATA_DIR}" \
    --username=oneui-postgres \
    --auth-local=peer \
    --auth-host=scram-sha-256 >/dev/null
else
  log "PostgreSQL 数据目录已初始化，保留现有 OneUI 专用数据。"
fi

PG_PASSWORD="$(openssl rand -hex 32)"
REDIS_PASSWORD="$(openssl rand -hex 32)"
generated_webhook_secret="$(openssl rand -hex 32)"
WEBHOOK_SECRET="$generated_webhook_secret"
INTERNAL_API_SECRET="$(openssl rand -hex 32)"

cat > "${PG_DATA_DIR}/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = ${PG_PORT}
unix_socket_directories = '/run/oneui-postgresql'
password_encryption = 'scram-sha-256'
EOF
cat > "${PG_DATA_DIR}/pg_hba.conf" <<EOF
local   all             postgres                                peer
local   all             all                                     peer
host    all             oneui_app       127.0.0.1/32            scram-sha-256
host    all             all             127.0.0.1/32            reject
EOF
chown oneui-postgres:oneui-postgres "${PG_DATA_DIR}/postgresql.conf" "${PG_DATA_DIR}/pg_hba.conf"
chmod 600 "${PG_DATA_DIR}/postgresql.conf" "${PG_DATA_DIR}/pg_hba.conf"

cat > "/etc/systemd/system/${PG_SERVICE}" <<EOF
[Unit]
Description=OneUI isolated PostgreSQL
After=network.target

[Service]
Type=notify
User=oneui-postgres
Group=oneui-postgres
RuntimeDirectory=oneui-postgresql
RuntimeDirectoryMode=0750
ExecStart=${PG_BIN_DIR}/postgres -D ${PG_DATA_DIR} -c config_file=${PG_DATA_DIR}/postgresql.conf
ExecReload=/bin/kill -HUP \$MAINPID
KillMode=mixed
TimeoutSec=120
OOMScoreAdjust=-900

[Install]
WantedBy=multi-user.target
EOF

cat > "${SYSTEM_DIR}/redis.conf" <<EOF
bind 127.0.0.1
port ${REDIS_PORT}
protected-mode yes
requirepass ${REDIS_PASSWORD}
dir ${REDIS_DATA_DIR}
dbfilename dump.rdb
appendonly yes
appendfilename appendonly.aof
save 900 1
save 300 10
save 60 10000
logfile ""
supervised systemd
pidfile ""
EOF
chown root:oneui-redis "${SYSTEM_DIR}/redis.conf"
chmod 640 "${SYSTEM_DIR}/redis.conf"

cat > "/etc/systemd/system/${REDIS_SERVICE}" <<EOF
[Unit]
Description=OneUI isolated Redis
After=network.target

[Service]
Type=notify
User=oneui-redis
Group=oneui-redis
ExecStart=/usr/bin/redis-server ${SYSTEM_DIR}/redis.conf
ExecStop=/bin/kill -TERM \$MAINPID
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${REDIS_DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${PG_SERVICE}"
systemctl enable --now "${REDIS_SERVICE}"

for _ in $(seq 1 30); do
  if runuser -u oneui-postgres -- "${PG_BIN_DIR}/psql" -h /run/oneui-postgresql -p "${PG_PORT}" -d postgres -Atqc 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
runuser -u oneui-postgres -- "${PG_BIN_DIR}/psql" -h /run/oneui-postgresql -p "${PG_PORT}" -d postgres -Atqc 'SELECT 1' >/dev/null || die "OneUI PostgreSQL 启动失败。"

if ! runuser -u oneui-postgres -- "${PG_BIN_DIR}/psql" -h /run/oneui-postgresql -p "${PG_PORT}" -d postgres -Atqc "SELECT 1 FROM pg_roles WHERE rolname='oneui_app'" | grep -q '^1$'; then
  runuser -u oneui-postgres -- "${PG_BIN_DIR}/psql" -h /run/oneui-postgresql -p "${PG_PORT}" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE oneui_app LOGIN PASSWORD '${PG_PASSWORD}';"
else
  die "数据库角色 oneui_app 已存在；为避免覆盖密码，脚本停止。"
fi

if ! runuser -u oneui-postgres -- "${PG_BIN_DIR}/psql" -h /run/oneui-postgresql -p "${PG_PORT}" -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='oneui'" | grep -q '^1$'; then
  runuser -u oneui-postgres -- "${PG_BIN_DIR}/createdb" -h /run/oneui-postgresql -p "${PG_PORT}" -O oneui_app oneui
else
  die "数据库 oneui 已存在；为避免覆盖现有数据，脚本停止。"
fi

cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
VPS_PORT=${APP_PORT}
DATABASE_URL=postgresql://oneui_app:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/oneui
REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:${REDIS_PORT}/0
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
WEBHOOK_SECRET=$WEBHOOK_SECRET
INTERNAL_API_SECRET=${INTERNAL_API_SECRET}
TELEGRAM_SEND_ENABLED=true
TELEGRAM_POLLING_ENABLED=true
VPS_SHADOW_MODE=false
MONITOR_NOTIFICATIONS_ENABLED=true
TELEGRAM_COMMAND_SYNC_ENABLED=true
TELEGRAM_WEBHOOK_AUTOFIX_ENABLED=false
MONITOR_SCHEDULER_ENABLED=true
NOTIFICATION_QUEUE_ENABLED=true
QUEUE_PREFIX=oneui
EOF
chown root:oneui "${ENV_FILE}"
chmod 640 "${ENV_FILE}"

log "执行数据库迁移。"
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a
runuser -u oneui -- env DATABASE_URL="${DATABASE_URL}" "${NODE_BIN}" "${PROJECT_DIR}/scripts/migrate-vps.mjs"

if [[ -f "${SNAPSHOT}" ]]; then
  log "导入 Cloudflare 导出的 OneUI 用户配置；不输出快照内容。"
  runuser -u oneui -- env DATABASE_URL="${DATABASE_URL}" "${NODE_BIN}" "${PROJECT_DIR}/scripts/import-cloudflare-state.mjs" "${SNAPSHOT}"
else
  die "缺少 Cloudflare 导出快照：${SNAPSHOT}"
fi

cat > "/etc/systemd/system/${APP_SERVICE}" <<EOF
[Unit]
Description=OneUI Firmware Telegram Bot
Requires=${PG_SERVICE} ${REDIS_SERVICE}
After=network-online.target ${PG_SERVICE} ${REDIS_SERVICE}
Wants=network-online.target

[Service]
Type=simple
User=oneui
Group=oneui
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${ENV_FILE}
ExecStart=/home/oneui/.nvm/versions/node/v22.23.2/bin/node ${PROJECT_DIR}/src/vps/production-server.js
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${PROJECT_DIR}
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
EOF

log "保留 Telegram 当前 Webhook 状态；脚本不会调用 deleteWebhook 或 setWebhook。"
log "启用长轮询前，请由管理员确认该 Bot Token 没有现存 Webhook，且没有其他轮询进程。"

systemctl daemon-reload
systemctl enable --now "${APP_SERVICE}"

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 5 "http://127.0.0.1:${APP_PORT}/health" >/dev/null || die "OneUI 健康检查失败，请查看：journalctl -u ${APP_SERVICE} -n 80 --no-pager"

log "完成：OneUI PostgreSQL、Redis、长轮询和开机自启动已配置。"
log "服务状态：${PG_SERVICE}、${REDIS_SERVICE}、${APP_SERVICE}"
log "应用仅监听本机 ${APP_PORT}；数据库和 Redis 仅监听本机。"
