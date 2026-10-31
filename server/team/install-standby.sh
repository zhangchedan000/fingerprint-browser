#!/bin/bash
# Installs the team server as a standby on a machine whose web front is the host's nginx + certbot
# (one file per site in /etc/nginx/sites-enabled). Run as root from this folder (a checkout of the repo):
#   ./install-standby.sh /opt/prism-team https://b.example.com
# It writes .env once (a new TEAM_SETUP_CODE = the activation code, TEAM_PUBLIC_URL), starts the
# container on 127.0.0.1:8090 and adds the site with a certificate. Nothing else of nginx is touched.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=${1:?target folder}
URL=${2:?public https address}
DOMAIN=${URL#https://}
mkdir -p "$TARGET/pb_data"
cp -r "$HERE/pb_hooks" "$HERE/pb_migrations" "$TARGET/"
cp "$HERE/Dockerfile" "$HERE/docker-compose.yml" "$HERE/start.sh" "$HERE/r2-restore.sh" "$TARGET/"
if [ ! -f "$TARGET/.env" ]; then
  (umask 077; printf 'TEAM_SETUP_CODE=%s\nTEAM_PUBLIC_URL=%s\nPROXY_NETWORK=prism-team-proxy\n' "$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" "$URL" > "$TARGET/.env")
fi
docker network inspect prism-team-proxy >/dev/null 2>&1 || docker network create prism-team-proxy >/dev/null
cd "$TARGET" && docker compose up -d --build
for i in $(seq 1 60); do curl -sf http://127.0.0.1:8090/api/health >/dev/null && break; sleep 1; done
SITE=/etc/nginx/sites-enabled/$DOMAIN.conf
if [ ! -f "$SITE" ]; then
  cat > "$SITE" <<NGINX
# Team standby server (fingerprint-browser server/team), installed by install-standby.sh.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 2048m;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
NGINX
  nginx -t && systemctl reload nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi
curl -s "$URL/api/team/status"; echo
