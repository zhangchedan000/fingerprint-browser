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
