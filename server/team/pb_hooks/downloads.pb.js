/// <reference path="../pb_data/types.d.ts" />

// The team's private files that the launcher downloads, kept in R2 under downloads/ (never in a
// public repository): the kernel font package (Microsoft's fonts). Any signed-in, active account
// gets a link that works for 15 minutes and goes straight to R2 (the server does not carry the bytes).
// Putting a file there (on a server):
//   rclone copyto <file> r2:<bucket>/downloads/<name>   (inside the container, with pb_data/r2.env)
routerAdd("GET", "/api/team/downloads/{name}", (e) => {
  const FILES = ["prism-system-fonts-1.zip"]
  const name = e.request.pathValue("name")
  if (!e.auth || e.auth.getBool("disabled")) throw new ForbiddenError("账号不可用")
  if (FILES.indexOf(name) < 0) throw new NotFoundError("没有这个文件")
  const r2 = require(`${__hooks}/r2_utils.js`)
  const r = r2.remote()
  if (!r) throw new BadRequestError("服务器还没设置 R2，下载不了")
  let out
  try {
    out = r2.sh(r.env + "rclone link --expire 15m " + r.target + "/downloads/" + name + " 2>/dev/null")
  } catch (err) {
    throw new BadRequestError("生成下载地址失败：" + err.message)
  }
  const url = out.split("\n").map((line) => line.trim()).filter((line) => line.indexOf("https://") === 0).pop()
  if (!url) throw new BadRequestError("生成下载地址失败")
  return e.json(200, { url: url, expiresInSeconds: 900 })
}, $apis.requireAuth("users"))
