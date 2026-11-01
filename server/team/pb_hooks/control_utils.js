/// <reference path="../pb_data/types.d.ts" />

// Two servers, one of them in use. Which one is written in the R2 bucket (r2_utils.js) as
// control/active.json: { active: "<server address>", servers: ["<address>", ...], since: <ms> }.
// The server named there is "active"; any other server that shares the bucket is "standby": it
// answers only /api/team/status and the standby routes (control.pb.js), so nothing is written
// on two servers at once, and it never pushes its own (old) data to R2.
// The active server pushes its database to the standby one after every change (r2_utils.js).
// A standby server takes over with /api/team/activate: it takes the newest database (its own copy
// or R2's) and the login states from R2, names itself active, and restarts (start.sh swaps them in).
// Each server knows its own address from TEAM_PUBLIC_URL in .env.
// Without R2, or before the first marker is written, a server is simply active (one server).
// When R2 does not answer, the last marker stays (saved in pb_data/.control-last.json for restarts);
// a server that took over meanwhile (allowed only when the active one does not answer either) keeps
// pb_data/.control-override.json and writes the marker once R2 answers again; the others follow it.

const KEY = { active: "control.active", servers: "control.servers", since: "control.since", handover: "control.handover" }
const MARKER = "control/active.json"
// The old server stops writing while the new one takes over; if no takeover happens it resumes.
const HANDOVER_MS = 10 * 60 * 1000

function normalize(url) {
  return String(url || "").trim().replace(/\/+$/, "").toLowerCase()
}

/** Only https addresses (http for a local test server), no paths: safe inside shell lines. */
function validUrl(url) {
  return /^https:\/\/[a-z0-9.-]+(:\d{2,5})?$/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?$/.test(url)
}

function self() {
  return normalize($os.getenv("TEAM_PUBLIC_URL"))
}

/** The marker, {} when there is none yet, null without R2; throws when R2 does not answer (a
 * bucket that cannot be read is not the same as one without a marker). */
function readMarker() {
  const r2 = require(`${__hooks}/r2_utils.js`)
  const r = r2.remote()
  if (!r) return null
  // rclone's notices (stderr) stay out of the text; a failure still fails the line.
  const text = r2.sh(r.env + "top=$(rclone lsf --max-depth 1 " + r.target + " 2>/dev/null) || exit 1; "
    + "case \"$top\" in *control/*) rclone cat " + r.target + "/" + MARKER + " 2>/dev/null ;; esac")
  if (!text) return {}
  const marker = JSON.parse(text)
  return {
    active: normalize(marker.active),
    servers: Array.isArray(marker.servers) ? marker.servers.map(normalize).filter(validUrl) : [],
    since: Number(marker.since) || 0
  }
}

function dataDir() {
  return require(`${__hooks}/r2_utils.js`).DATA
}

/** A takeover made while R2 did not answer (control.pb.js): this server is active until R2 knows. */
function readOverride() {
  try { return JSON.parse(toString($os.readFile(dataDir() + "/.control-override.json"))) } catch (_) { return null }
}

function writeOverride(active, servers) {
  const marker = { active: normalize(active), servers: servers, since: Date.now() }
  $os.writeFile(dataDir() + "/.control-override.json", JSON.stringify(marker), 0o600)
  setStore(marker)
  return marker
}

function setStore(marker) {
  const store = $app.store()
  store.set(KEY.active, marker.active)
  store.set(KEY.servers, JSON.stringify(marker.servers || []))
  store.set(KEY.since, marker.since || 0)
  // The last marker seen, for a restart while R2 does not answer.
  try { $os.writeFile(dataDir() + "/.control-last.json", JSON.stringify(marker), 0o600) } catch (_) {}
}

/**
 * R2 does not answer: keep the last marker (after a restart: the one saved on disk), but if one of
 * the other servers says it is the active one now (it took over without R2), follow it.
 */
function fallback() {
  const store = $app.store()
  if (!store.get(KEY.active)) {
    try { setStore(JSON.parse(toString($os.readFile(dataDir() + "/.control-last.json")))) } catch (_) {}
  }
  const me = self()
  servers().filter((url) => url && url !== me && url !== active()).forEach((url) => {
    try {
      const reply = $http.send({ url: url + "/api/team/status", method: "GET", timeout: 10 })
      const json = reply.json || {}
      if (reply.statusCode === 200 && json.role === "active" && normalize(json.self) === url && normalize(json.active) === url) {
        store.set(KEY.active, url)
        store.remove(KEY.handover)
      }
    } catch (_) {}
  })
}

