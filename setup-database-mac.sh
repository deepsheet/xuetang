#!/usr/bin/env bash
# ============================================================
# 学徒考勤系统 · macOS / Linux 数据库初始化
# 对应 Windows 版的 setup-database.ps1，三处有意的差异：
#   1) 不修改学生交付的 database/*.sql 原文，运行时动态剥离
#      CREATE DATABASE / USE 语句，把表建进指定库
#   2) 目标库可配置（TARGET_DB，默认 uni），不再强制新建独立库
#   3) 应用账号按「表级」授权，只拿到考勤相关 9 张表的权限，
#      不授予整库 SELECT/INSERT/UPDATE/DELETE
# 用法：
#   ./setup-database-mac.sh              正式执行
#   ./setup-database-mac.sh --dry-run    只打印计划，不写任何东西
#   TARGET_DB=other_db ./setup-database-mac.sh
#   ROOT_PASSWORD=xxx ./setup-database-mac.sh   # root 有密码时
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MYSQL_BIN="${MYSQL_BIN:-/opt/homebrew/opt/mysql@8.0/bin/mysql}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
TARGET_DB="${TARGET_DB:-xueting}"
APP_USER="${APP_USER:-attendance_app}"
MIGRATIONS=("001_init.sql" "002_tasks.sql")
# 考勤系统的全部业务表（统一 xt_ 前缀，学堂拼音），表级授权的作用范围
ATT_TABLES=(
  xt_schema_migrations
  xt_accounts
  xt_number_sequences
  xt_sessions
  xt_attendance_records
  xt_audit_logs
  xt_login_attempts
  xt_app_settings
  xt_tasks
)
# 用于识别“是否已装过本系统”的表
SIGNATURE_TABLE="xt_accounts"
MIGRATION_TABLE="xt_schema_migrations"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if [[ ! -x "$MYSQL_BIN" ]]; then
  echo "找不到可执行的 mysql 客户端：$MYSQL_BIN"
  echo "请用 MYSQL_BIN=/path/to/mysql 指定，例如 brew install mysql@8.0"
  exit 1
fi

if [[ ! -f "$ROOT_DIR/config/database.env" && $DRY_RUN -eq 0 ]]; then
  mkdir -p "$ROOT_DIR/config"
fi

mysql_root() {
  "$MYSQL_BIN" --protocol=TCP --host="$DB_HOST" --port="$DB_PORT" \
    --user=root ${ROOT_PASSWORD:+"-p$ROOT_PASSWORD"} \
    --default-character-set=utf8mb4 "$@"
}

# 剥离 CREATE DATABASE ... ; 代码块和 USE ... ; 行
strip_create_and_use() {
  awk '
    /^CREATE DATABASE/ { skipping = 1 }
    skipping { if ($0 ~ /;[[:space:]]*$/) skipping = 0; next }
    /^USE[[:space:]]/ { next }
    { print }
  ' "$1"
}

echo ""
echo "  学徒考勤系统 · 数据库初始化"
echo "  目标库    : $TARGET_DB"
echo "  应用账号  : $APP_USER@$DB_HOST / $APP_USER@localhost"
echo "  授权粒度  : 表级（${#ATT_TABLES[@]} 张考勤表）"
echo "  MySQL     : $MYSQL_BIN"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  模式      : DRY-RUN（不会写入任何数据）"
fi
echo ""

# ---------- 连通性与目标库存在性检查 ----------
if ! mysql_root -e "SELECT 1;" >/dev/null 2>&1; then
  echo "无法以 root 连接 $DB_HOST:$DB_PORT，请确认 MySQL 已启动、或用 ROOT_PASSWORD 指定密码。"
  exit 1
fi

DB_EXISTS="$(mysql_root -N -B -e \
  "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='$TARGET_DB';")"
if [[ "$DB_EXISTS" != "1" ]]; then
  echo "目标库 $TARGET_DB 不存在。本脚本不会自动建库（你要求复用现有库）。"
  exit 1
fi

# ---------- 判断目标库里是否已装过本系统（用表结构特征签名，不盲信表名）----------
IN_LIST="$(printf "'%s'," "${ATT_TABLES[@]}")"
IN_LIST="${IN_LIST%,}"

# xt_accounts 表同时存在这 4 列，才认为是考勤系统自己的表，而非别的项目的同名表
SIGNATURE="$(mysql_root -N -B -e \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema='$TARGET_DB' AND table_name='${SIGNATURE_TABLE}'
   AND column_name IN ('number','password_hash','number_type','must_change_password');" || echo 0)"
MIG_TABLE="$(mysql_root -N -B -e \
  "SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema='$TARGET_DB' AND table_name='${MIGRATION_TABLE}';")"

RUN_MODE="fresh"
if [[ "$MIG_TABLE" == "1" && "$SIGNATURE" == "4" ]]; then
  RUN_MODE="rerun"
  echo "检测到 $TARGET_DB 已装过考勤系统表结构，本次为幂等重跑（只补建缺失表 + 重新授权）。"
fi

# ---------- 只在首次执行时检查同名表冲突 ----------
if [[ "$RUN_MODE" == "fresh" ]]; then
  CONFLICTS="$(mysql_root -N -B -e \
    "SELECT table_name FROM information_schema.tables
     WHERE table_schema='$TARGET_DB' AND table_name IN ($IN_LIST)
     AND table_name <> '${MIGRATION_TABLE}';" || true)"

  if [[ -n "$CONFLICTS" ]]; then
    echo "注意：$TARGET_DB 里已存在同名表，但它们不具有考勤系统的列特征："
    echo "$CONFLICTS" | sed 's/^/  - /'
    echo "这些很可能是你其他项目的表。为避免误写业务数据，本脚本拒绝继续。"
    echo "请换一个库（TARGET_DB=xxx ./setup-database-mac.sh）或确认后再处理。"
    exit 1
  fi
