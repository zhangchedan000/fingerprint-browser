/// <reference path="../pb_data/types.d.ts" />

// Off-server backup to Cloudflare R2: see r2_utils.js.

cronAdd("r2_backup", "* * * * *", () => {
  require(`${__hooks}/r2_utils.js`).tick()
})

// 03:30 Beijing time, after PocketBase's own daily zip.
cronAdd("r2_daily", "30 19 * * *", () => {
  require(`${__hooks}/r2_utils.js`).daily()
})

// Locks change every 30 seconds while a window is open and are not worth keeping.
onModelAfterCreateSuccess((e) => {
  e.next()
  const r2 = require(`${__hooks}/r2_utils.js`)
  r2.markDb()
  if (e.model.tableName() === "team_profiles") r2.markFiles()
}, "users", "team_profiles", "team_logs")

onModelAfterUpdateSuccess((e) => {
  e.next()
  const r2 = require(`${__hooks}/r2_utils.js`)
  r2.markDb()
  if (e.model.tableName() === "team_profiles") r2.markFiles()
}, "users", "team_profiles")

onModelAfterDeleteSuccess((e) => {
  e.next()
  require(`${__hooks}/r2_utils.js`).markDb()
}, "users", "team_profiles", "team_logs")

// The owner sets the bucket in the app: the S3 API address R2 shows for it and the token's keys.
routerAdd("POST", "/api/team/offsite", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const r2 = require(`${__hooks}/r2_utils.js`)
  t.requireOwner(e)
  const body = e.requestInfo().body || {}
  const config = r2.parseS3Url(body.url)
  if (!config) throw new BadRequestError("S3 API 地址不对，应该像 https://xxxx.r2.cloudflarestorage.com/存储桶名")
  config.R2_ACCESS_KEY_ID = String(body.accessKeyId || "").trim()
  config.R2_SECRET_ACCESS_KEY = String(body.secretAccessKey || "").trim()
  if (!r2.validConfig(config)) throw new BadRequestError("访问密钥 ID 或机密访问密钥格式不对")
  try {
    r2.check(config)
  } catch (err) {
    throw new BadRequestError("连不上 R2：" + err.message)
  }
  r2.saveConfig(config)
  t.log($app, e, "offsite_set", null, { bucket: config.R2_BUCKET })
  return e.json(200, r2.summary())
}, $apis.requireAuth("users"))

routerAdd("DELETE", "/api/team/offsite", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  t.requireOwner(e)
  require(`${__hooks}/r2_utils.js`).removeConfig()
  t.log($app, e, "offsite_off", null, {})
  return e.json(200, { ok: true })
}, $apis.requireAuth("users"))
