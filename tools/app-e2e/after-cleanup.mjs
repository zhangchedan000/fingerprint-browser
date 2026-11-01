#!/usr/bin/env node
/**
 * After the 2026-11-02 GitHub cleanup: the released launcher (packaged v0.5.54) in a throwaway data
 * folder, with no kernel, downloads the kernel from GitHub like a user, opens windows and checks updates.
 *   node tools/app-e2e/after-cleanup.mjs --app <unpacked>\Fingerprint Browser.exe --data E:\prism-work\fonts\ud\after-cleanup
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp } from './run.mjs'

const argv = process.argv.slice(2)
const arg = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
const app = resolve(arg('--app') ?? '')
const data = resolve(arg('--data') ?? '')
if (!arg('--app') || !arg('--data')) throw new Error('--app and --data are required')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)

const page = `<!doctype html><meta charset="utf-8"><body><script>
fetch('/result', { method: 'POST', body: JSON.stringify({ ua: navigator.userAgent, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) })
</script>`
let deliver
const server = createServer((request, response) => {
  if (request.method === 'POST') { let body = ''; request.on('data', (d) => { body += d }); request.on('end', () => { deliver?.(JSON.parse(body)); response.end('ok') }); return }
  response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(page)
}).listen(0, '127.0.0.1')
await new Promise((done) => server.on('listening', done))
const site = `http://127.0.0.1:${server.address().port}/`

function browserLine(folder) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${folder.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1 | ForEach-Object { $_.CommandLine }`
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
}

const report = {}
const vault = join(data, 'vault')
await rm(data, { recursive: true, force: true })
await mkdir(vault, { recursive: true })
await writeFile(join(vault, 'team.json'), JSON.stringify({ schemaVersion: 1, server: 'https://team.invalid', token: '', links: {}, localMode: true, userId: 'e2e', role: 'owner', userName: 'e2e' }))
const instance = await launchApp({ app, packaged: true, headed: true }, data)
const call = (expr, ms = 120_000) => Promise.race([evaluate(instance.client, expr), delay(ms).then(() => { throw new Error(`timeout: ${expr.slice(0, 80)}`) })])
try {
  const info = await call('window.browserApi.app.info()')
  report.app = info?.version ?? info
  log('app', JSON.stringify(report.app))
  const update = await call('window.browserApi.app.checkUpdate()', 60_000).catch((e) => ({ error: String(e) }))
  report.updateCheck = update
  log('update check', JSON.stringify(update).slice(0, 300))
  const releases = await call('window.browserApi.engine.releases()', 60_000)
  report.kernelList = JSON.stringify(releases).match(/prism\d+|fonts-\d+/g)?.filter((v, i, a) => a.indexOf(v) === i)
  log('kernel list', JSON.stringify(report.kernelList))
  // Same call as 内核管理 → 在线下载内核: the newest 156 build in the list, by its version.
  const pick = releases.find((item) => /^156\./.test(item.chromium ?? item.version ?? '') && !item.history)
  report.picked = pick && { version: pick.version, tag: pick.tag }
  log('installing from GitHub', JSON.stringify(report.picked))
  const t0 = Date.now()
  const installed = await call(`window.browserApi.engine.install(${JSON.stringify(pick?.version ?? '')}).then((r) => JSON.parse(JSON.stringify(r ?? null)))`, 900_000)
  report.install = { seconds: Math.round((Date.now() - t0) / 1000), result: JSON.stringify(installed).slice(0, 300) }
  log('installed', report.install.seconds, 's')
  const status = await call('window.browserApi.engine.status().then((s) => JSON.parse(JSON.stringify(s)))')
  report.engine = JSON.stringify(status).slice(0, 400)
  log('engine', report.engine)

  // Window 1: an ordinary new window (device binding not set = off), opens the test page.
  const one = await call(`window.browserApi.profiles.create(${JSON.stringify(draft('after-cleanup-1', 515151, site))})`)
  const result = new Promise((done) => { deliver = done })
  await call(`window.browserApi.profiles.launch(${JSON.stringify(one.id)}).then(() => true)`, 600_000)
  report.page = await Promise.race([result, delay(90_000).then(() => ({ error: 'page timeout' }))])
  log('page', JSON.stringify(report.page))
  const line1 = browserLine(join(vault, 'profiles', one.id))
  report.windowOffDisablesBinding = /DeviceBoundSessions/.test(line1)
  await call(`window.browserApi.profiles.close(${JSON.stringify(one.id)}).then(() => true)`).catch(() => undefined)
  await delay(3000)

  // Window 2: a new window that has not chosen yet ('ask', what the app's editor creates) is refused until it chooses.
  const two = await call(`window.browserApi.profiles.create(${JSON.stringify({ ...draft('after-cleanup-2', 525252, site), fingerprint: { ...draft('x', 525252, site).fingerprint, deviceBinding: 'ask' } })})`)
  report.askRefused = await call(`window.browserApi.profiles.launch(${JSON.stringify(two.id)}).then(() => 'opened', (e) => String(e.message || e))`, 60_000)
  log('ask window', report.askRefused)
  await call(`window.browserApi.profiles.setDeviceBinding(${JSON.stringify(two.id)}, 'on').then(() => true)`)
  const result2 = new Promise((done) => { deliver = done })
  await call(`window.browserApi.profiles.launch(${JSON.stringify(two.id)}).then(() => true)`, 120_000)
  report.page2 = await Promise.race([result2, delay(60_000).then(() => ({ error: 'page timeout' }))])
  const line2 = browserLine(join(vault, 'profiles', two.id))
  report.windowOnKeepsBinding = line2 !== '' && !/DeviceBoundSessions/.test(line2) && !/SoftwareKeysForManualTesting/.test(line2)
  report.lockedAfterOpen = await call(`window.browserApi.profiles.setDeviceBinding(${JSON.stringify(two.id)}, 'off').then(() => 'changed', (e) => String(e.message || e))`)
  await call(`window.browserApi.profiles.close(${JSON.stringify(two.id)}).then(() => true)`).catch(() => undefined)
  await delay(3000)
} catch (error) {
  report.error = String(error?.stack ?? error)
} finally {
  await quitApp(instance).catch(() => undefined)
  server.close()
}
report.pass = report.picked?.tag === 'prism18' && !report.error && !report.page?.error && /Chrome\/156/.test(report.page?.ua ?? '') && report.windowOffDisablesBinding === true
  && /设备绑定/.test(report.askRefused ?? '') && report.windowOnKeepsBinding === true && /不能再改/.test(report.lockedAfterOpen ?? '')
console.log('REPORT ' + JSON.stringify(report))
await delay(2000)
await rm(data, { recursive: true, force: true }).catch(() => undefined)
process.exit(report.pass ? 0 : 1)
