#!/usr/bin/env node
/**
 * A saved window's settings never change on their own, only when changed by hand:
 *  1. on save, everything that followed something (system language, voices, device names, media
 *     devices, 网络加速, a not-yet-checked 基于 IP 生成 country) is written into the window;
 *  2. the same after the launcher restarts;
 *  3. the same after the window goes to the recycle bin and comes back;
 *  4. turning 网络加速 off on the library proxy leaves the window's own;
 *  5. changing the country by hand in the editor moves everything under it to the new country
 *     (language, system language, voices, device names, time zone), even what was chosen on its
 *     own; cancelling leaves the window as saved.
 *
 *   npm run build && node tools/app-e2e/saved-fingerprint.mjs        (Linux: xvfb-run -a …)
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const userData = await mkdtemp(join(tmpdir(), 'prism-saved-fingerprint-'))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message); console.log(ok ? '  ok  ' : '  FAIL', message) }

const windowsFingerprint = (patch) => ({ platform: 'windows', hardwareProfileId: 'windows-11-rtx4070', platformVersion: '19.0.0', ...patch })
/** What a window is, without what changes while it is used (times, checks, run state). */
const settingsOf = (profile) => ({
  name: profile.name,
  kernelVersion: profile.kernelVersion,
  proxyId: profile.proxyId,
  proxy: { protocol: profile.proxy.protocol, host: profile.proxy.host, port: profile.proxy.port },
  tunnel: profile.tunnel ?? null,
  window: profile.window,
  fingerprint: profile.fingerprint
})
/** JSON with keys sorted, so the same values compare equal whatever order they were stored in. */
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
  : item)
const snapshot = async (run) => Object.fromEntries((await run('window.browserApi.profiles.list()'))
  .map((profile) => [profile.name, canonical(settingsOf(profile))]))
const same = (before, after, label) => {
  for (const name of Object.keys(before)) {
    if (before[name] !== after[name]) {
      check(false, `${label}: ${name} changed`)
      const a = JSON.parse(before[name]); const b = JSON.parse(after[name] ?? '{}')
      for (const key of new Set([...Object.keys(a.fingerprint ?? {}), ...Object.keys(b.fingerprint ?? {})])) {
        if (JSON.stringify(a.fingerprint?.[key]) !== JSON.stringify(b.fingerprint?.[key])) console.log(`        fingerprint.${key}: ${JSON.stringify(a.fingerprint?.[key])} → ${JSON.stringify(b.fingerprint?.[key])}`)
      }
      for (const key of ['name', 'kernelVersion', 'proxyId', 'proxy', 'tunnel', 'window']) {
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) console.log(`        ${key}: ${JSON.stringify(a[key])} → ${JSON.stringify(b[key])}`)
      }
      return
    }
  }
  check(true, `${label}: all ${Object.keys(before).length} windows unchanged`)
}

