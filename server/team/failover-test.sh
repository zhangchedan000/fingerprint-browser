#!/bin/bash
# Failover test without containers: two PocketBase servers (A on 8091, B on 8092) sharing a local
# folder as the "R2" bucket (rclone type local). Needs pocketbase (PB_BIN), rclone, curl, python3.
#   PB_BIN=/path/to/pocketbase ./failover-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d /tmp/prism-failover-XXXXXX)
PB_BIN=${PB_BIN:?pocketbase binary}
export RCLONE_CONFIG_R2_TYPE=local
A=http://127.0.0.1:8091; B=http://127.0.0.1:8092
FAILS=0
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
say() { echo "== $*"; }
ok() { if [ "$1" = "$2" ]; then echo "   PASS $3 ($1)"; else echo "   FAIL $3: got [$1] want [$2]"; FAILS=$((FAILS+1)); fi; }

serve() { # name port code
  mkdir -p "$W/$1/pb_data"
  ( cd "$W" && while [ ! -f "$W/$1/stop" ]; do
      TEAM_DATA_DIR="$W/$1/pb_data" TEAM_PUBLIC_URL="http://127.0.0.1:$2" TEAM_SETUP_CODE="$3" PB_BIN="$PB_BIN" \
        PB_HTTP="127.0.0.1:$2" PB_HOOKS="$HERE/pb_hooks" PB_MIGRATIONS="$HERE/pb_migrations" sh "$HERE/start.sh" >> "$W/$1/log" 2>&1
      sleep 1
    done ) &
}
up() { for i in $(seq 1 40); do curl -sf "$1/api/health" >/dev/null && return 0; sleep 0.5; done; echo "$1 did not start"; return 1; }
token() { curl -s -X POST "$1/api/collections/users/auth-with-password" -H 'content-type: application/json' -d "{\"identity\":\"$2\",\"password\":\"$3\"}" | j 'd.get("token","")'; }
role() { curl -s "$1/api/team/status" | j 'd["role"]+"/"+str(d["ready"])'; }

serve a 8091 CODEA; serve b 8092 CODEB
up $A; up $B
say "A: owner, member, R2, one shared window with a login state"
curl -s -X POST $A/api/team/setup -H 'content-type: application/json' -d '{"code":"CODEA","username":"boss","name":"老板","password":"testpass123"}' >/dev/null
OT=$(token $A boss testpass123)
curl -s -X POST $A/api/collections/users/records -H "Authorization: $OT" -H 'content-type: application/json' -d '{"username":"alice","role":"member","password":"alicepass1","passwordConfirm":"alicepass1"}' >/dev/null
R2='{"url":"https://test.r2.cloudflarestorage.com/bucket","accessKeyId":"AAAAAAAAAAAAAAAA","secretAccessKey":"BBBBBBBBBBBBBBBB"}'
ok "$(curl -s -X POST $A/api/team/offsite -H "Authorization: $OT" -H 'content-type: application/json' -d "$R2" | j 'd["configured"]')" "True" "A offsite on"
head -c 200000 /dev/urandom > "$W/state.bin"
PID=$(curl -s -X POST $A/api/collections/team_profiles/records -H "Authorization: $OT" -F name=shop -F 'config={"a":1}' -F data_rev=1 -F data=@"$W/state.bin" | j 'd["id"]')
curl -s -X POST $A/api/collections/team_workspaces/records -H "Authorization: $OT" -H 'content-type: application/json' -d "{\"user\":\"$(curl -s $A/api/collections/users/auth-refresh -X POST -H "Authorization: $OT" | j 'd["record"]["id"]')\",\"data\":{\"proxies\":[1,2,3]}}" >/dev/null
ok "$(role $A)" "active/True" "A active (no marker yet)"
ok "$(role $B)" "active/False" "B fresh"

