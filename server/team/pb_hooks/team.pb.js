/// <reference path="../pb_data/types.d.ts" />

// Team routes and the log. See team_utils.js for the shared helpers.

routerAdd("GET", "/api/team/status", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const owner = t.findOrNull($app, "users", 'role = "owner"', {})
  return e.json(200, { ready: !!owner, lockMs: t.LOCK_MS })
})

// Creates the owner account once, with the setup code from the server's .env.
routerAdd("POST", "/api/team/setup", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const code = $os.getenv("TEAM_SETUP_CODE")
  const body = e.requestInfo().body || {}
  if (!code || code === "change-me" || String(body.code || "") !== code) throw new ForbiddenError("初始化码不对")
  if (t.findOrNull($app, "users", 'role = "owner"', {})) throw new ForbiddenError("主账号已经创建过了")
  const owner = new Record($app.findCollectionByNameOrId("users"))
  owner.set("username", String(body.username || "").trim())
  owner.set("name", String(body.name || "").trim())
  owner.set("role", "owner")
  owner.setPassword(String(body.password || ""))
  $app.save(owner)
  t.log($app, e, "setup", null, {}, { user: owner })
  return e.json(200, { ok: true })
})

routerAdd("POST", "/api/team/profiles/{id}/lock", (e) => {
  return require(`${__hooks}/team_utils.js`).lockRoute(e, "lock")
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/team/profiles/{id}/heartbeat", (e) => {
  return require(`${__hooks}/team_utils.js`).lockRoute(e, "heartbeat")
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/team/profiles/{id}/unlock", (e) => {
  return require(`${__hooks}/team_utils.js`).lockRoute(e, "unlock")
}, $apis.requireAuth("users"))

onRecordAuthRequest((e) => {
  e.next()
  if (e.authMethod === "password") {
    require(`${__hooks}/team_utils.js`).log($app, e, "login", null, {}, { user: e.record })
  }
}, "users")

onRecordCreateRequest((e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const body = e.requestInfo().body || {}
  e.record.set("config_rev", 1)
  e.record.set("data_rev", body.data_rev !== undefined ? 1 : 0)
  if (body.data_rev !== undefined && e.auth) e.record.set("data_by", e.auth.id)
  if (!e.record.getString("owner") && e.auth) e.record.set("owner", e.auth.id)
  e.next()
  t.log($app, e, "share", e.record, { assignees: t.userNames($app, e.record.getStringSlice("assignees")) })
}, "team_profiles")

onRecordUpdateRequest((e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const body = e.requestInfo().body || {}
  const original = e.record.original()
  const uploading = body.data_rev !== undefined
  if (uploading) {
    const lock = t.findOrNull($app, "team_locks", "profile = {:p}", { p: e.record.id })
    if (!lock || lock.getString("holder") !== e.auth.id || lock.getInt("expires") <= Date.now()) {
      throw new ApiError(409, "没有占用这个窗口，不能上传登录态", {})
    }
    const expected = original.getInt("data_rev") + 1
    if (Number(body.data_rev) !== expected) {
      throw new ApiError(409, "登录态已被别人更新过，请重新打开窗口", {})
    }
    e.record.set("data_rev", expected)
    e.record.set("data_by", e.auth.id)
  } else {
    e.record.set("data_rev", original.getInt("data_rev"))
    e.record.set("data_by", original.getString("data_by"))
  }
  e.record.set("config_rev", original.getInt("config_rev") + (body.config !== undefined ? 1 : 0))
  const changed = ["name", "note", "config", "assignees"].filter((key) => body[key] !== undefined)
  e.next()
  if (uploading) t.log($app, e, "upload", e.record, { rev: e.record.getInt("data_rev"), size: Number(body.data_size || 0) })
  if (changed.length) {
    const detail = { fields: changed }
    if (changed.indexOf("assignees") >= 0) detail.assignees = t.userNames($app, e.record.getStringSlice("assignees"))
    t.log($app, e, "update", e.record, detail)
  }
}, "team_profiles")

onRecordDeleteRequest((e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const name = e.record.getString("name")
  e.next()
  t.log($app, e, "unshare", null, {}, { profileName: name })
}, "team_profiles")

onRecordCreateRequest((e) => {
  const t = require(`${__hooks}/team_utils.js`)
  e.next()
  t.log($app, e, "member_create", null, { member: t.displayName(e.record), username: e.record.getString("username") })
}, "users")

onRecordUpdateRequest((e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const body = e.requestInfo().body || {}
  const changed = ["name", "username", "password", "disabled"].filter((key) => body[key] !== undefined)
  e.next()
  if (changed.length) {
    t.log($app, e, "member_update", null, { member: t.displayName(e.record), fields: changed, disabled: e.record.getBool("disabled") })
  }
}, "users")

