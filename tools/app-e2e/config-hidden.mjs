#!/usr/bin/env node
/**
 * Windows, real prism17 kernel: a window opened by the launcher shows no fingerprint switch in any
 * of its processes' command lines, the encrypted file is gone once it runs, and the page reads the
 * same fingerprint as with plain switches (PRISM_PLAIN_FINGERPRINT_ARGS=1).
 *
 *   npx electron-vite build
 *   set PRISM_CONFIG_KEY=<the kernel's key, 64 hex>
 *   node tools/app-e2e/config-hidden.mjs --browser E:\156\...\out\Default\chrome.exe --data E:\prism-work\fonts\ud\launcher-test --out result.json
 *
 * Everything lives under --data (a throwaway launcher data folder) and is removed at the end.
 * --fonts <folder>: the kernel font package already on this computer (prism-system-fonts with win10 /
 * win11), linked in as the data folder's kernel-fonts\v1 so nothing is downloaded. Only the links
 * are removed afterwards, never the fonts.
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp } from './run.mjs'

const argv = process.argv.slice(2)
const arg = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
const browser = resolve(arg('--browser') ?? '')
const data = resolve(arg('--data') ?? '')
const out = arg('--out')
const fonts = arg('--fonts') ? resolve(arg('--fonts')) : undefined
// The launcher only takes Prism kernels installed under kernels\prism-<version>: the build folder is
// linked in as one (browser\ -> out\Default) with a manifest saying what it can do.
const kernelName = arg('--kernel-name') ?? 'prism-156.0.8078.47'
if (!arg('--browser') || !arg('--data')) throw new Error('--browser and --data are required')
if (!/^[0-9a-f]{64}$/i.test(process.env.PRISM_CONFIG_KEY ?? '')) throw new Error('PRISM_CONFIG_KEY is not set')
const app = resolve('node_modules/electron/dist/electron.exe')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

const page = `<!doctype html><meta charset="utf-8"><body><canvas id=c width=200 height=50></canvas><script>
(async () => {
  const c = document.getElementById('c').getContext('2d'); c.font = '18px Arial'; c.fillText('prism 测试 😀', 4, 30)
  const gl = document.createElement('canvas').getContext('webgl'); const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
  const ua = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'fullVersionList']) : null
  const R = {
    ua: navigator.userAgent, uaPlatformVersion: ua && ua.platformVersion, brands: ua && ua.fullVersionList.map((b) => b.brand + ' ' + b.version).join(', '),
    language: navigator.language, languages: navigator.languages.join(','), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, screen: [screen.width, screen.height, screen.availHeight, devicePixelRatio].join('x'),
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '', canvas: document.getElementById('c').toDataURL().slice(-80),
    fonts: ['Segoe UI Variable', 'Microsoft YaHei', 'Yu Gothic', 'Cascadia Code'].map((f) => f + ':' + document.fonts.check('12px "' + f + '"')).join(',')
  }
  await fetch('/result', { method: 'POST', body: JSON.stringify(R) })
})()</script>`
let deliver
const server = createServer((request, response) => {
  if (request.method === 'POST') { let body = ''; request.on('data', (d) => { body += d }); request.on('end', () => { deliver?.(JSON.parse(body)); response.end('ok') }); return }
  response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(page)
}).listen(0, '127.0.0.1')
await new Promise((done) => server.on('listening', done))
const site = `http://127.0.0.1:${server.address().port}/`

function processesOf(folder) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${folder.replace(/'/g, "''")}*' } | ForEach-Object { $_.CommandLine } | ConvertTo-Json -Compress`
  const text = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
  if (!text) return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function run(plain) {
  const appData = join(data, plain ? 'plain' : 'hidden')
  const vault = join(appData, 'vault')
  await rm(appData, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  if (fonts) {
    await mkdir(join(vault, 'kernel-fonts'), { recursive: true })
    await symlink(fonts, join(vault, 'kernel-fonts', 'v1'), 'junction')
  }
  const kernelRoot = join(vault, 'kernels', kernelName)
  await mkdir(kernelRoot, { recursive: true })
  await symlink(join(browser, '..'), join(kernelRoot, 'browser'), 'junction')
  await writeFile(join(kernelRoot, 'manifest.json'), JSON.stringify({
    executableRelative: 'browser/chrome.exe', releaseTag: `${kernelName.replace(/^prism-/, '')}-prism17`, hiddenConfig: true, builtInFonts: true, webrtcRelay: true, windowScreen: true
  }))
  await writeFile(join(vault, 'settings.json'), JSON.stringify({ browserExecutable: join(kernelRoot, 'browser', 'chrome.exe'), fingerprintKernel: true, enginePreference: 'auto', recycleRetentionDays: 0 }))
  // Local mode: the test talks to no team server.
  await writeFile(join(vault, 'team.json'), JSON.stringify({ schemaVersion: 1, server: 'https://team.invalid', token: '', links: {}, localMode: true, userId: 'e2e', role: 'owner', userName: 'e2e' }))
  if (plain) process.env.PRISM_PLAIN_FINGERPRINT_ARGS = '1'
  else delete process.env.PRISM_PLAIN_FINGERPRINT_ARGS
  const instance = await launchApp({ app, headed: true }, appData)
  try {
    const value = { ...draft('config-hidden', 424242, site), fingerprint: { ...draft('x', 424242, site).fingerprint, hardwareProfileId: 'windows-seeded-nvidia', timezone: 'Asia/Tokyo', language: 'ja-JP', acceptLanguages: 'ja-JP,ja,en-US,en' } }
    const profile = await evaluate(instance.client, `window.browserApi.profiles.create(${JSON.stringify(value)})`)
    const result = new Promise((done) => { deliver = done })
    await evaluate(instance.client, `window.browserApi.profiles.launch(${JSON.stringify(profile.id)}).then(() => true)`)
    const reading = await Promise.race([result, delay(60_000).then(() => ({ error: 'page timeout' }))])
    await delay(3000)
    const folder = join(vault, 'profiles', profile.id)
    const lines = processesOf(folder)
    const leaks = lines.flatMap((line) => [...line.matchAll(/--(fingerprint(?!-config)[\w-]*|timezone|disable-spoofing|accept-lang|force-device-scale-factor)(=\S*)?/g)].map((m) => m[1]))
    const browserLine = lines.find((line) => !line.includes('--type=')) ?? ''
    const configDir = join(vault, 'profiles', profile.id, 'runtime', 'config')
    const leftFiles = await readdir(configDir).catch(() => [])
    await evaluate(instance.client, `window.browserApi.profiles.close(${JSON.stringify(profile.id)}).then(() => true)`).catch(() => undefined)
    return {
      mode: plain ? 'plain' : 'hidden', processes: lines.length, leakedSwitches: [...new Set(leaks)],
      browserHasConfigSwitch: /--fingerprint-config(-data)?=/.test(browserLine), browserHasLang: /--lang=/.test(browserLine),
      childrenWithConfigData: lines.filter((line) => line.includes('--type=') && line.includes('--fingerprint-config-data=')).length,
      configFilesLeft: leftFiles.length, reading
    }
  } finally {
    await quitApp(instance).catch(() => undefined)
    await delay(2000)
    // Links only: the kernel's prism-system-fonts link and the store link, never what they point to.
    await rm(join(browser, '..', 'prism-system-fonts'), { force: true }).catch(() => undefined)
    if (fonts) await rm(join(vault, 'kernel-fonts', 'v1'), { force: true }).catch(() => undefined)
    await rm(join(vault, 'kernels', kernelName, 'browser'), { force: true }).catch(() => undefined)
  }
}

const hidden = await run(false)
const plain = await run(true)
const same = JSON.stringify(hidden.reading) === JSON.stringify(plain.reading)
const verdict = {
  hiddenLeaks: hidden.leakedSwitches, plainLeaks: plain.leakedSwitches.length, sameFingerprint: same,
  pass: hidden.processes > 1 && hidden.leakedSwitches.length === 0 && !hidden.browserHasLang && hidden.configFilesLeft === 0 && plain.leakedSwitches.length > 0 && same && !hidden.reading.error
}
const report = { verdict, hidden, plain }
if (out) await writeFile(out, JSON.stringify(report, null, 1))
console.log(JSON.stringify(verdict))
server.close()
await rm(data, { recursive: true, force: true }).catch(() => undefined)
process.exit(verdict.pass ? 0 : 1)
