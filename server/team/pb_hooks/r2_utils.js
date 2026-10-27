/// <reference path="../pb_data/types.d.ts" />

// Off-server backup to Cloudflare R2 with rclone, only when something changed:
// - the database (accounts, window configs, the log) a minute after a change, as db/<time>.db.gz;
// - login states (storage/) a minute after a window uploads one.
// Once a day (and once after the server starts) a full pass: a database copy, storage/ mirrored
// with removed files moved to deleted/<date>/, and copies older than 7 days pruned.
// The owner sets the bucket and its key in the app (r2.pb.js); they are kept in pb_data/r2.env.
// Hook handlers run in their own VMs, so state lives in $app.store().

const DATA = "/pb/pb_data"
const WORK = DATA + "/.r2"
const CONFIG = DATA + "/r2.env"
const KEEP_DAYS = 7
const KEY = { db: "r2.dbDirty", files: "r2.filesDirty", status: "r2.status", running: "r2.running", started: "r2.started" }

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

function markDb() { $app.store().set(KEY.db, true) }
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

function pushDb(r) {
  try { $os.mkdirAll(WORK, 0o700) } catch (_) {}
  const copy = WORK + "/data.db"
  sh("rm -f " + copy + " " + copy + ".gz")
  // A consistent copy while the server keeps writing.
  $app.db().newQuery("VACUUM INTO {:path}").bind({ path: copy }).execute()
  sh(r.env + "gzip " + copy + " && rclone copyto " + copy + ".gz " + r.target + "/db/" + stamp() + ".db.gz && rm -f " + copy + ".gz")
}

function pushFiles(r) {
  sh(r.env + "[ -d " + DATA + "/storage ] || exit 0; rclone copy --max-age 2h --no-traverse " + DATA + "/storage " + r.target + "/storage")
}

function fullPass(r) {
  pushDb(r)
  const day = stamp().slice(0, 8)
  sh(r.env + "[ -d " + DATA + "/storage ] || exit 0; rclone sync " + DATA + "/storage " + r.target + "/storage --backup-dir " + r.target + "/deleted/" + day)
  sh(r.env + "rclone delete --min-age " + KEEP_DAYS + "d " + r.target + "/deleted; rclone delete --min-age " + KEEP_DAYS + "d " + r.target + "/db")
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

/** Every minute: whatever changed since the last run. */
function tick() {
  const target = remote()
  if (!target) return
  const store = $app.store()
  if (!store.get(KEY.started)) {
    daily()
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
    if (store.get(KEY.db)) {
      store.remove(KEY.db)
      try {
        pushDb(target)
        setStatus({ lastDb: Date.now() })
      } catch (err) {
        markDb()
        setStatus({ lastError: "数据库备份失败：" + err.message, lastErrorAt: Date.now() })
      }
    }
  })
}

function daily() {
  const target = remote()
  if (!target) return
  guarded(() => {
    const store = $app.store()
    // Changes made while the pass runs set the flags again for the next minute.
    store.remove(KEY.db)
    store.remove(KEY.files)
    try {
      fullPass(target)
      const now = Date.now()
      store.set(KEY.started, true)
      setStatus({ lastDb: now, lastFiles: now, lastFull: now })
    } catch (err) {
      markDb()
      markFiles()
      setStatus({ lastError: "完整备份失败：" + err.message, lastErrorAt: Date.now() })
    }
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

module.exports = { markDb, markFiles, tick, daily, summary, parseS3Url, validConfig, check, saveConfig, removeConfig, KEEP_DAYS }
