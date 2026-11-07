// Windows, a test launcher on a test folder (the user's launcher, windows and kernels are not touched):
// a kernel update while another program works in the installed kernel's folder (what an input method's
// background service does). Before 0.5.76 that failed (the folder could not be renamed); now the new build
// goes into its own folder, the update succeeds, the old build stays while in use and goes once it is free.
//   1. The installed 156 kernel (old layout, browser\chrome.exe) is copied into the test vault.
//   2. A program (cmd.exe) is started working in its browser folder and kept running.
//   3. The test launcher installs an older build of it (历史版本), then updates to the newest: both must
//      succeed; the manifest points to build-…\browser; the old browser folder is still there (in use), the
//      build the update replaced is gone; the kernel checks out (engine.verify).
//   4. The program is ended, the launcher started again: the old browser folder is gone.
// node kernel-update-win.mjs <launcher exe> <installed kernel folder> <test folder>   Output: <test folder>\kernel-update.log
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'

const [exe, kernelSource, folder] = process.argv.slice(2)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(folder, { recursive: true })
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; console.log(line); appendFileSync(join(folder, 'kernel-update.log'), line + '\n') }
const userData = join(folder, 'ud')
const id = basename(kernelSource)
const kernel = join(userData, 'vault', 'kernels', id)

async function start() {
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
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++seq; pend.set(n, (m) => resolve(m.result)); s.send(JSON.stringify({ id: n, method, params })) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'error'); return r?.result?.value }
  for (let i = 0; i < 120; i++) { if (await evaluate('!!(window.browserApi && document.readyState === "complete")').catch(() => false)) break; await delay(500) }
  const quit = async () => {
    await evaluate('window.browserApi.diagnostics.e2eQuit()').catch(() => undefined)
    for (let i = 0; i < 80 && !exited; i++) await delay(250)
  }
  return { evaluate, quit }
}

const listing = () => readdirSync(kernel).sort().join(', ')
const manifest = () => JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'))

rmSync(userData, { recursive: true, force: true })
mkdirSync(join(userData, 'vault', 'kernels'), { recursive: true })
try { execFileSync('robocopy', [kernelSource, kernel, '/E', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' }) } catch (e) { if (e.status >= 8) throw e }
log('1 copied', id, 'layout:', listing(), 'exe:', manifest().executableRelative)

// 2. Something works in the kernel's browser folder (as an input method's service would).
const holder = spawn('ping.exe', ['-n', '1200', '127.0.0.1'], { cwd: join(kernel, 'browser'), stdio: 'ignore', detached: true, windowsHide: true })
await delay(1000)
let renamable = true
try { execFileSync('cmd', ['/c', 'ren', kernel, `${id}.probe`], { stdio: 'ignore' }) } catch { renamable = false }
if (renamable) execFileSync('cmd', ['/c', 'ren', join(userData, 'vault', 'kernels', `${id}.probe`), id], { stdio: 'ignore' })
log('2 holder pid', holder.pid, 'working in browser; kernel folder renamable:', renamable)

// 3. An older build (历史版本), then the newest.
let app = await start()
const rows = await app.evaluate('window.browserApi.engine.releases().then((r) => r.map((x) => ({ version: x.version, tag: x.tag, update: !!x.update, installed: !!x.installed, history: !!x.history })))').catch((e) => ({ error: e.message }))
log('3 releases:', JSON.stringify(rows))
const older = Array.isArray(rows) ? rows.find((x) => x.version === id && x.history && !x.installed) : undefined
for (const [label, tag] of [['older build ' + (older?.tag ?? '?'), older?.tag], ['newest', undefined]]) {
  if (label.startsWith('older') && !tag) { log('3 no older build listed'); continue }
  const started = Date.now()
  const result = await app.evaluate(`window.browserApi.engine.install(${JSON.stringify(id)}${tag ? `, ${JSON.stringify(tag)}` : ''}).then(() => 'ok', (e) => 'error: ' + e.message)`)
  log('3', label, 'install:', result, `${Math.round((Date.now() - started) / 1000)} s`)
  log('3   layout:', listing(), '| exe:', manifest().executableRelative, '| releaseTag:', manifest().releaseTag)
  log('3   verify:', JSON.stringify(await app.evaluate(`window.browserApi.engine.verify(${JSON.stringify(id)}).then((h) => ({ status: h.status, message: h.message }))`).catch((e) => e.message)))
}
log('3 old browser folder still there (in use):', existsSync(join(kernel, 'browser')))
await app.quit()

// 4. Free it and start again.
try { execFileSync('taskkill', ['/F', '/T', '/PID', String(holder.pid)], { stdio: 'ignore' }) } catch {}
await delay(1500)
app = await start()
await app.evaluate('window.browserApi.engine.installed().then(() => true)').catch(() => false)
log('4 after restart, layout:', listing())
await app.quit()
log('DONE')
process.exit(0)
