/// <reference path="../pb_data/types.d.ts" />

// Where the team's data is kept besides this server (only by the server in use, control_utils.js):
// - Cloudflare R2, the windows: one current copy, only what changed is sent:
//     db/current.db.gz (+ db/current.at)  the database (accounts, window configs, proxy libraries…)
//                                          a minute after a change, written over;
//     storage/                             login states, a minute after a window uploads one.
//   Once a day (03:30 Beijing time) the current copy is copied to db/yesterday.db.gz and
//   storage-yesterday/ first, over the day before, so a broken upload can be undone for a day.
// - The standby server: the same database, pushed to it a minute after a change (it keeps it in
//   pb_data/.peer, control.pb.js), so it can take over at once even when R2 has no good copy.
// Nothing else: caches never reach the server, the program is on GitHub, the private fonts
// (pb_data/assets) are in the private repository, and there are no daily zips any more.
// The owner sets the bucket and its key in the app (r2.pb.js); they are kept in pb_data/r2.env.
// Hook handlers run in their own VMs, so state lives in $app.store().

// TEAM_DATA_DIR only for running the server outside its container (tests).
const DATA = $os.getenv("TEAM_DATA_DIR") || "/pb/pb_data"
const WORK = DATA + "/.r2"
const CONFIG = DATA + "/r2.env"
// The standby server's copy of the active server's database.
const PEER_DIR = DATA + "/.peer"
const KEY = { db: "r2.dbDirty", files: "r2.filesDirty", peer: "r2.peerDirty", status: "r2.status", running: "r2.running", started: "r2.started" }

/** Only these shapes are accepted, so the values are safe inside the shell lines below. */
function validConfig(config) {
  return !!config
    && /^https:\/\/[a-z0-9.-]+$/i.test(config.R2_ENDPOINT || "")
    && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.R2_BUCKET || "")
    && /^[A-Za-z0-9]{16,128}$/.test(config.R2_ACCESS_KEY_ID || "")
    && /^[A-Za-z0-9]{16,128}$/.test(config.R2_SECRET_ACCESS_KEY || "")
}

