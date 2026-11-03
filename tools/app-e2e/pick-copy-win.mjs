// Windows, by hand on a real team: the 「添加到本机」 copy picker (TeamPage + PickCopyModal).
// A test launcher on its own data folder, signed in to the team like this computer (team.json and the
// key in Local State copied from the real launcher, links emptied; with --new-computer the computer id is
// dropped too, so it is a computer that never had any window). It opens 团队, clicks 「添加到本机」 on the
// window named <name>, and:
//   this computer: the picker must appear; it picks <pick device> (a computer name) and adds;
//   --new-computer: no picker; the window is added with the latest copy (taken on the first open).
// The window is never opened, so nothing is uploaded. Output: <log folder>\pick-copy.log, screenshots there.
// node pick-copy-win.mjs <launcher exe> <real Local State> <real vault folder> <test folder> <name> <pick device> [--new-computer]
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const [app, localState, vault, folder, name, pickDevice, ...flags] = process.argv.slice(2)
const newComputer = flags.includes('--new-computer')
const userData = join(folder, 'appdata')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => appendFileSync(join(folder, 'pick-copy.log'), `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}\n`)

rmSync(userData, { recursive: true, force: true })
mkdirSync(join(userData, 'vault'), { recursive: true })
copyFileSync(localState, join(userData, 'Local State'))
for (const file of ['settings.json']) copyFileSync(join(vault, file), join(userData, 'vault', file))
const team = JSON.parse(readFileSync(join(vault, 'team.json'), 'utf8'))
// The real computer's windows count as deleted here, so the start-up sync does not add them by itself
// (as after 「从本机删除」); 「添加到本机」 is then the way back.
team.removed = { ...(team.removed ?? {}), ...team.links }
team.links = {}
delete team.localTouched
if (newComputer) delete team.deviceId
writeFileSync(join(userData, 'vault', 'team.json'), JSON.stringify(team, null, 2))
log('test data', newComputer ? 'new computer' : 'this computer (same computer id)')

const port = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const child = spawn(app, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, PRISM_E2E: '1', PRISM_E2E_USER_DATA: userData } })
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
const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(folder, file), Buffer.from(r.data, 'base64')); log('screenshot', file) }
// Clicks the first element whose own text is exactly `text` (inside `scope`, a CSS selector), retrying.
const click = async (text, scope = 'body', within = '') => {
  for (let i = 0; i < 40; i++) {
    const done = await evaluate(`(() => { const root = [...document.querySelectorAll(${JSON.stringify(scope)})].pop(); if (!root) return false; const host = ${JSON.stringify(within)} ? [...root.querySelectorAll('tr')].find((tr) => tr.textContent.includes(${JSON.stringify(within)})) : root; if (!host) return false; const pick = (sel) => [...host.querySelectorAll(sel)].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.offsetParent); const el = pick('button') || pick('tr') || pick('a, span, div, li, td'); if (!el) return false; el.click(); return true })()`)
    if (done) return true
    await delay(500)
  }
  throw new Error('not found: ' + text + (within ? ' in ' + within : ''))
}
try {
  for (let i = 0; i < 120; i++) { if (await evaluate('!!(window.browserApi && document.readyState === "complete")').catch(() => false)) break; await delay(500) }
  for (let i = 0; i < 90; i++) { const st = await evaluate('window.browserApi.team.status().then((s) => ({ role: s.user?.role, offline: !!s.offline }))'); if (st.role && !st.offline) break; await delay(2000) }
  await delay(3000)
  await click('团队')
  await delay(3000)
  log('api', await evaluate(`(async () => { const list = await window.browserApi.team.profiles(); const p = list.find((x) => x.name === ${JSON.stringify(name)}); if (!p) return 'no cloud window'; const t0 = Date.now(); const states = await Promise.race([window.browserApi.team.cloudDeviceStates(p.id), new Promise((r) => setTimeout(() => r('timeout'), 20000))]); return JSON.stringify({ localId: p.localId ?? null, removedHere: p.removedHere, ms: Date.now() - t0, states: states === 'timeout' ? states : states.map((x) => x.deviceName + (x.thisComputer ? '(this)' : '')) }) })()`).catch((e) => 'failed ' + e.message))
  log('row', await evaluate(`(() => { const tr = [...document.querySelectorAll('.ant-table tr')].find((x) => x.textContent.includes(${JSON.stringify(name)})); return tr ? [...tr.querySelectorAll('button')].map((b) => b.textContent.trim() + (b.disabled ? '(disabled)' : '')).join(' / ') + ' || ' + tr.innerText.replace(/\\s+/g, ' ') : 'no row' })()`))
  await click('添加到本机', '.ant-table', name)
  // The picker (asks the server for the copies first) or, with no copy of this computer, the window added.
  let modal = null
  for (let i = 0; i < 60 && !modal; i++) {
    modal = await evaluate(`(() => { const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent && x.textContent.includes('登录状态')); return m ? m.innerText.replace(/\\s+/g, ' ').slice(0, 600) : null })()`)
    if (!modal && await evaluate('window.browserApi.profiles.list().then((l) => l.length > 0)')) break
    await delay(500)
  }
  log('messages', await evaluate(`[...document.querySelectorAll('.ant-notification-notice, .ant-message-notice')].map((x) => x.innerText.replace(/\\s+/g, ' ')).join(' | ') || 'none'`))
  log('picker', modal ?? 'none')
  await shot(newComputer ? 'new-computer.png' : 'picker.png')
  if (modal) {
    await click(pickDevice, '.ant-modal')
    await delay(500)
    await shot('picker-chosen.png')
    await click('添加到本机', '.ant-modal-footer')
    // Added and the chosen copy put in: the page says 已添加到本机 (or shows the error).
    let note = ''
    for (let i = 0; i < 180 && !/已添加到本机|失败|错误|不能|请先/.test(note); i++) {
      note = await evaluate(`[...document.querySelectorAll('.ant-notification-notice, .ant-message-notice')].map((x) => x.innerText.replace(/\\s+/g, ' ')).join(' | ')`)
      await delay(500)
    }
    log('after adding', note || 'no message in 90 s')
  } else {
    await delay(5000)
  }
  log('added', await evaluate(`window.browserApi.profiles.list().then((l) => l.map((p) => p.name + ' 序号 ' + p.serialNumber).join(', '))`))
} catch (error) {
  log('error', String(error?.message ?? error).slice(0, 300))
}
try { log('launcher log', readFileSync(join(userData, 'vault', 'logs', 'prism.log'), 'utf8').split('\n').filter((l) => /恢复另一台电脑|restoreDeviceState|已添加|add/i.test(l)).map((l) => l.replace(/\d{1,3}(\.\d{1,3}){3}/g, '<ip>').slice(0, 220)).join(' | ')) } catch {}
try { await evaluate('window.browserApi.diagnostics.e2eQuit()') } catch {}
await delay(4000)
try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {}
log('done')
process.exit(0)
