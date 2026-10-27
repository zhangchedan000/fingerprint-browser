/// <reference path="../pb_data/types.d.ts" />

// Invite codes (owner) and signing up with one; failed sign-ins are logged and, after a few in a
// row, the account name is held for a while.

routerAdd("GET", "/api/team/invites", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  t.requireOwner(e)
  const items = $app.findRecordsByFilter("team_invites", "", "-created", 200, 0).map((invite) => ({
    id: invite.id,
    code: invite.getString("code"),
    note: invite.getString("note"),
    expires: invite.getInt("expires"),
    usedName: invite.getString("used_name"),
    usedAt: invite.getInt("used_at"),
    created: invite.getString("created")
  }))
  return e.json(200, { items })
}, $apis.requireAuth("users"))

routerAdd("POST", "/api/team/invites", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  t.requireOwner(e)
  const body = e.requestInfo().body || {}
  const note = String(body.note || "").trim().slice(0, 200)
  const invite = new Record($app.findCollectionByNameOrId("team_invites"))
  // No 0/O, 1/I/L: the code is read off a chat message.
  invite.set("code", $security.randomStringWithAlphabet(12, "23456789ABCDEFGHJKMNPQRSTUVWXYZ"))
  invite.set("note", note)
  invite.set("expires", Date.now() + t.INVITE_MS)
  $app.save(invite)
  t.log($app, e, "invite_create", null, { note })
  return e.json(200, { id: invite.id, code: invite.getString("code"), note, expires: invite.getInt("expires"), usedName: "", usedAt: 0, created: invite.getString("created") })
}, $apis.requireAuth("users"))

routerAdd("DELETE", "/api/team/invites/{id}", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  t.requireOwner(e)
  const invite = t.findOrNull($app, "team_invites", "id = {:id}", { id: e.request.pathValue("id") })
  if (!invite) throw new NotFoundError("没有这个邀请码")
  if (invite.getInt("used_at")) throw new BadRequestError("这个邀请码已经用过了")
  $app.delete(invite)
  t.log($app, e, "invite_revoke", null, { note: invite.getString("note") })
  return e.json(200, { ok: true })
}, $apis.requireAuth("users"))

// Signing up: a valid unused invite code makes a member account; the app then signs in.
routerAdd("POST", "/api/team/register", (e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const body = e.requestInfo().body || {}
  const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  const username = String(body.username || "").trim()
  const name = String(body.name || "").trim().slice(0, 100)
  const password = String(body.password || "")
  if (!/^[^\s@]{2,64}$/.test(username)) throw new BadRequestError("用户名 2 到 64 个字符，不能有空格和 @")
  if (password.length < 8) throw new BadRequestError("密码至少 8 位")
  if (!code) throw new BadRequestError("请填写邀请码")
  // Codes are long and random; the hold on wrong guesses only slows a script down.
  t.checkHold(e, "invite:" + e.realIP())

  let user = null
  let invite = null
  $app.runInTransaction((tx) => {
    invite = t.findOrNull(tx, "team_invites", "code = {:code}", { code })
    if (!invite) return
    if (invite.getInt("used_at")) throw new BadRequestError("这个邀请码已经用过了")
    if (invite.getInt("expires") <= Date.now()) throw new BadRequestError("这个邀请码已经过期，请找主账号重新生成")
    if (t.findOrNull(tx, "users", "username = {:u}", { u: username })) throw new BadRequestError("用户名已被使用，换一个")
    user = new Record(tx.findCollectionByNameOrId("users"))
    user.set("username", username)
    user.set("name", name)
    user.set("role", "member")
    user.set("disabled", false)
    user.setPassword(password)
    try {
      tx.save(user)
    } catch (_) {
      // The unique index ignores case; the check above does not.
      throw new BadRequestError("用户名已被使用，换一个")
    }
    invite.set("used_by", user.id)
    invite.set("used_name", name || username)
    invite.set("used_at", Date.now())
    tx.save(invite)
  })
  if (!invite) {
    t.addFailure("invite:" + e.realIP())
    throw new BadRequestError("邀请码不对")
  }
  t.log($app, e, "register", null, { note: invite.getString("note"), username }, { user })
  return e.json(200, { ok: true })
})

onRecordAuthWithPasswordRequest((e) => {
  const t = require(`${__hooks}/team_utils.js`)
  const key = "login:" + String(e.identity || "").toLowerCase()
  t.checkHold(e, key)
  try {
    e.next()
  } catch (err) {
    t.addFailure(key)
    t.log($app, e, "login_fail", null, { username: String(e.identity || "").slice(0, 64) }, { userName: String(e.identity || "").slice(0, 64) })
    throw err
  }
  t.clearFailures(key)
}, "users")
