#!/bin/sh
# Starts PocketBase. After /api/team/activate (control.pb.js) pulled the newest data from R2 into
# pb_data/.restore, the pulled database, login states and files are swapped in first; the old
# ones are kept in pb_data/before-restore-<time>/.
D=${TEAM_DATA_DIR:-/pb/pb_data}
R=$D/.restore
if [ -f "$R/ready" ] && [ -f "$R/data.db" ]; then
  T=$(date -u +%Y%m%d%H%M%S)
  K=$D/before-restore-$T
  mkdir -p "$K"
  [ -f "$D/data.db" ] && mv "$D/data.db" "$K/"
  rm -f "$D/data.db-wal" "$D/data.db-shm"
  for d in storage assets; do
    if [ -d "$R/$d" ]; then
      [ -d "$D/$d" ] && mv "$D/$d" "$K/"
      mv "$R/$d" "$D/$d"
    fi
  done
  mv "$R/data.db" "$D/data.db"
  echo "restored $(cat "$R/ready") ($K keeps the old files)"
  rm -rf "$R"
fi
exec ${PB_BIN:-/pb/pocketbase} serve --http=${PB_HTTP:-0.0.0.0:8090} --dir="$D" --hooksDir=${PB_HOOKS:-/pb/pb_hooks} --migrationsDir=${PB_MIGRATIONS:-/pb/pb_migrations}