function readConfig() {
  try {
    const config = {}
    toString($os.readFile(CONFIG)).split("\n").forEach((line) => {
      const at = line.indexOf("=")
      if (at > 0) config[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    })
    return validConfig(config) ? config : null
  } catch (_) {
    return null
  }
}

/** The "https://<account>.r2.cloudflarestorage.com/<bucket>" address R2 shows for a bucket. */
function parseS3Url(url) {
  const match = String(url || "").trim().match(/^(https:\/\/[a-z0-9.-]+)\/([a-z0-9-]+)\/?$/i)
  return match ? { R2_ENDPOINT: match[1], R2_BUCKET: match[2].toLowerCase() } : null
}

/** rclone's "r2" remote, from the config. A test server can set another type in its environment. */
function rcloneEnv(config) {
  return "export RCLONE_CONFIG_R2_TYPE=${RCLONE_CONFIG_R2_TYPE:-s3} RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true"
    + " RCLONE_CONFIG_R2_ENDPOINT='" + config.R2_ENDPOINT + "'"
    + " RCLONE_CONFIG_R2_ACCESS_KEY_ID='" + config.R2_ACCESS_KEY_ID + "'"
    + " RCLONE_CONFIG_R2_SECRET_ACCESS_KEY='" + config.R2_SECRET_ACCESS_KEY + "'; "
}

/** { env, target } for the shell lines, or null when the backup is off. */
function remote() {
  const config = readConfig()
  return config ? { env: rcloneEnv(config), target: "r2:" + config.R2_BUCKET } : null
}

function status() {
  try { return JSON.parse($app.store().get(KEY.status) || "{}") } catch (_) { return {} }
}

function setStatus(patch) {
  $app.store().set(KEY.status, JSON.stringify(Object.assign(status(), patch)))
}

function markDb() {
  const store = $app.store()
  store.set(KEY.db, true)
  store.set(KEY.peer, true)
}
function markFiles() { $app.store().set(KEY.files, true) }

/** Runs a shell line; throws with its output when it fails. Arguments are ours, never a user's. */
function sh(line) {
  // A subshell, so every command's errors are caught and an "exit" in the line stops only it.
  const out = toString($os.cmd("sh", "-c", "(" + line + ") 2>&1; echo \"#exit $?\"").output()).trim()
  const at = out.lastIndexOf("#exit ")
  const code = Number(out.slice(at + 6))
  const text = out.slice(0, at).trim()
  if (code !== 0) throw new Error(text.split("\n").slice(-3).join(" ").slice(0, 300) || "exit " + code)
  return text
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}

/** A consistent copy of the database while the server keeps writing: { file (gz), at }. */
function dumpDb() {
  try { $os.mkdirAll(WORK, 0o700) } catch (_) {}
  const copy = WORK + "/data.db"
  sh("rm -f " + copy + " " + copy + ".gz")
  const at = Date.now()
  $app.db().newQuery("VACUUM INTO {:path}").bind({ path: copy }).execute()
  sh("gzip " + copy)
  return { file: copy + ".gz", at: at }
}

/** The database to R2, over the current copy. */
function pushDb(r, dump) {
  const d = dump || dumpDb()
  sh(r.env + "rclone copyto " + d.file + " " + r.target + "/db/current.db.gz && printf '%s' '" + d.at + "' | rclone rcat " + r.target + "/db/current.at")
  return d
}

/** Login states uploaded in the last two hours (new files only; the daily pass mirrors). */
function pushFiles(r) {
  sh(r.env + "[ -d " + DATA + "/storage ] || exit 0; rclone copy --max-age 2h --no-traverse " + DATA + "/storage " + r.target + "/storage")
}

/** storage/ in R2 the same as here (only changes are sent). Skipped while there are no login states
 * here at all, so a server that came up without them never wipes the bucket's. */
function pushStorage(r) {
  sh(r.env + "[ -d " + DATA + "/storage ] && [ -n \"$(ls -A " + DATA + "/storage)\" ] || exit 0; rclone sync " + DATA + "/storage " + r.target + "/storage")
}

/** Yesterday's copy: the current one, over the day before (copied inside R2, only what changed). */
function keepYesterday(r) {
  sh(r.env + "if rclone lsf " + r.target + "/db/current.db.gz | grep -q .; then"
    + " rclone copyto " + r.target + "/db/current.db.gz " + r.target + "/db/yesterday.db.gz"
    + " && (rclone copyto " + r.target + "/db/current.at " + r.target + "/db/yesterday.at || true)"
    + " && rclone sync " + r.target + "/storage " + r.target + "/storage-yesterday; fi")
}

/** What earlier versions kept: a copy per change, deleted files, daily zips, the private fonts. */
function removeOldCopies(r) {
  sh(r.env + "rclone delete " + r.target + "/db --include '2*.db.gz' || true; "
    + "for d in daily deleted assets; do rclone purge " + r.target + "/$d 2>/dev/null || true; done; "
    + "rm -f " + DATA + "/backups/@auto_pb_backup_*")
}

function fullPass(r, yesterday) {
  if (yesterday) keepYesterday(r)
  pushDb(r)
  pushStorage(r)
  removeOldCopies(r)
}

/** The shared key of the two servers: both have the same R2 settings, nobody else does. */
function peerKey() {
  const config = readConfig()
  return config ? $security.sha256("prism-peer-1|" + config.R2_ACCESS_KEY_ID + "|" + config.R2_SECRET_ACCESS_KEY) : ""
}

/** The database to the other servers of the team (the standby ones); throws with the reasons. */
function pushPeers(dump) {
  const control = require(`${__hooks}/control_utils.js`)
  const self = control.self()
  const peers = control.servers().filter((url) => url && url !== self)
  if (!peers.length) return []
  const key = peerKey()
  if (!key) return []
  const d = dump || dumpDb()
  const body = JSON.stringify({
    from: self,
    at: d.at,
    sha256: sh("sha256sum " + d.file + " | cut -d' ' -f1"),
    db: sh("base64 " + d.file + " | tr -d '\\n'")
  })
  const failed = []
  peers.forEach((url) => {
    try {
      const reply = $http.send({ url: url + "/api/team/peer/db", method: "POST", body: body, headers: { "content-type": "application/json", "X-Peer-Key": key }, timeout: 60 })
      if (reply.statusCode !== 200) failed.push(url + "：" + ((reply.json && reply.json.message) || ("HTTP " + reply.statusCode)))
    } catch (err) {
      failed.push(url + "：" + err)
    }
  })
  if (failed.length) throw new Error(failed.join("；"))
  return peers
}

/** Writes and removes a small file, so a wrong address or key shows before it is saved. */
function check(config) {
  try {
    sh(rcloneEnv(config) + "printf ok | rclone rcat r2:" + config.R2_BUCKET + "/.prism-check && rclone deletefile r2:" + config.R2_BUCKET + "/.prism-check")
  } catch (err) {
    const text = String(err.message || err)
    if (/Unauthorized|status code: 401|SignatureDoesNotMatch|InvalidAccessKeyId/.test(text)) throw new Error("密钥不对：访问密钥 ID 和机密访问密钥要来自同一个 R2 API 令牌，复制时别多空格或少字符")
    if (/AccessDenied|status code: 403/.test(text)) throw new Error("R2 拒绝访问：机密访问密钥不对（别填成「令牌值」），或者令牌的权限不是「对象读和写」、没包含这个存储桶")
    if (/NoSuchBucket|status code: 404/.test(text)) throw new Error("找不到这个存储桶：检查 S3 API 地址最后的存储桶名")
    throw err
  }
}

/** Saves the bucket and key (after check) and starts over with a full pass on the next minute. */
function saveConfig(config) {
  const text = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].map((key) => key + "=" + config[key]).join("\n") + "\n"
  $os.writeFile(CONFIG, text, 0o600)
  $app.store().remove(KEY.started)
  $app.store().remove(KEY.status)
}

