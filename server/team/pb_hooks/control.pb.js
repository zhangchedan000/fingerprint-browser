/// <reference path="../pb_data/types.d.ts" />

// Active and standby servers (control_utils.js has the rules).

onBootstrap((e) => {
  e.next()
  require(`${__hooks}/control_utils.js`).refresh()
})

cronAdd("control_check", "* * * * *", () => {
  require(`${__hooks}/control_utils.js`).refresh()
})

// A standby server answers only these; everything else is pointed at the active server.
routerUse((e) => {
  const path = e.request.url.path
  const open = !path.startsWith("/api/") || path === "/api/health"
    || path === "/api/team/status" || path === "/api/team/activate" || path === "/api/team/standby/setup"
    || path === "/api/team/peer/db"
  if (open) return e.next()
  const c = require(`${__hooks}/control_utils.js`)
  if (c.role() === "standby") {
    // Handing over: look for the new server's name now and then, not only once a minute.
    if (c.active() === c.self()) c.refreshSoon()
    const target = c.active()
    return e.json(409, {
      status: 409,
      message: target && target !== c.self() ? "团队服务器已切换到 " + target : "团队服务器正在切换，请稍后再试",
      movedTo: target && target !== c.self() ? target : "",
      data: {}
    })
  }
  return e.next()
})

// A new standby server gets the R2 bucket (sent by the owner's app from the active server).
routerAdd("POST", "/api/team/standby/setup", (e) => {
  const r2 = require(`${__hooks}/r2_utils.js`)
  const c = require(`${__hooks}/control_utils.js`)
  const body = e.requestInfo().body || {}
  c.requireSetupCode(e, body.code)
  if (!c.self()) throw new BadRequestError("这台服务器没有设置自己的地址（.env 的 TEAM_PUBLIC_URL）")
  const config = r2.parseS3Url(body.url)
  if (!config) throw new BadRequestError("S3 API 地址不对")
  config.R2_ACCESS_KEY_ID = String(body.accessKeyId || "").trim()
  config.R2_SECRET_ACCESS_KEY = String(body.secretAccessKey || "").trim()
  if (!r2.validConfig(config)) throw new BadRequestError("R2 密钥格式不对")
  try {
    r2.check(config)
  } catch (err) {
    throw new BadRequestError("连不上 R2：" + err.message)
  }
  r2.saveConfig(config)
  c.refresh()
  // Only as the standby the active server named (POST /api/team/servers there first).
  if (!c.active() || c.active() === c.self() || c.servers().indexOf(c.self()) < 0) {
    r2.removeConfig()
    throw new BadRequestError("请先在正在用的服务器上把这台设为备用服务器")
  }
  return e.json(200, c.view())
})

// The owner names a standby server (or none); every app learns it from /api/team/status.
routerAdd("POST", "/api/team/servers", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const c = require(`${__hooks}/control_utils.js`)
  t.requireOwner(e)
  if (!c.self()) throw new BadRequestError("服务器没有设置自己的地址（.env 的 TEAM_PUBLIC_URL）")
  const body = e.requestInfo().body || {}
  const standby = c.normalize(body.standby)
  if (standby && (!c.validUrl(standby) || standby === c.self())) throw new BadRequestError("备用服务器地址不对")
  if (standby) {
    let reply
    try {
      reply = $http.send({ url: standby + "/api/team/status", method: "GET", timeout: 15 })
    } catch (err) {
      throw new BadRequestError("连不上备用服务器：" + err)
    }
    const json = reply.json || {}
    if (reply.statusCode !== 200 || !json.self) throw new BadRequestError("备用服务器不是团队服务器，或者还没设置自己的地址")
    if (c.normalize(json.self) !== standby) throw new BadRequestError("备用服务器报的地址是 " + json.self + "，和填的不一样")
  }
  const marker = c.writeMarker(c.self(), standby ? [c.self(), standby] : [c.self()])
  t.log($app, e, "servers_set", null, { servers: marker.servers })
  return e.json(200, c.view())
}, $apis.requireAuth("users"))

// The owner's app copies the R2 bucket to a new standby server; only the owner sees the key.
routerAdd("GET", "/api/team/offsite/key", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  t.requireOwner(e)
  const config = require(`${__hooks}/r2_utils.js`).readConfig()
  if (!config) throw new BadRequestError("还没开启异地备份（R2）")
  t.log($app, e, "offsite_key", null, { bucket: config.R2_BUCKET })
  return e.json(200, { url: config.R2_ENDPOINT + "/" + config.R2_BUCKET, accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY })
}, $apis.requireAuth("users"))

// Planned switch: the active server stops writing and puts everything in R2 for the next one.
routerAdd("POST", "/api/team/handover", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const r2 = require(`${__hooks}/r2_utils.js`)
  const c = require(`${__hooks}/control_utils.js`)
  t.requireOwner(e)
  const r = r2.remote()
  if (!r) throw new BadRequestError("还没开启异地备份（R2）")
  t.log($app, e, "handover", null, {})
  c.startHandover()
  let dump
  try {
    dump = r2.pushDb(r)
    r2.pushStorage(r)
  } catch (err) {
    c.endHandover()
    throw new BadRequestError("最后一次同步到 R2 失败，没有切换：" + err.message)
  }
  // The standby server gets the last database straight too (R2 has it anyway).
  try { r2.pushPeers(dump) } catch (_) {}
  return e.json(200, { ok: true })
})

