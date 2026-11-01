/// <reference path="../pb_data/types.d.ts" />

// Private files the launcher needs but may not ship in its public installer or the public kernel
// releases (pb_data/assets, part of every backup zip). Any active member downloads them signed in.
// Putting one there takes a one-time token the server admin creates on the server itself:
//   echo -n <random> > pb_data/assets/.upload-token
// then PUT the file with header X-Upload-Token; the token file is removed once used.
// (Route handlers run in their own VM: names they use are declared inside them.)

routerAdd("GET", "/api/team/assets/{name}", (e) => {
  const ASSET_NAMES = ["seguiemj-win10.ttf", "segoeui-win10.zip"]
  const name = e.request.pathValue("name")
  if (!e.auth || e.auth.getBool("disabled")) throw new ForbiddenError("账号不可用")
  if (ASSET_NAMES.indexOf(name) < 0) throw new NotFoundError("没有这个文件")
  const dir = $app.dataDir() + "/assets"
  try {
    $os.stat(dir + "/" + name)
  } catch (_) {
    throw new NotFoundError("服务器上还没有这个文件")
  }
  return e.fileFS($os.dirFS(dir), name)
}, $apis.requireAuth("users"))

routerAdd("PUT", "/api/team/assets/{name}", (e) => {
  const ASSET_NAMES = ["seguiemj-win10.ttf", "segoeui-win10.zip"]
  const MAX_BYTES = 64 * 1024 * 1024
  const name = e.request.pathValue("name")
  if (ASSET_NAMES.indexOf(name) < 0) throw new NotFoundError("没有这个文件")
  const dir = $app.dataDir() + "/assets"
  const tokenFile = dir + "/.upload-token"
  let token = ""
  try {
    token = toString($os.readFile(tokenFile)).trim()
  } catch (_) {
    throw new ForbiddenError("没有上传口令：请先在服务器上生成")
  }
  if (!token || e.request.header.get("X-Upload-Token") !== token) throw new ForbiddenError("上传口令不对")
  const data = toBytes(e.request.body, MAX_BYTES)
  if (!data || !data.length) throw new BadRequestError("文件是空的")
  $os.mkdirAll(dir, 0o755)
  $os.writeFile(dir + "/" + name + ".part", data, 0o644)
  $os.rename(dir + "/" + name + ".part", dir + "/" + name)
  $os.remove(tokenFile)
  return e.json(200, { name, size: data.length })
})
