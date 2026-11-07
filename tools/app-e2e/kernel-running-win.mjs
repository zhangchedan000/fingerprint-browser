// Windows, a test launcher on a test folder (the user's launcher, windows and kernels are not touched):
// a kernel update while a window runs on it and is downloading a file.
//   1. The installed 156 kernel is copied into the test vault; a window is opened from it (its chrome.exe),
//      shows a page and starts downloading a ~200 MB file (a kernel zip from GitHub, over https).
//   2. During the download the test launcher installs another build of the kernel (历史版本): it must succeed;
//      the new build is what new windows get (engine.status); a window opened from it works.
//   3. The running window: the download must finish whole, the page must still work (script, a new page).
//   4. The running window is closed, the launcher started again: the old build is removed.
// node kernel-running-win.mjs <launcher exe> <installed kernel folder> <test folder>   Output: <test folder>\kernel-running.log
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer as createHttp } from 'node:http'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'

const [exe, kernelSource, folder] = process.argv.slice(2)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(folder, { recursive: true })
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; console.log(line); appendFileSync(join(folder, 'kernel-running.log'), line + '\n') }
const userData = join(folder, 'ud')
const id = basename(kernelSource)
const kernel = join(userData, 'vault', 'kernels', id)
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

async function cdp(url) {
  const s = new WebSocket(url); await new Promise((r) => s.addEventListener('open', r, { once: true }))
  let seq = 0; const pend = new Map(); const events = []
  s.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } else if (m.method) events.push(m) })
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++seq; pend.set(n, (m) => resolve(m.result ?? m.error)); s.send(JSON.stringify({ id: n, method, params })) })
  return { send, events, close: () => s.close() }
}

async function launcher() {
  const port = await freePort()
  const child = spawn(exe, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, PRISM_E2E: '1', PRISM_E2E_USER_DATA: userData } })
  let exited = false
  child.on('exit', () => { exited = true })
  let ws
  for (let i = 0; i < 240 && !ws; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); ws = t.find((x) => x.type === 'page' && /index\.html/.test(x.url))?.webSocketDebuggerUrl } catch {}
    if (!ws) await delay(500)
  }
  const c = await cdp(ws)
  const evaluate = async (expression) => { const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'error'); return r?.result?.value }
  for (let i = 0; i < 120; i++) { if (await evaluate('!!(window.browserApi && document.readyState === "complete")').catch(() => false)) break; await delay(500) }
  return { evaluate, quit: async () => { await evaluate('window.browserApi.diagnostics.e2eQuit()').catch(() => undefined); for (let i = 0; i < 80 && !exited; i++) await delay(250) } }
}