onRecordDeleteRequest((e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const member = t.displayName(e.record)
  e.next()
  t.log($app, e, "member_delete", null, { member })
}, "users")

// Server page of the app (owner only): status and backups. Backups are PocketBase's own zips of
// pb_data; the daily one comes from settings.backups (see 1761600003_backups.js).

routerAdd("GET", "/api/team/server", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  t.requireOwner(e)
  const sizes = {}
  // storage/ and backups/ only exist once something was uploaded or backed up; du then fails on them.
  const du = toString($os.cmd("sh", "-c", "du -sk /pb/pb_data /pb/pb_data/storage /pb/pb_data/backups 2>/dev/null; true").output())
  du.split("\n").forEach((line) => {
    const parts = line.trim().split(/\s+/)
    if (parts.length === 2) sizes[parts[1].replace("/pb/pb_data", "").replace("/", "") || "all"] = Number(parts[0]) * 1024
  })
  const df = toString($os.cmd("df", "-kP", "/pb/pb_data").output()).trim().split("\n").pop().split(/\s+/)
  const now = Date.now()
  const locks = $app.findRecordsByFilter("team_locks", "expires > {:now}", "", 0, 0, { now }).map((lock) => {
    const holder = t.findOrNull($app, "users", "id = {:id}", { id: lock.getString("holder") })
    const profile = t.findOrNull($app, "team_profiles", "id = {:id}", { id: lock.getString("profile") })
    return { profile: profile ? profile.getString("name") : "", holder: t.displayName(holder), device: lock.getString("device") }
  })
  const profiles = $app.findRecordsByFilter("team_profiles", "", "", 0, 0)
  let dataBytes = 0
  profiles.forEach((profile) => { dataBytes += profile.getInt("data_size") })
  let version = ""
  try { version = toString($os.cmd("/pb/pocketbase", "--version").output()).trim().split(" ").pop() } catch (_) {}
  const backups = $app.settings().backups
  return e.json(200, {
    version,
    diskTotal: Number(df[1]) * 1024,
    diskFree: Number(df[3]) * 1024,
    dataSize: sizes.all || 0,
    storageSize: sizes.storage || 0,
    backupsSize: sizes.backups || 0,
    members: $app.countRecords("users", $dbx.hashExp({ role: "member" })),
    profiles: profiles.length,
    profileDataBytes: dataBytes,
    locks,
    autoBackup: { cron: backups.cron, keep: backups.cronMaxKeep }
  })
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/team/backups", (e) => {
  require(`${__hooks}/team_utils.js`).requireOwner(e)
  const fsys = $app.newBackupsFilesystem()
  try {
    const items = fsys.list("").filter((item) => item && !item.isDir && /\.zip$/.test(item.key)).map((item) => ({
      key: item.key,
      size: item.size,
      modified: item.modTime.unixMilli(),
      auto: item.key.indexOf("@auto_pb_backup") === 0
    }))
    items.sort((a, b) => b.modified - a.modified)
    return e.json(200, { items })
  } finally {
    fsys.close()
  }
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/team/backups", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  t.requireOwner(e)
  const key = "prism_" + new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15) + ".zip"
  try {
    $app.createBackup(e.request.context(), key)
  } catch (err) {
    throw new BadRequestError("备份没有完成：" + String(err.message || err).slice(0, 200))
  }
  t.log($app, e, "backup_create", null, { key })
  return e.json(200, { key })
}, $apis.requireAuth("users"))

routerAdd("GET", "/api/team/backups/{key}", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  t.requireOwner(e)
  const key = e.request.pathValue("key")
  if (!/^[@a-zA-Z0-9_.-]+\.zip$/.test(key)) throw new NotFoundError("没有这个备份")
  const fsys = $app.newBackupsFilesystem()
  try {
    if (!fsys.exists(key)) throw new NotFoundError("没有这个备份")
    t.log($app, e, "backup_download", null, { key })
    fsys.serve(e.response, e.request, key, key)
  } finally {
    fsys.close()
  }
}, $apis.requireAuth("users"))

routerAdd("DELETE", "/api/team/backups/{key}", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  t.requireOwner(e)
  const key = e.request.pathValue("key")
  if (!/^[@a-zA-Z0-9_.-]+\.zip$/.test(key)) throw new NotFoundError("没有这个备份")
  const fsys = $app.newBackupsFilesystem()
  try {
    if (!fsys.exists(key)) throw new NotFoundError("没有这个备份")
    fsys.delete(key)
  } finally {
    fsys.close()
  }
  t.log($app, e, "backup_delete", null, { key })
  return e.json(200, { ok: true })
}, $apis.requireAuth("users"))
