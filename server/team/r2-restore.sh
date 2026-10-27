#!/bin/bash
# Restores the team server from its R2 backup: the newest database copy (or the one named) and
# the login states. The current pb_data is kept as pb_data.before-restore-<time>. Run it on the
# server in the deploy folder (sudo).
#   ./r2-restore.sh              shows what it would restore
#   ./r2-restore.sh --yes        restores the newest copy
#   ./r2-restore.sh --yes 20261027T120000Z.db.gz
set -euo pipefail
cd "$(dirname "$0")"
CONFIG=pb_data/r2.env
[ -f "$CONFIG" ] || { echo "没有开启异地备份（$CONFIG 不存在）"; exit 1; }
val() { grep "^$1=" "$CONFIG" | cut -d= -f2-; }
export RCLONE_CONFIG_R2_TYPE=${RCLONE_CONFIG_R2_TYPE:-s3} RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_ENDPOINT=$(val R2_ENDPOINT)
export RCLONE_CONFIG_R2_ACCESS_KEY_ID=$(val R2_ACCESS_KEY_ID)
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$(val R2_SECRET_ACCESS_KEY)
R="r2:$(val R2_BUCKET)"
rc() { docker compose run --rm --no-deps -T --entrypoint rclone $(env | grep -o '^RCLONE_CONFIG_R2_[A-Z_]*' | sed 's/^/-e /') prism-team "$@"; }

YES=""
[ "${1:-}" = "--yes" ] && { YES=1; shift; }
NAME=${1:-$(rc lsf "$R/db" | grep '\.db\.gz$' | sort | tail -1)}
[ -n "$NAME" ] || { echo "R2 上没有数据库备份"; exit 1; }
echo "数据库：$R/db/$NAME"
echo "登录态：$R/storage（$(rc size "$R/storage" 2>/dev/null | tr '\n' ' ')）"
[ -n "$YES" ] || { echo "确认无误后加 --yes 再运行"; exit 0; }

STAMP=$(date -u +%Y%m%d%H%M%S)
docker compose stop prism-team
mv pb_data "pb_data.before-restore-$STAMP"
mkdir pb_data
# The R2 settings stay, so backups go on after the restore.
cp -p "pb_data.before-restore-$STAMP/r2.env" pb_data/
rc copyto "$R/db/$NAME" /pb/pb_data/data.db.gz
gunzip pb_data/data.db.gz
rc copy "$R/storage" /pb/pb_data/storage
docker compose start prism-team
echo "已恢复。原来的数据在 pb_data.before-restore-$STAMP"