/** A window from a kernel's chrome.exe: its own user data folder, remote debugging on. */
async function openWindow(chrome, name, url) {
  const port = await freePort()
  const ud = join(folder, `win-${name}`)
  const child = spawn(chrome, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--window-size=900,600', url], { stdio: 'ignore' })
  let page
  for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page') } catch {} if (!page) await delay(500) }
  const browser = await cdp((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl)
  const tab = await cdp(page.webSocketDebuggerUrl)
  const evaluate = async (expression) => (await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value
  const close = async () => {
    await browser.send('Browser.close').catch(() => undefined)
    for (let i = 0; i < 40 && child.exitCode === null; i++) await delay(250)
    if (child.exitCode === null) { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {} }
  }
  return { child, browser, tab, evaluate, close, ud }
}

// The pages the windows show; the download is a real file over https (Chrome cancels plain-http ones).
const BIG = 'https://github.com/zhangchedan000/prism-kernel-releases/releases/download/prism22/ungoogled-chromium_156.0.8078.47-prism22_windows_x64.zip'
const http = createHttp((req, res) => {
  res.setHeader('content-type', 'text/html')
  if (req.url === '/next') { res.end('<title>next page</title>next'); return }
  res.end('<title>running</title><script>window.ticks=0;setInterval(()=>window.ticks++,100)</script>page')
})
await new Promise((r) => http.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${http.address().port}`

mkdirSync(join(userData, 'vault', 'kernels'), { recursive: true })
const robocopy = (from, to) => { try { execFileSync('robocopy', [from, to, '/E', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' }) } catch (e) { if (e.status >= 8) throw e } }
robocopy(kernelSource, kernel)
// The shared fonts, copied (not downloaded again); the old build gets its link to them, as the launcher gives it.
const fontStore = join(userData, 'vault', 'kernel-fonts')
robocopy(join(kernelSource, '..', '..', 'kernel-fonts'), fontStore)
const manifest = () => JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'))
const oldExe = join(kernel, manifest().executableRelative)
execFileSync('cmd', ['/c', 'mklink', '/J', join(kernel, 'browser', 'prism-system-fonts'), join(fontStore, 'v1')], { stdio: 'ignore' })
log('1 copied', id, manifest().releaseTag, '| layout:', readdirSync(kernel).sort().join(', '))

// 1. A window on the installed build, downloading.
const old = await openWindow(oldExe, 'old', `${base}/page`)
const downloads = join(folder, 'downloads')
mkdirSync(downloads, { recursive: true })
await old.browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true })
await old.evaluate(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(BIG)}; document.body.appendChild(a); a.click() })()`)
await delay(3000)
const progress = () => [...old.browser.events].reverse().find((e) => e.method === 'Browser.downloadProgress')?.params
log('1 window from', manifest().executableRelative, '| ticks', await old.evaluate('window.ticks'), '| download:', JSON.stringify(progress() ? { state: progress().state, received: progress().receivedBytes, total: progress().totalBytes } : null))

// 2. Install another build while it runs.
let app = await launcher()
const rows = await app.evaluate('window.browserApi.engine.releases().then((r) => r.map((x) => ({ version: x.version, tag: x.tag, installed: !!x.installed, history: !!x.history })))').catch((e) => ({ error: e.message }))
const other = Array.isArray(rows) ? rows.find((x) => x.version === id && x.history && !x.installed) : undefined
const started = Date.now()
const result = await app.evaluate(`window.browserApi.engine.install(${JSON.stringify(id)}, ${JSON.stringify(other?.tag)}).then(() => 'ok', (e) => 'error: ' + e.message)`)
log('2 download while installing:', JSON.stringify(progress() ? { state: progress().state, received: progress().receivedBytes } : null))
log('2 install', other?.tag, ':', result, `${Math.round((Date.now() - started) / 1000)} s`, '| layout:', readdirSync(kernel).sort().join(', '))
const status = await app.evaluate(`window.browserApi.engine.verify(${JSON.stringify(id)}).then((h) => h.status)`).catch((e) => e.message)
const newExe = join(kernel, manifest().executableRelative)
log('2 new windows get:', manifest().executableRelative, manifest().releaseTag, '| verify:', status)
const fresh = await openWindow(newExe, 'new', `${base}/next`)
log('2 window from the new build:', await fresh.evaluate('document.title'), '| process', fresh.child.pid)
await fresh.close()
await app.quit()

// 3. The running window.
let done
for (let i = 0; i < 150 && !done; i++) {
  done = old.browser.events.find((e) => e.method === 'Browser.downloadProgress' && (e.params.state === 'completed' || e.params.state === 'canceled'))
  if (!done) await delay(1000)
}
const file = join(downloads, basename(new URL(BIG).pathname))
log('3 download:', done?.params.state ?? 'not finished', '| file', existsSync(file) ? `${statSync(file).size} bytes (want ${done?.params.totalBytes})` : 'missing')
log('3 running window still works: ticks', await old.evaluate('window.ticks'))
await old.tab.send('Page.navigate', { url: `${base}/next` })
await delay(1500)
log('3 running window opens a new page:', await old.evaluate('document.title'))
log('3 old build still there while the window runs:', existsSync(oldExe))
await old.close()
await delay(1500)

// 4. Closed: started again, the old build goes.
app = await launcher()
await app.evaluate('window.browserApi.engine.installed().then(() => true)').catch(() => false)
log('4 after closing the window and restarting, layout:', readdirSync(kernel).sort().join(', '))
await app.quit()
http.close()
log('DONE')
process.exit(0)