function removeConfig() {
  try { $os.remove(CONFIG) } catch (_) {}
  $app.store().remove(KEY.started)
  $app.store().remove(KEY.status)
}

/** One run at a time; a run that died long ago does not block forever. */
function guarded(work) {
  const store = $app.store()
  const since = store.get(KEY.running)
  if (since && Date.now() - since < 30 * 60 * 1000) return
  store.set(KEY.running, Date.now())
  try { work() } finally { store.remove(KEY.running) }
}

/** A standby server (control_utils.js) must not write its old data over the active server's copy. */
function standby() {
  if (require(`${__hooks}/control_utils.js`).role() !== "active") return true
  // A server without accounts (a fresh standby before the marker names it) has nothing to keep.
  return !require(`${__hooks}/team_utils.js`).findOrNull($app, "users", 'role = "owner"', {})
}

/** Every minute: whatever changed since the last run. */
function tick() {
  const target = remote()
  if (!target) return
  const store = $app.store()
  const work = store.get(KEY.files) || store.get(KEY.db) || store.get(KEY.peer) || !store.get(KEY.started)
  if (!work) return
  // Copies are written over now: be sure this server is still the one in use before writing.
  require(`${__hooks}/control_utils.js`).refreshSoon()
  if (standby()) return
  if (!store.get(KEY.started)) {
    daily(false)
    return
  }
  guarded(() => {
    if (store.get(KEY.files)) {
      store.remove(KEY.files)
      try {
        pushFiles(target)
        setStatus({ lastFiles: Date.now() })
      } catch (err) {
        markFiles()
        setStatus({ lastError: "登录态备份失败：" + err.message, lastErrorAt: Date.now() })
      }
    }
    let dump = null
    if (store.get(KEY.db)) {
      store.remove(KEY.db)
      try {
        dump = pushDb(target)
        setStatus({ lastDb: Date.now() })
      } catch (err) {
        store.set(KEY.db, true)
        setStatus({ lastError: "数据库备份失败：" + err.message, lastErrorAt: Date.now() })
      }
    }
    if (store.get(KEY.peer)) syncPeers(dump)
  })
}

function syncPeers(dump) {
  const store = $app.store()
  store.remove(KEY.peer)
  try {
    const peers = pushPeers(dump)
    if (peers.length) setStatus({ lastPeer: Date.now(), peers: peers, peerError: "", peerErrorAt: 0 })
  } catch (err) {
    // Tried again next minute (a standby server that is down gets it when it is back).
    store.set(KEY.peer, true)
    setStatus({ peerError: "同步到备用服务器失败：" + err.message, peerErrorAt: Date.now() })
  }
}

/** The full pass: at start (yesterday false) and every day at 03:30 Beijing time (yesterday true). */
function daily(yesterday) {
  const target = remote()
  if (!target || standby()) return
  guarded(() => {
    const store = $app.store()
    // Changes made while the pass runs set the flags again for the next minute.
    store.remove(KEY.db)
    store.remove(KEY.files)
    try {
      fullPass(target, yesterday !== false)
      const now = Date.now()
      store.set(KEY.started, true)
      setStatus(Object.assign({ lastDb: now, lastFiles: now, lastFull: now }, yesterday !== false ? { lastYesterday: now } : {}))
    } catch (err) {
      markDb()
      markFiles()
      setStatus({ lastError: "完整备份失败：" + err.message, lastErrorAt: Date.now() })
    }
    syncPeers(null)
  })
}

/** For the app's server page; the secret key never leaves the server. */
function summary() {
  const config = readConfig()
  const store = $app.store()
  const base = { configured: !!config, pending: !!(config && (store.get(KEY.db) || store.get(KEY.files))) }
  if (!config) return base
  const id = config.R2_ACCESS_KEY_ID
  return Object.assign(base, {
    bucket: config.R2_BUCKET,
    endpoint: config.R2_ENDPOINT,
    accessKeyId: id.slice(0, 4) + "…" + id.slice(-4)
  }, status())
}

module.exports = { DATA, PEER_DIR, markDb, markFiles, tick, daily, summary, parseS3Url, validConfig, readConfig, check, saveConfig, removeConfig, remote, sh, stamp, dumpDb, pushDb, pushStorage, pushPeers, peerKey }