fi

# ---------- 生成应用密码 ----------
# 注意：不能用 `tr </dev/urandom | head -c N`，head 提前关闭管道会让
# 上游 tr 收到 SIGPIPE，配合 set -o pipefail 会静默终止整个脚本。
# 这里先 dd 固定字节数，再用 tr/cut 全量读取到 EOF，避免 SIGPIPE。
gen_password() {
  local pwd_value=""
  while [[ ${#pwd_value} -lt 24 ]]; do
    pwd_value="$(dd if=/dev/urandom bs=512 count=1 2>/dev/null \
      | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-24)"
  done
  printf '%s' "$pwd_value"
}
APP_PASSWORD="$(gen_password)"
if [[ ${#APP_PASSWORD} -lt 24 ]]; then
  echo "生成应用密码失败。"
  exit 1
fi

SETUP_SQL="$(cat <<SQL
CREATE USER IF NOT EXISTS '${APP_USER}'@'127.0.0.1' IDENTIFIED BY '${APP_PASSWORD}';
ALTER USER '${APP_USER}'@'127.0.0.1' IDENTIFIED BY '${APP_PASSWORD}';
CREATE USER IF NOT EXISTS '${APP_USER}'@'localhost' IDENTIFIED BY '${APP_PASSWORD}';
ALTER USER '${APP_USER}'@'localhost' IDENTIFIED BY '${APP_PASSWORD}';
SQL
)"
SETUP_SQL+=$'\n'
for table in "${ATT_TABLES[@]}"; do
  SETUP_SQL+="GRANT SELECT, INSERT, UPDATE, DELETE ON \`${TARGET_DB}\`.\`${table}\` TO '${APP_USER}'@'127.0.0.1';
"
  SETUP_SQL+="GRANT SELECT, INSERT, UPDATE, DELETE ON \`${TARGET_DB}\`.\`${table}\` TO '${APP_USER}'@'localhost';
"
done
SETUP_SQL+="FLUSH PRIVILEGES;"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "== 将要执行的账号/授权语句（密码已隐藏）=="
  printf '%s\n' "$SETUP_SQL" | sed "s/${APP_PASSWORD}/************/g"
  echo ""
  echo "== 将要执行的迁移 =="
  for migration in "${MIGRATIONS[@]}"; do
    echo "  - database/$migration  (已剥离 CREATE DATABASE / USE)"
  done
  echo ""
  echo "DRY-RUN 结束，未做任何修改。"
  exit 0
fi

# ---------- 1. 先建表（表级授权要求表存在，否则授权不生效） ----------
echo "== 执行表结构迁移"
for migration in "${MIGRATIONS[@]}"; do
  migration_file="$ROOT_DIR/database/$migration"
  if [[ ! -f "$migration_file" ]]; then
    echo "缺少迁移文件：$migration_file"
    exit 1
  fi
  strip_create_and_use "$migration_file" | \
    mysql_root --database="$TARGET_DB" >/dev/null
  echo "  已完成 $migration"
done

# ---------- 2. 建账号 + 表级授权 ----------
echo ""
echo "== 创建应用账号并按表授权"
printf '%s\n' "$SETUP_SQL" | mysql_root

# ---------- 3. 写配置文件 ----------
ENV_FILE="$ROOT_DIR/config/database.env"
cat >"$ENV_FILE" <<ENV
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$TARGET_DB
DB_USER=$APP_USER
DB_PASSWORD=$APP_PASSWORD
DB_CHARSET=utf8mb4
ENV
chmod 600 "$ENV_FILE"

# ---------- 4. 验证应用账号确实只能碰考勤表 ----------
echo ""
echo "== 验证应用账号权限边界"
# 注意：MySQL 8.0 的 information_schema.table_privileges 在表级授权下
# 可能返回空，不能用来判定权限；SHOW GRANTS 才是权威来源。
TOTAL="$(mysql_root -N -B -e "SHOW GRANTS FOR '${APP_USER}'@'127.0.0.1';" \
  | grep -c "\`${TARGET_DB}\`\." || true)"
DB_WIDE="$(mysql_root -N -B -e "SHOW GRANTS FOR '${APP_USER}'@'127.0.0.1';" \
  | grep -cE "ON \`(\*|${TARGET_DB})\`\.\*|ON ${TARGET_DB}\.\*" || true)"

TABLES_CREATED="$(mysql_root -N -B -e \
  "SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema='$TARGET_DB' AND table_name IN ($IN_LIST);")"
GENERATED_COLS="$(mysql_root -N -B -e \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema='$TARGET_DB' AND table_name='xt_attendance_records'
   AND generation_expression <> '';")"
CHECK_CN="$(mysql_root -N -B -e \
  "SELECT COUNT(*) FROM information_schema.check_constraints
   WHERE constraint_schema='$TARGET_DB';")"

echo ""
echo "数据库初始化完成。"
echo "  库            : $TARGET_DB"
echo "  考勤表数量    : $TABLES_CREATED / ${#ATT_TABLES[@]}"
echo "  应用账号      : $APP_USER"
echo "  可访问表数    : ${TOTAL} （应等于 ${#ATT_TABLES[@]}）"
echo "  整库级授权条数: $DB_WIDE （必须为 0，否则说明权限被放大到全库）"
echo "  生成列数量    : $GENERATED_COLS / 2 （duration_seconds, active_account_id）"
echo "  CHECK 约束数  : $CHECK_CN"
echo "  应用密码      : $APP_PASSWORD"
echo ""
echo "配置已写入：config/database.env（权限 600，已被 .gitignore 忽略）"
echo "下一步：./start-mac.sh 启动网站，首次打开会显示管理员初始化页面。"
echo ""
