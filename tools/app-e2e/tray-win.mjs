// Windows, a test launcher on empty test data folders (nothing of the user's is read or changed):
//   1. Default: closing the main window (WM_CLOSE, what its X sends) hides it (the app keeps running, the page
//      is hidden) and notes the one-time tray tip; starting the app again shows it; closing again still
//      hides, the tip not again; quitting ends the app.
//   2. 「关闭主界面时」 = 退出: closing the main window (no browser windows open) quits the app.
// node tray-win.mjs <launcher exe> <test folder>   Output: <test folder>\tray.log
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const [exe, folder] = process.argv.slice(2)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(folder, { recursive: true })
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; console.log(line); appendFileSync(join(folder, 'tray.log'), line + '\n') }

async function start(name) {
  const userData = join(folder, name)
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  const port = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const child = spawn(exe, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, PRISM_E2E: '1', PRISM_E2E_USER_DATA: userData } })
  let exited = false
  child.on('exit', () => { exited = true })
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
  return { userData, child, port, evaluate, exited: () => exited }
}

// WM_CLOSE to the app's visible top-level window: the same as clicking its X (renderer window.close() is not).
function closeMain(pid) {
  return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CloseMainWindow()`], { encoding: 'utf8' }).trim()
}

async function waitExit(app, ms) {
  for (let i = 0; i < ms / 250 && !app.exited(); i++) await delay(250)
  return app.exited()
}

// 1. Default: X hides to the tray.
{
  const app = await start('tray-a')
  const hint = join(app.userData, 'tray-hint-shown')
  log('1 default closeAction =', JSON.stringify(await app.evaluate('window.browserApi.app.preferences().then((p) => p.closeAction)')))
  log('1 visible before close =', await app.evaluate('document.visibilityState'), 'hint file =', existsSync(hint))
  log('1 X (WM_CLOSE) sent =', closeMain(app.child.pid))
  await delay(2500)
  log('1 after X: app running =', !app.exited(), 'page =', await app.evaluate('document.visibilityState').catch((e) => 'error ' + e.message), 'hint file =', existsSync(hint))
  const firstHint = existsSync(hint) ? statSync(hint).mtimeMs : 0
  // Started again (a second copy, as from the desktop icon): the hidden window comes back.
  const again = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, PRISM_E2E: '1', PRISM_E2E_USER_DATA: app.userData } })
  await new Promise((r) => again.on('exit', r))
  await delay(1500)
  log('1 started again: page =', await app.evaluate('document.visibilityState').catch((e) => 'error ' + e.message))
  log('1 X again sent =', closeMain(app.child.pid))
  await delay(2000)
  log('1 after X again: app running =', !app.exited(), 'page =', await app.evaluate('document.visibilityState').catch((e) => 'error ' + e.message), 'tip only once =', existsSync(hint) && statSync(hint).mtimeMs === firstHint)
  await app.evaluate('window.browserApi.diagnostics.e2eQuit()').catch(() => undefined)
  log('1 quit: app exited =', await waitExit(app, 30000))
}

// 2. 关闭主界面时 = 退出: X quits (no browser windows open, so nothing to ask).
{
  const app = await start('tray-b')
  log('2 set =', JSON.stringify(await app.evaluate("window.browserApi.app.setPreferences({ closeAction: 'quit' }).then((p) => p.closeAction)")))
  log('2 X (WM_CLOSE) sent =', closeMain(app.child.pid))
  log('2 after X: app exited =', await waitExit(app, 30000))
  if (!app.exited()) { await app.evaluate('window.browserApi.diagnostics.e2eQuit()').catch(() => undefined); await waitExit(app, 20000) }
}
log('DONE')
process.exit(0)
