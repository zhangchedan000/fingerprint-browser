// Windows, by hand on a real team: one login state per window (0.5.58). Each launcher runs on its own test
// data folder, signed in to the team like this computer (team.json and the key in Local State copied; this
// computer's windows counted as deleted there, so nothing of the user's is added or opened).
//   1. Launcher A (this computer's id) adds <source window>, duplicates it into a throwaway window (it goes to
//      the cloud as a new window), opens and closes it: the close uploads (rev 2); 测试模式 on: open, close,
//      nothing uploaded; 测试模式 off: backed up first (rev 3).
//   2. Launcher B (a computer that never had it): adds the throwaway window, opens it: the latest comes down;
//      closes it: rev 4.
//   3. With --old <0.5.57 exe>: the same on the older app: opens the latest, closes: rev 5 (its own copy is
//      refused by the server and only logged).
//   4. The throwaway window is deleted from the cloud; every test folder is removed by the caller.
// Each step logs the launcher's [登录态] lines. Output: <test folder>\latest-only.log
// node latest-only-win.mjs <launcher exe> <real Local State> <real vault folder> <test folder> <source window name> [--old <exe>]
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const [app, localState, vault, folder, sourceName, ...flags] = process.argv.slice(2)
const oldApp = flags.includes('--old') ? flags[flags.indexOf('--old') + 1] : ''
// A throwaway window an earlier run left in the cloud (its exact name), deleted first.
const leftover = flags.includes('--delete-name') ? flags[flags.indexOf('--delete-name') + 1] : ''
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => appendFileSync(join(folder, 'latest-only.log'), `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}\n`)

function prepare(name, newComputer) {
  const userData = join(folder, name)
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(join(userData, 'vault'), { recursive: true })
  copyFileSync(localState, join(userData, 'Local State'))
  copyFileSync(join(vault, 'settings.json'), join(userData, 'vault', 'settings.json'))
  for (const dir of ['kernels', 'kernel-fonts']) {
    try { execFileSync('robocopy', [join(vault, dir), join(userData, 'vault', dir), '/E', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' }) } catch (e) { if (e.status >= 8) throw e }
  }
  const team = JSON.parse(readFileSync(join(vault, 'team.json'), 'utf8'))
  team.removed = { ...(team.removed ?? {}), ...team.links }
  team.links = {}
  delete team.localTouched
  if (newComputer) delete team.deviceId
  writeFileSync(join(userData, 'vault', 'team.json'), JSON.stringify(team, null, 2))
  return userData
}

async function start(exe, userData) {
  const port = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const child = spawn(exe, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, PRISM_E2E: '1', PRISM_E2E_USER_DATA: userData } })
  let ws
  for (let i = 0; i < 240 && !ws; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); ws = t.find((x) => x.type === 'page' && /index\.html/.test(x.url))?.webSocketDebuggerUrl } catch {}
    if (!ws) await delay(500)
  }
  const s = new WebSocket(ws); await new Promise((r) => s.addEventListener('open', r, { once: true }))
  let seq = 0; const pend = new Map()
  s.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pend.set(id, (m) => resolve(m.result)); s.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'error'); return r?.result?.value }
  for (let i = 0; i < 120; i++) { if (await evaluate('!!(window.browserApi && document.readyState === "complete")').catch(() => false)) break; await delay(500) }
  for (let i = 0; i < 90; i++) { const st = await evaluate('window.browserApi.team.status().then((s) => ({ role: s.user?.role, offline: !!s.offline }))').catch(() => ({})); if (st.role && !st.offline) break; await delay(2000) }
  const stop = async () => {
    try { await evaluate('window.browserApi.diagnostics.e2eQuit()') } catch {}
    for (let i = 0; i < 120 && child.exitCode === null; i++) await delay(500)
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {}
  }
  return { evaluate, stop }
}

/** The launcher's [登录态] lines (and the old app's per-computer messages) written since `from`. */
function stateLines(userData, from) {
  const file = join(userData, 'vault', 'logs', 'prism.log')
  if (!existsSync(file)) return ['(no log)']
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.slice(0, 24) >= from && /\[登录态\]|登录态|本机云端备份|Cookie/.test(l)).map((l) => l.replace(/\d{1,3}(\.\d{1,3}){3}/g, '<ip>').slice(0, 260))
}
const J = JSON.stringify
const rev = (ev, teamId) => ev(`window.browserApi.team.profiles().then((l) => l.find((p) => p.id === ${J(teamId)})?.dataRev ?? null)`)
const localOf = (ev, teamId) => ev(`window.browserApi.team.links().then((l) => l.find((x) => x.teamId === ${J(teamId)})?.profileId ?? null)`)
async function openClose(ev, id, label, userData) {
  const from = new Date().toISOString()
  await ev(`window.browserApi.profiles.launch(${J(id)}).then(() => true)`)
  await delay(8000)
  await ev(`window.browserApi.profiles.close(${J(id)}).then(() => true)`)
  // The upload runs after the close (background); wait for its line.
  for (let i = 0; i < 90; i++) { if (stateLines(userData, from).some((l) => /已上传|没有上传|上传失败/.test(l))) break; await delay(1000) }
  log(label, '\n  ' + stateLines(userData, from).join('\n  '))
}