// The active server's database, pushed after every change (r2_utils.js pushPeers): kept in
// pb_data/.peer, unused, until this server takes over. Only a standby server takes it.
routerAdd("POST", "/api/team/peer/db", (e) => {
  const r2 = require(`${__hooks}/r2_utils.js`)
  const c = require(`${__hooks}/control_utils.js`)
  const key = r2.peerKey()
  const given = String(e.request.header.get("X-Peer-Key") || "")
  if (!key || !given || !$security.equal(given, key)) throw new ForbiddenError("这台服务器还没设置 R2，或者 R2 设置和当班服务器的不一样")
  c.refreshSoon()
  if (c.role() !== "standby" || c.active() === c.self()) {
    return e.json(409, { status: 409, message: "这台服务器正在当班，不收别的服务器的数据库", data: {} })
  }
  const body = e.requestInfo().body || {}
  const at = Number(body.at) || 0
  const sha = String(body.sha256 || "")
  const db = String(body.db || "")
  if (!at || !/^[0-9a-f]{64}$/.test(sha) || !db || !/^[A-Za-z0-9+/=]+$/.test(db)) throw new BadRequestError("数据不完整")
  const dir = r2.PEER_DIR
  $os.mkdirAll(dir, 0o700)
  let have = 0
  try { have = Number(toString($os.readFile(dir + "/at")).trim()) || 0 } catch (_) {}
  if (at <= have) return e.json(200, { ok: true, kept: have })
  $os.writeFile(dir + "/incoming.b64", db, 0o600)
  try {
    r2.sh("cd " + dir + " && base64 -d incoming.b64 > incoming.db.gz && echo '" + sha + "  incoming.db.gz' | sha256sum -c - >/dev/null"
      + " && gzip -t incoming.db.gz && mv incoming.db.gz data.db.gz && rm -f incoming.b64")
  } catch (err) {
    r2.sh("rm -f " + dir + "/incoming.b64 " + dir + "/incoming.db.gz")
    throw new BadRequestError("收到的数据库不完整：" + err.message)
  }
  $os.writeFile(dir + "/at", String(at), 0o600)
  return e.json(200, { ok: true, kept: at })
})

// A standby server takes over: the newest database (its own copy from the active server, or R2's,
// whichever is newer), the login states from R2, named active, restart.
routerAdd("POST", "/api/team/activate", (e) => {
  const r2 = require(`${__hooks}/r2_utils.js`)
  const c = require(`${__hooks}/control_utils.js`)
  const body = e.requestInfo().body || {}
  c.requireSetupCode(e, body.code)
  if (!c.self()) throw new BadRequestError("这台服务器没有设置自己的地址（.env 的 TEAM_PUBLIC_URL）")
  const r = r2.remote()
  if (!r) throw new BadRequestError("这台服务器还没设置 R2，不能恢复")
  c.refresh()
  if (c.active() === c.self() && c.role() === "active") return e.json(200, Object.assign({ ok: true, restarting: false }, c.view()))
  const dir = r2.DATA + "/.restore"
  const peerAt = c.peerAt()
  let r2At = 0
  try { r2At = Number(r2.sh(r.env + "rclone cat " + r.target + "/db/current.at 2>/dev/null || true")) || 0 } catch (_) {}
  let from
  try {
    r2.sh("rm -rf " + dir + " && mkdir -p " + dir)
    if (peerAt && peerAt >= r2At) {
      r2.sh("cp " + r2.PEER_DIR + "/data.db.gz " + dir + "/data.db.gz")
      from = "备用服务器自己的副本 " + new Date(peerAt).toISOString()
    } else {
      // Older servers wrote a copy per change (db/<time>.db.gz): the newest one, if there is no current.
      r2.sh(r.env + "cd " + dir + " && if rclone lsf " + r.target + "/db/current.db.gz | grep -q .; then"
        + " rclone copyto " + r.target + "/db/current.db.gz data.db.gz;"
        + " else latest=$(rclone lsf " + r.target + "/db | grep '^2.*\\.db\\.gz$' | sort | tail -1) && [ -n \"$latest\" ] && rclone copyto " + r.target + "/db/$latest data.db.gz; fi")
      from = "R2 " + (r2At ? new Date(r2At).toISOString() : "")
    }
    r2.sh("gunzip " + dir + "/data.db.gz")
    r2.sh(r.env + "rclone copy " + r.target + "/storage " + dir + "/storage || [ -z \"$(rclone lsf " + r.target + "/storage 2>/dev/null)\" ]")
  } catch (err) {
    throw new BadRequestError("拉数据失败：" + err.message)
  }
  const old = c.servers()
  c.writeMarker(c.self(), old.length ? old : [c.self()])
  $os.writeFile(dir + "/ready", from, 0o600)
  // The copy from the other server is used up; a new one comes when this server is standby again.
  r2.sh("rm -rf " + r2.PEER_DIR)
  // After the reply: PocketBase stops, the container (or start.sh's loop) starts it again, and
  // start.sh swaps the pulled files in before it does.
  $os.cmd("sh", "-c", "sleep 2; kill -TERM $PPID").start()
  return e.json(200, Object.assign({ ok: true, restarting: true, restoredFrom: from }, c.view()))
})