/** Reads the marker into the store (every minute and at start). A failed read keeps the last one. */
function refresh() {
  const store = $app.store()
  const override = readOverride()
  if (override) {
    // Taken over while R2 did not answer: tell R2 as soon as it does.
    setStore(override)
    try {
      writeMarker(override.active, override.servers || [])
      $os.remove(dataDir() + "/.control-override.json")
    } catch (err) {
      console.log("control: R2 still not answering, marker not written yet: " + err)
    }
    return
  }
  try {
    const marker = readMarker()
    if (!marker || !marker.active) {
      store.remove(KEY.active)
      store.set(KEY.servers, JSON.stringify(marker && marker.servers ? marker.servers : []))
      return
    }
    setStore(marker)
    // The takeover happened elsewhere: the handover is done.
    if (marker.active !== self()) store.remove(KEY.handover)
  } catch (err) {
    console.log("control: marker not read: " + err)
    fallback()
  }
}

/** refresh(), at most every 10 seconds (requests on a server that is handing over). */
function refreshSoon() {
  const store = $app.store()
  const last = store.get("control.lastRead") || 0
  if (Date.now() - last < 10 * 1000) return
  store.set("control.lastRead", Date.now())
  refresh()
}

function writeMarker(active, servers) {
  const r2 = require(`${__hooks}/r2_utils.js`)
  const r = r2.remote()
  if (!r) throw new Error("还没开启异地备份（R2），不能设置备用服务器")
  const list = []
  servers.concat([active]).map(normalize).forEach((url) => { if (validUrl(url) && list.indexOf(url) < 0) list.push(url) })
  const marker = { active: normalize(active), servers: list, since: Date.now() }
  const json = JSON.stringify(marker).replace(/'/g, "")
  r2.sh(r.env + "printf '%s' '" + json + "' | rclone rcat " + r.target + "/" + MARKER)
  setStore(marker)
  return marker
}

function active() {
  return $app.store().get(KEY.active) || ""
}

function servers() {
  try { return JSON.parse($app.store().get(KEY.servers) || "[]") } catch (_) { return [] }
}

/** "active" or "standby" (named elsewhere, or handing over). */
function role() {
  const store = $app.store()
  const until = store.get(KEY.handover)
  if (until && Date.now() < until) return "standby"
  if (until) store.remove(KEY.handover)
  const current = active()
  if (!current) return "active"
  return current === self() ? "active" : "standby"
}

function startHandover() {
  $app.store().set(KEY.handover, Date.now() + HANDOVER_MS)
}

function endHandover() {
  $app.store().remove(KEY.handover)
}

/** When the database copy this server got from the active one was made (0: none). */
function peerAt() {
  const dir = require(`${__hooks}/r2_utils.js`).PEER_DIR
  try {
    $os.stat(dir + "/data.db.gz")
    return Number(toString($os.readFile(dir + "/at")).trim()) || 0
  } catch (_) {
    return 0
  }
}

/** Keeps a server's activation code (team_server_codes); unchanged ones are not written again. */
function saveCode(url, code) {
  const collection = $app.findCollectionByNameOrId("team_server_codes")
  let record
  try { record = $app.findFirstRecordByData("team_server_codes", "url", url) } catch (_) { record = new Record(collection) }
  if (record.getString("code") === code && record.getString("url") === url) return
  record.set("url", url)
  record.set("code", code)
  $app.save(record)
}

/** For /api/team/status: what launchers need to find the server in use (and how fresh a standby is). */
function view() {
  const at = peerAt()
  const files = require(`${__hooks}/r2_utils.js`).mirrorAt()
  return Object.assign({ role: role(), self: self(), active: active(), servers: servers() }, at ? { peerCopyAt: at } : {}, files ? { peerFilesAt: files } : {})
}

/** Checks the server's setup code (.env TEAM_SETUP_CODE); wrong tries are held off like invite codes. */
function requireSetupCode(e, code) {
  const t = require(`${__hooks}/team_utils.js`)
  const key = "setupcode:" + e.realIP()
  t.checkHold(e, key)
  const expected = $os.getenv("TEAM_SETUP_CODE")
  if (!expected || expected === "change-me" || String(code || "") !== expected) {
    t.addFailure(key)
    throw new ForbiddenError("这台服务器的激活码不对")
  }
  t.clearFailures(key)
}

module.exports = { requireSetupCode, peerAt, writeOverride, saveCode, normalize, validUrl, self, refresh, refreshSoon, readMarker, writeMarker, active, servers, role, startHandover, endHandover, view, MARKER, HANDOVER_MS }
