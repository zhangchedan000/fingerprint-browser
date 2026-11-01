#!/bin/bash
# API smoke test against a FRESH server (no owner yet). Run from the deploy folder; it creates
# throwaway accounts, so wipe pb_data afterwards:
#   docker compose down && rm -rf pb_data && mkdir pb_data && docker compose up -d
B=${TEAM_URL:-http://127.0.0.1:8090}
CODE=$(grep TEAM_SETUP_CODE .env | cut -d= -f2)
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
say() { echo "== $*"; }

say status; curl -s $B/api/team/status; echo
say "setup wrong code"; curl -s -X POST $B/api/team/setup -H 'content-type: application/json' -d '{"code":"x","username":"boss","password":"testpass123"}'; echo
say setup; curl -s -X POST $B/api/team/setup -H 'content-type: application/json' -d "{\"code\":\"$CODE\",\"username\":\"boss\",\"name\":\"老板\",\"password\":\"testpass123\"}"; echo
say "setup again"; curl -s -X POST $B/api/team/setup -H 'content-type: application/json' -d "{\"code\":\"$CODE\",\"username\":\"boss2\",\"password\":\"testpass123\"}"; echo
OT=$(curl -s -X POST $B/api/collections/users/auth-with-password -H 'content-type: application/json' -d '{"identity":"boss","password":"testpass123"}' | j 'd["token"]')
say "create member"; M=$(curl -s -X POST $B/api/collections/users/records -H "Authorization: $OT" -H 'content-type: application/json' -d '{"username":"alice","name":"小A","role":"member","password":"alicepass1","passwordConfirm":"alicepass1"}'); echo "$M"; MID=$(echo "$M" | j 'd["id"]')
curl -s -X POST $B/api/collections/users/records -H "Authorization: $OT" -H 'content-type: application/json' -d '{"username":"bob","role":"member","password":"bobpass123","passwordConfirm":"bobpass123"}' > /tmp/bob.json; BID=$(j 'd["id"]' < /tmp/bob.json)
say "owner creating second owner (must fail)"; curl -s -X POST $B/api/collections/users/records -H "Authorization: $OT" -H 'content-type: application/json' -d '{"username":"evil","role":"owner","password":"evilpass12","passwordConfirm":"evilpass12"}'; echo
AT=$(curl -s -X POST $B/api/collections/users/auth-with-password -H 'content-type: application/json' -d '{"identity":"alice","password":"alicepass1"}' | j 'd["token"]')
BT=$(curl -s -X POST $B/api/collections/users/auth-with-password -H 'content-type: application/json' -d '{"identity":"bob","password":"bobpass123"}' | j 'd["token"]')
say "alice lists users (only self)"; curl -s "$B/api/collections/users/records" -H "Authorization: $AT" | j '[u["username"] for u in d["items"]]'
head -c 300000 /dev/urandom > /tmp/data1.bin
say "share window"; P=$(curl -s -X POST $B/api/collections/team_profiles/records -H "Authorization: $OT" -F name=窗口1 -F 'config={"a":1}' -F "assignees=$MID" -F data_rev=1 -F data=@/tmp/data1.bin); echo "$P" | j '{k:d.get(k) for k in ["name","config_rev","data_rev","data_by","assignees"]}'; PID=$(echo "$P" | j 'd["id"]')
say "alice sees (1)"; curl -s "$B/api/collections/team_profiles/records" -H "Authorization: $AT" | j 'd["totalItems"]'
say "bob sees (0)"; curl -s "$B/api/collections/team_profiles/records" -H "Authorization: $BT" | j 'd["totalItems"]'
say "alice edits config (must fail)"; curl -s -X PATCH "$B/api/collections/team_profiles/records/$PID" -H "Authorization: $AT" -H 'content-type: application/json' -d '{"config":{"a":2}}'; echo
say "alice uploads without lock (must fail)"; curl -s -X PATCH "$B/api/collections/team_profiles/records/$PID" -H "Authorization: $AT" -F data_rev=2 -F data=@/tmp/data1.bin; echo
say "alice lock"; curl -s -X POST "$B/api/team/profiles/$PID/lock" -H "Authorization: $AT" -H 'content-type: application/json' -d '{"device":"PC-A"}'; echo
say "owner lock (conflict)"; curl -s -X POST "$B/api/team/profiles/$PID/lock" -H "Authorization: $OT" -H 'content-type: application/json' -d '{}'; echo
say "bob lock (not assigned)"; curl -s -X POST "$B/api/team/profiles/$PID/lock" -H "Authorization: $BT"; echo
say "alice heartbeat"; curl -s -X POST "$B/api/team/profiles/$PID/heartbeat" -H "Authorization: $AT"; echo
say "alice upload wrong rev (must fail)"; curl -s -X PATCH "$B/api/collections/team_profiles/records/$PID" -H "Authorization: $AT" -F data_rev=5 -F data=@/tmp/data1.bin; echo
head -c 40000000 /dev/urandom > /tmp/data2.bin
say "alice upload rev 2 (40MB)"; curl -s -X PATCH "$B/api/collections/team_profiles/records/$PID" -H "Authorization: $AT" -F data_rev=2 -F data_size=40000000 -F data=@/tmp/data2.bin | j '{k:d.get(k, d.get("message")) for k in ["data_rev","data_by","config_rev"]}'
say "file token + download"; FT=$(curl -s -X POST $B/api/files/token -H "Authorization: $AT" | j 'd["token"]'); FN=$(curl -s "$B/api/collections/team_profiles/records/$PID" -H "Authorization: $AT" | j 'd["data"]'); curl -s -o /tmp/dl.bin -w '%{http_code}\n' "$B/api/files/team_profiles/$PID/$FN?token=$FT"; cmp /tmp/dl.bin /tmp/data2.bin && echo same
say "download without token (404)"; curl -s -o /dev/null -w '%{http_code}\n' "$B/api/files/team_profiles/$PID/$FN"
say "alice unlock"; curl -s -X POST "$B/api/team/profiles/$PID/unlock" -H "Authorization: $AT"; echo
say "owner config update"; curl -s -X PATCH "$B/api/collections/team_profiles/records/$PID" -H "Authorization: $OT" -H 'content-type: application/json' -d "{\"config\":{\"a\":3},\"assignees\":[\"$MID\",\"$BID\"]}" | j '{k:d.get(k) for k in ["config_rev","data_rev","data_by"]}'
say "bob lock + owner force unlock"; curl -s -X POST "$B/api/team/profiles/$PID/lock" -H "Authorization: $BT" > /dev/null; curl -s -X POST "$B/api/team/profiles/$PID/unlock" -H "Authorization: $OT" -H 'content-type: application/json' -d '{"force":true}'; echo
say "bob heartbeat after force (must fail)"; curl -s -X POST "$B/api/team/profiles/$PID/heartbeat" -H "Authorization: $BT"; echo
say "owner resets alice password + disables"; curl -s -X PATCH "$B/api/collections/users/records/$MID" -H "Authorization: $OT" -H 'content-type: application/json' -d '{"password":"newpass123","passwordConfirm":"newpass123","disabled":true}' | j 'd.get("disabled", d)'
say "alice old token lists profiles (0)"; curl -s "$B/api/collections/team_profiles/records" -H "Authorization: $AT" | j 'd.get("totalItems", d)'
say "alice login when disabled (must fail)"; curl -s -X POST $B/api/collections/users/auth-with-password -H 'content-type: application/json' -d '{"identity":"alice","password":"newpass123"}'; echo
say "alice reads logs (0)"; curl -s "$B/api/collections/team_logs/records" -H "Authorization: $AT" | j 'd.get("totalItems", d)'
say "owner reads logs"; curl -s "$B/api/collections/team_logs/records?sort=created&perPage=50" -H "Authorization: $OT" | j 'd["totalItems"]'
rm -f /tmp/data1.bin /tmp/data2.bin /tmp/dl.bin /tmp/bob.json
