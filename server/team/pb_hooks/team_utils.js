/// <reference path="../pb_data/types.d.ts" />

// Shared by team.pb.js. Hook handlers run in their own VMs, so they load this with require.

const LOCK_MS = 90 * 1000

function isOwner(auth) {
  return !!auth && auth.collection().name === "users" && auth.getString("role") === "owner"
}

function displayName(user) {
  if (!user) return ""
  return user.getString("name") || user.getString("username")
}

function canSee(profile, auth) {
  if (isOwner(auth)) return true
  return !auth.getBool("disabled") && profile.getStringSlice("assignees").indexOf(auth.id) >= 0
}

function findOrNull(app, collection, filter, params) {
  try {
    return app.findFirstRecordByFilter(collection, filter, params)
  } catch (_) {
    return null
  }
}

/**
 * opts.user: who did it when it is not e.auth (sign-in). opts.profileName: the name of a window
 * that no longer exists (deletion).
 */
function log(app, e, action, profile, detail, opts) {
  opts = opts || {}
  const record = new Record(app.findCollectionByNameOrId("team_logs"))
  const user = opts.user || e.auth
  if (user && user.collection().name === "users") {
    record.set("user", user.id)
    record.set("user_name", displayName(user))
  } else if (user) {
    record.set("user_name", "管理后台")
  }
  if (profile) {
    record.set("profile", profile.id)
    record.set("profile_name", profile.getString("name"))
  } else if (opts.profileName) {
    record.set("profile_name", opts.profileName)
  }
  record.set("action", action)
  record.set("detail", detail || {})
  try { record.set("ip", e.realIP()) } catch (_) {}
  app.save(record)
}

function userNames(app, ids) {
  if (!ids.length) return []
  return app.findRecordsByIds("users", ids).map(displayName)
}

/** lock / heartbeat / unlock of one shared window by the signed-in user. */
function lockRoute(e, mode) {
  const auth = e.auth
  const id = e.request.pathValue("id")
  let profile
  try {
    profile = $app.findRecordById("team_profiles", id)
  } catch (_) {
    throw new NotFoundError("窗口不存在或没有分配给你")
  }
  if (!canSee(profile, auth)) throw new NotFoundError("窗口不存在或没有分配给你")
  const body = e.requestInfo().body || {}
  const now = Date.now()
  let result = null
  let logged = null

  $app.runInTransaction((tx) => {
    let lock = findOrNull(tx, "team_locks", "profile = {:p}", { p: id })
    const live = !!lock && lock.getInt("expires") > now
    const mine = !!lock && lock.getString("holder") === auth.id

    if (mode === "unlock") {
      if (!lock) {
        result = { released: false }
        return
      }
      const force = !mine && live
      if (force && !(isOwner(auth) && body.force)) throw new ForbiddenError("这个窗口正在被别人使用")
      tx.delete(lock)
      result = { released: true }
      if (force) {
        const holder = findOrNull(tx, "users", "id = {:id}", { id: lock.getString("holder") })
        logged = { action: "force_unlock", detail: { holder: displayName(holder) } }
      } else if (mine) {
        logged = { action: "close", detail: {} }
      }
      return
    }

    if (live && !mine) {
      const holder = findOrNull(tx, "users", "id = {:id}", { id: lock.getString("holder") })
      // ApiError data is reserved for field errors, so the holder only goes in the message.
      throw new ApiError(409, "「" + displayName(holder) + "」正在使用这个窗口", {})
    }
    if (mode === "heartbeat" && !mine) throw new ApiError(409, "占用已失效，请关闭窗口后重新打开", {})

    if (!lock) lock = new Record(tx.findCollectionByNameOrId("team_locks"))
    lock.set("profile", id)
    lock.set("holder", auth.id)
    if (mode === "lock") lock.set("device", String(body.device || "").slice(0, 200))
    lock.set("expires", now + LOCK_MS)
    tx.save(lock)
    result = { expires: now + LOCK_MS, lockMs: LOCK_MS }
    if (mode === "lock") logged = { action: "open", detail: { device: lock.getString("device") } }
  })

  if (logged) log($app, e, logged.action, profile, logged.detail)
  return e.json(200, result)
}

module.exports = { LOCK_MS, isOwner, displayName, canSee, findOrNull, log, userNames, lockRoute }