let teamId = ''
let running
try {
  // 1. Launcher A, this computer.
  const aData = prepare('a', false)
  const a = await start(app, aData)
  running = a
  if (leftover) {
    const ids = await a.evaluate(`window.browserApi.team.profiles().then((l) => l.filter((p) => p.name === ${J(leftover)}).map((p) => p.id))`)
    for (const id of ids) await a.evaluate(`window.browserApi.team.unshare(${J(id)}).then(() => true)`)
    log('leftover throwaway windows deleted', leftover, ids.length)
  }
  const source = await a.evaluate(`window.browserApi.team.profiles().then((l) => l.find((p) => p.name === ${J(sourceName)})?.id)`)
  const sourceLocal = await a.evaluate(`window.browserApi.team.addToComputer(${J(source)})`)
  const copy = await a.evaluate(`window.browserApi.profiles.duplicate(${J(sourceLocal)}).then((p) => p.id)`)
  // The copy goes to the cloud as a new window (the sync after a duplicate).
  for (let i = 0; i < 60 && !teamId; i++) { await delay(1000); teamId = await a.evaluate(`window.browserApi.team.links().then((l) => l.find((x) => x.profileId === ${J(copy)})?.teamId ?? '')`) }
  const copyName = await a.evaluate(`window.browserApi.profiles.list().then((l) => l.find((p) => p.id === ${J(copy)})?.name)`)
  log('A: throwaway window', copyName, 'cloud rev', await rev(a.evaluate, teamId))
  await openClose(a.evaluate, copy, 'A open + close (normal):', aData)
  log('A: cloud rev now', await rev(a.evaluate, teamId))
  await a.evaluate(`window.browserApi.profiles.setTestMode(${J(copy)}, true).then(() => true)`)
  await openClose(a.evaluate, copy, 'A open + close (测试模式):', aData)
  log('A: cloud rev now', await rev(a.evaluate, teamId))
  const offFrom = new Date().toISOString()
  await a.evaluate(`window.browserApi.profiles.setTestMode(${J(copy)}, false).then(() => true)`)
  await delay(3000)
  log('A: 测试模式 off', '\n  ' + stateLines(aData, offFrom).join('\n  '), '\n  cloud rev now', await rev(a.evaluate, teamId))
  await a.stop()
  running = undefined

  // 2. Launcher B, a computer that never had it.
  const bData = prepare('b', true)
  const b = await start(app, bData)
  running = b
  const onB = await b.evaluate(`window.browserApi.team.addToComputer(${J(teamId)})`)
  await openClose(b.evaluate, onB, 'B (other computer) open + close:', bData)
  log('B: cloud rev now', await rev(b.evaluate, teamId))
  await b.stop()
  running = undefined

  // 3. The older app against the updated server.
  if (oldApp) {
    const cData = prepare('c', true)
    const c = await start(oldApp, cData)
    running = c
    log('old app version', await c.evaluate('window.browserApi.app.version ? window.browserApi.app.version() : "?"').catch(() => '?'))
    const onC = await c.evaluate(`window.browserApi.team.addToComputer(${J(teamId)})`)
    await openClose(c.evaluate, onC, 'old app open + close:', cData)
    log('old app: cloud rev now', await rev(c.evaluate, teamId))
    await c.stop()
    running = undefined
  }
} catch (error) {
  log('error', String(error?.message ?? error).slice(0, 400))
  await running?.stop()
}
// 4. The throwaway cloud window goes (from a fresh launcher A run).
if (teamId) {
  try {
    const a = await start(app, join(folder, 'a'))
    await a.evaluate(`window.browserApi.team.unshare(${J(teamId)}).then(() => true)`)
    log('throwaway cloud window deleted', teamId, await a.evaluate(`window.browserApi.team.profiles().then((l) => !l.some((p) => p.id === ${J(teamId)}))`))
    await a.stop()
  } catch (error) {
    log('cleanup error', String(error?.message ?? error).slice(0, 300))
  }
}
log('done')
process.exit(0)
