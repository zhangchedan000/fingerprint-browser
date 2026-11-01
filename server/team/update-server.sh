#!/bin/bash
# Updates a running team server's program (hooks, migrations, compose, start.sh) from this folder,
# keeping pb_data and .env. Run as root from a checkout of the repo:
#   ./update-server.sh /opt/prism-team https://team.example.com
# Before anything changes: pb_data is packed to <target>-pbdata-<time>.tgz and the old program
# files are kept in <target>/rollback-<time>/ (copy them back and `docker compose up -d` to undo).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=${1:?target folder}
URL=${2:?public https address of this server}
T=$(date -u +%Y%m%d%H%M%S)
cd "$TARGET"
mkdir -p "rollback-$T"
cp -r pb_hooks pb_migrations docker-compose.yml Dockerfile "rollback-$T/"
[ -f start.sh ] && cp start.sh "rollback-$T/"
docker compose stop
tar czf "$TARGET-pbdata-$T.tgz" -C "$TARGET" pb_data
cp -r "$HERE/pb_hooks/." pb_hooks/
cp -r "$HERE/pb_migrations/." pb_migrations/
cp "$HERE/Dockerfile" "$HERE/docker-compose.yml" "$HERE/start.sh" "$HERE/r2-restore.sh" .
grep -q '^TEAM_PUBLIC_URL=' .env || printf 'TEAM_PUBLIC_URL=%s\n' "$URL" >> .env
docker compose up -d
for i in $(seq 1 60); do curl -sf http://127.0.0.1:8090/api/health >/dev/null && break; sleep 1; done
echo "backup: $TARGET-pbdata-$T.tgz  rollback files: $TARGET/rollback-$T"
curl -s "$URL/api/team/status"; echo
