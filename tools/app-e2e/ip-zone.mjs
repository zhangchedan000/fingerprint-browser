#!/usr/bin/env node
/**
 * A fixed window whose new IP is in its own country but another time zone (a user's API window:
 * made with a Texas IP, Central time; its new IP is in Kennewick, WA, Pacific time). The 时区 row
 * points it out, 改成和 IP 一致 sets the IP's zone and position (country and languages stay), and
 * the saved window keeps them.
 *
 *   npm run build && node tools/app-e2e/ip-zone.mjs [folder]   (Linux: xvfb-run -a …)
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const folder = resolve(process.argv[2] ?? 'ui-shots')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const failures = []
const check = (ok, message) => { console.log(ok ? 'ok  ' : 'FAIL', message); if (!ok) failures.push(message) }

await mkdir(folder, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), 'prism-ip-zone-'))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const name = 'IP 时区窗口'

let instance = await launchApp({ app }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  const value = draft(name, 4242, 'https://example.com/')
  value.proxy = { protocol: 'http', host: '198.51.100.40', port: 8000, username: '', password: '' }
  value.fingerprint = {
    ...value.fingerprint, platform: 'windows', hardwareProfileId: 'windows-host', platformVersion: '10.0.0',
    networkIdentityMode: 'manual', region: 'US', regionSource: 'ip', timezone: 'America/Chicago', language: 'en-US',
    acceptLanguages: 'en-US,en', location: { latitude: 32.73, longitude: -97.32, accuracyMeters: 25000 }
  }
  await run(`window.browserApi.profiles.create(${JSON.stringify(value)}).then(() => true)`)
} finally {
  await quitApp(instance)
}

// The proxy's latest check: the new IP, in Washington.
const file = join(userData, 'vault', 'profiles.json')
const stored = JSON.parse(await readFile(file, 'utf8'))
const exit = {
  ok: true, latencyMs: 120, ip: '47.6.202.29', countryCode: 'US', country: 'United States', timezone: 'America/Los_Angeles',
  latitude: 46.21, longitude: -119.16, accuracyMeters: 25000, geoConfidence: 'consensus', checkedAt: new Date().toISOString()
}
for (const profile of stored.profiles) if (profile.name === name) profile.proxyCheck = exit
for (const proxy of stored.proxies ?? []) if (proxy.host === '198.51.100.40') proxy.check = exit
await writeFile(file, JSON.stringify(stored))

instance = await launchApp({ app }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  await run('location.reload(), true')
  await delay(2500)
  const opened = await run(`(() => {
    const row = [...document.querySelectorAll('tr')].find((node) => node.innerText.includes(${JSON.stringify(name)}))
    const button = row && [...row.querySelectorAll('button')].find((node) => node.innerText.trim() === '编辑')
    if (!button) return false
    button.click()
    return true
  })()`)
  check(opened, 'the window opens in the editor')
  await delay(1200)
  await run(`(() => { [...document.querySelectorAll('.ant-drawer-open .ant-tabs-tab')].find((node) => node.innerText.trim() === '指纹设置')?.click(); return true })()`)
  await delay(800)
  const rowText = (label) => run(`(() => {
    const found = [...document.querySelectorAll('.ant-drawer-open .fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim().startsWith(${JSON.stringify(label)}))
    if (!found) return 'no row'
    found.scrollIntoView({ block: 'center' })
    return found.innerText.replace(/\\s+/g, ' ').trim()
  })()`)
  const zone = await rowText('时区')
  console.log(`时区: ${zone}`)
  check(zone.includes('代理 IP 的时区是') && zone.includes('America/Los_Angeles') && zone.includes('America/Chicago'), 'the 时区 row names the IP zone and the window zone')
  check(zone.includes('改成和 IP 一致'), 'the 时区 row offers 改成和 IP 一致')
  await delay(400)
  let shot = await instance.client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(folder, 'ip-zone-before.png'), Buffer.from(shot.data, 'base64'))

  const clicked = await run(`(() => {
    const row = [...document.querySelectorAll('.ant-drawer-open .fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim().startsWith('时区'))
    // The row's 一键修正 button (its title names the change).
    const button = row && [...row.querySelectorAll('button.fb-inbox-fix')].find((node) => node.title === '改成和 IP 一致')
    if (!button) return false
    button.click()
    return true
  })()`)
  check(clicked, 'the fix can be clicked')
  await delay(700)
  const after = await rowText('时区')
  const place = await rowText('地理位置')
  const region = await rowText('国家/地区')
  const language = await rowText('浏览器语言')
  console.log(`时区 after: ${after}\n地理位置 after: ${place}\n国家/地区: ${region}\n浏览器语言: ${language}`)
  check(after.includes('America/Los_Angeles') && !after.includes('代理 IP 的时区是'), 'the zone is now the IP zone and the warning is gone')
  check(place.includes('46.21, -119.16'), 'the position is now the IP position')
  check(region.includes('美国'), 'the country stays')
  check(language.includes('en-US'), 'the browser language stays')
  shot = await instance.client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(folder, 'ip-zone-after.png'), Buffer.from(shot.data, 'base64'))

  await run(`(() => { [...document.querySelectorAll('.ant-drawer-open button')].find((node) => node.innerText.replace(/\\s/g, '') === '保存修改')?.click(); return true })()`)
  await delay(1500)
  const saved = await run(`window.browserApi.profiles.list().then((list) => { const p = list.find((item) => item.name === ${JSON.stringify(name)}); return p && { timezone: p.fingerprint.timezone, location: p.fingerprint.location, region: p.fingerprint.region, language: p.fingerprint.language } })`)
  console.log('saved', JSON.stringify(saved))
  check(saved?.timezone === 'America/Los_Angeles' && saved.location?.latitude === 46.21 && saved.region === 'US' && saved.language === 'en-US', 'the saved window keeps the IP zone and position, country and language')
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('IP ZONE OK')