say "standby setup must be refused before A names B"
ok "$(curl -s -X POST $B/api/team/standby/setup -H 'content-type: application/json' -d "$(echo $R2 | sed 's/^{/{"code":"CODEB",/')" | j 'd["message"][:6]')" "请先在正在用" "B refuses"
say "A names B as standby; B gets the bucket"
ok "$(curl -s -X POST $A/api/team/servers -H "Authorization: $OT" -H 'content-type: application/json' -d "{\"standby\":\"$B\"}" | j 'd["servers"]')" "['$A', '$B']" "A servers"
ok "$(curl -s -X POST $B/api/team/standby/setup -H 'content-type: application/json' -d "$(echo $R2 | sed 's/^{/{"code":"WRONG",/')" | j 'd["status"]')" "403" "B wrong code"
ok "$(curl -s -X POST $B/api/team/standby/setup -H 'content-type: application/json' -d "$(echo $R2 | sed 's/^{/{"code":"CODEB",/')" | j 'd["role"]')" "standby" "B standby"
ok "$(curl -s -X POST $B/api/collections/users/auth-with-password -H 'content-type: application/json' -d '{"identity":"boss","password":"testpass123"}' | j 'd["status"]')" "409" "B refuses logins while standby"

say "waiting for A's first push to R2 (up to 70 s)"
for i in $(seq 1 70); do ls "$W/bucket/db/"*.db.gz >/dev/null 2>&1 && ls "$W/bucket/storage" >/dev/null 2>&1 && break; sleep 1; done
ok "$(ls $W/bucket/db | wc -l | tr -d ' ')" "1" "one db copy in R2"

say "planned switch: A hands over, B takes over"
ok "$(curl -s -X POST $A/api/team/handover -H "Authorization: $OT" | j 'd["ok"]')" "True" "A handover"
ok "$(curl -s $A/api/collections/team_profiles/records -H "Authorization: $OT" | j 'd["status"]')" "409" "A refuses during handover"
ok "$(curl -s -X POST $B/api/team/activate -H 'content-type: application/json' -d '{"code":"CODEB"}' | j 'd["restarting"]')" "True" "B activate"
sleep 4; up $B
ok "$(role $B)" "active/True" "B active with the restored data"
ok "$(curl -s -X POST $B/api/collections/users/auth-refresh -H "Authorization: $OT" | j 'd["record"]["username"]')" "boss" "A's sign-in still valid on B"
ok "$(curl -s $B/api/collections/team_profiles/records -H "Authorization: $OT" | j 'd["totalItems"]')" "1" "window on B"
FILE=$(curl -s $B/api/collections/team_profiles/records/$PID -H "Authorization: $OT" | j 'd["data"]')
FT=$(curl -s -X POST $B/api/files/token -H "Authorization: $OT" | j 'd["token"]')
curl -s "$B/api/files/team_profiles/$PID/$FILE?token=$FT" -o "$W/got.bin"
ok "$(cmp -s $W/state.bin $W/got.bin && echo same)" "same" "login state on B equals the uploaded one"
ok "$(curl -s $B/api/collections/team_workspaces/records -H "Authorization: $OT" | j 'd["items"][0]["data"]["proxies"]')" "[1, 2, 3]" "workspace on B"
say "A learns it is standby (up to 70 s) and points to B"
for i in $(seq 1 70); do [ "$(curl -s $A/api/collections/team_profiles/records -H "Authorization: $OT" | j 'd.get("movedTo","")')" = "$B" ] && break; sleep 1; done
ok "$(role $A)" "standby/True" "A standby"
ok "$(curl -s $A/api/collections/team_profiles/records -H "Authorization: $OT" | j 'd["movedTo"]')" "$B" "A says movedTo B"

say "B writes; then A dies-style takeover back to A (no handover)"
curl -s -X PATCH $B/api/collections/team_profiles/records/$PID -H "Authorization: $OT" -H 'content-type: application/json' -d '{"name":"shop-on-b"}' >/dev/null
for i in $(seq 1 70); do [ "$(ls $W/bucket/db | wc -l | tr -d ' ')" -ge 2 ] && break; sleep 1; done
ok "$(curl -s -X POST $A/api/team/activate -H 'content-type: application/json' -d '{"code":"CODEA"}' | j 'd["restarting"]')" "True" "A activate"
sleep 4; up $A
ok "$(curl -s $A/api/collections/team_profiles/records/$PID -H "Authorization: $OT" | j 'd["name"]')" "shop-on-b" "A has B's change"
for i in $(seq 1 70); do [ "$(role $B)" = "standby/True" ] && break; sleep 1; done
ok "$(role $B)" "standby/True" "B back to standby"

touch $W/a/stop $W/b/stop
pkill -f "$W/" 2>/dev/null; pkill -f "127.0.0.1:809[12]" 2>/dev/null
echo "logs: $W/a/log $W/b/log"
echo "FAILS=$FAILS"