let instance = await launchApp({ app }, userData)
try {
  let run = (expression) => evaluate(instance.client, expression)
  const route = { enabled: true, mode: 'manual', node: '手动节点 · US-vless' }
  const proxyId = await run(`window.browserApi.proxy.create({ protocol: 'socks5', host: '198.51.100.31', port: 1080, username: 'a', password: 'b', note: '库代理', tunnel: ${JSON.stringify(route)} }).then((proxy) => proxy.id)`)
  const windows = [
    { ...draft('德国手动', 401, 'https://example.com/'), fingerprint: { ...draft('', 401, '').fingerprint, ...windowsFingerprint({ networkIdentityMode: 'manual', region: 'DE', timezone: 'Europe/Berlin', language: 'de-DE', acceptLanguages: 'de-DE,de' }) } },
    { ...draft('代理库窗口', 402, 'https://example.com/'), proxyId, fingerprint: { ...draft('', 402, '').fingerprint, ...windowsFingerprint({ networkIdentityMode: 'manual', region: 'MX', timezone: 'America/Mexico_City', language: 'es-MX', acceptLanguages: 'es-MX,es' }) } },
    { ...draft('基于IP未检测', 403, 'https://example.com/'), proxy: { protocol: 'socks5', host: '198.51.100.32', port: 1080, username: 'a', password: 'b' }, fingerprint: { ...draft('', 403, '').fingerprint, ...windowsFingerprint({ networkIdentityMode: 'proxy' }) } },
    { ...draft('语音单独选', 404, 'https://example.com/'), fingerprint: { ...draft('', 404, '').fingerprint, ...windowsFingerprint({ networkIdentityMode: 'manual', region: 'US', timezone: 'America/New_York', language: 'en-US', acceptLanguages: 'en-US,en', voicesLocale: 'en-gb' }) } }
  ]
  for (const value of windows) {
    await run(`window.browserApi.profiles.create(${JSON.stringify(value)}).then(() => true)`).catch((error) => failures.push(`create ${value.name}: ${error.message}`))
  }
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)

  console.log('1. written in on save')
  const saved = Object.fromEntries((await run('window.browserApi.profiles.list()')).map((profile) => [profile.name, profile]))
  for (const name of Object.keys(saved)) {
    const fp = saved[name].fingerprint
    check(['uiLocale', 'voicesLocale', 'mediaLocale', 'mediaDevices'].every((key) => typeof fp[key] === 'string' && fp[key]),
      `${name}: system language ${fp.uiLocale}, voices ${fp.voicesLocale}, device names ${fp.mediaLocale}, media devices ${fp.mediaDevices} stored`)
    check(fp.networkIdentityMode === 'manual', `${name}: country fixed (${fp.region} · ${fp.timezone} · ${fp.language})`)
  }
  check(saved['语音单独选'].fingerprint.voicesLocale === 'en-gb', '语音单独选: the voices chosen on their own kept (en-gb)')
  check(JSON.stringify(saved['代理库窗口'].tunnel) === JSON.stringify(route), `代理库窗口: 网络加速 taken from the proxy and stored (${JSON.stringify(saved['代理库窗口'].tunnel)})`)
  const file = JSON.parse(await readFile(join(userData, 'vault', 'profiles.json'), 'utf8').catch(() => '{}'))
  const stored = (file.profiles ?? []).find((profile) => profile.name === '德国手动')
  check(Boolean(stored?.fingerprint?.voicesLocale && stored?.fingerprint?.mediaLocale && stored?.fingerprint?.uiLocale), `德国手动: written in the saved file itself (vault/profiles.json: ${stored ? 'found' : 'not found'})`)
  const before = await snapshot(run)

  console.log('2. launcher restarted')
  await quitApp(instance)
  instance = await launchApp({ app }, userData)
  run = (expression) => evaluate(instance.client, expression)
  same(before, await snapshot(run), 'after restart')

  console.log('3. recycle bin and back')
  const germanId = saved['德国手动'].id
  await run(`window.browserApi.profiles.remove(${JSON.stringify(germanId)}).then(() => true)`)
  const trash = await run('window.browserApi.profiles.trash()')
  const entry = trash.find((item) => (item.profile?.name ?? item.name) === '德国手动')
  check(Boolean(entry), 'in the recycle bin')
  if (entry) await run(`window.browserApi.profiles.restore(${JSON.stringify(entry.trashId ?? entry.id)}).then(() => true)`)
  same(before, await snapshot(run), 'after restore')

  console.log('4. 网络加速 turned off on the library proxy')
  await run(`window.browserApi.proxy.update(${JSON.stringify(proxyId)}, { protocol: 'socks5', host: '198.51.100.31', port: 1080, username: 'a', password: '', note: '库代理', tunnel: { enabled: false, mode: 'auto' } }).then(() => true)`)
  const proxyNow = (await run('window.browserApi.proxy.list()')).find((proxy) => proxy.id === proxyId)
  check(proxyNow?.tunnel?.enabled === false, 'the proxy itself now has it off')
  same(before, await snapshot(run), 'windows after the proxy change')

  console.log('5. country changed by hand in the editor, then cancelled')
  await run('location.reload(), true')
  await delay(2500)
  const drawer = `document.querySelector('.ant-drawer-open')`
  const rowText = (label) => run(`(() => {
    const row = [...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim() === ${JSON.stringify(label)})
    return row ? row.querySelector('.fb-form-control')?.innerText.split('\\n')[0] ?? '' : 'no row'
  })()`)
  const opened = await run(`(() => {
    const row = [...document.querySelectorAll('tr')].find((node) => node.innerText.includes('语音单独选'))
    const button = row && [...row.querySelectorAll('button')].find((node) => node.innerText.trim() === '编辑')
    if (!button) return false
    button.click()
    return true
  })()`)
  check(opened, 'editor opened')
  await delay(900)
  await run(`(() => { [...${drawer}.querySelectorAll('.ant-tabs-tab')].find((node) => node.innerText.trim() === '指纹设置')?.click(); return true })()`)
  await delay(600)
  const shownBefore = { system: await rowText('系统语言'), voices: await rowText('语音'), timezone: await rowText('时区') }
  console.log('     before:', JSON.stringify(shownBefore))
  await run(`(() => {
    const row = [...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim() === '国家/地区')
    row.querySelector('.ant-select').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return true
  })()`)
  await delay(400)
  await run(`(() => {
    const input = document.querySelector('.ant-select-focused input, .ant-select-open input') ?? [...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim() === '国家/地区').querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '法国')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await delay(600)
  const picked = await run(`(() => {
    const option = [...document.querySelectorAll('.ant-select-item-option')].find((node) => node.innerText.trim().startsWith('法国'))
    if (!option) return [...document.querySelectorAll('.ant-select-item-option')].slice(0, 5).map((node) => node.innerText).join(' / ') || 'no options'
    option.click()
    return 'picked'
  })()`)
  check(picked === 'picked', `picked 法国 (${picked})`)
  await delay(800)
  const shownAfter = { system: await rowText('系统语言'), voices: await rowText('语音'), timezone: await rowText('时区') }
  console.log('     after: ', JSON.stringify(shownAfter))
  check(/fr-FR|Français|français|法语/.test(shownAfter.system), 'system language followed the country (still 跟随)')
  check(/Europe\/Paris/.test(shownAfter.timezone), 'time zone followed the country')
  check(/fr-fr/i.test(shownAfter.voices), 'voices chosen on their own (en-gb) moved to the new country too (fr-fr)')
  await run(`(() => { [...${drawer}.querySelectorAll('button')].find((node) => node.innerText.replace(/\\s/g, '') === '取消')?.click(); return true })()`)
  await delay(800)
  same(before, await snapshot(run), 'after cancelling the edit')
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join('\n')}`); process.exit(1) }
console.log('\nsaved windows only change by hand')
