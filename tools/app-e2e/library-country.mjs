#!/usr/bin/env node
/**
 * A new window picking a library proxy that was checked before takes that IP's country (time zone,
 * languages) without a check of its own, and still shows no check result; a country picked by hand
 * first stays, with the mismatch pointed out. The language rows say what they follow.
 *
 *   npm run build && node tools/app-e2e/library-country.mjs        (Linux: xvfb-run -a …)
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const userData = await mkdtemp(join(tmpdir(), 'prism-library-country-'))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const failures = []
const check = (ok, message) => { console.log(ok ? 'ok  ' : 'FAIL', message); if (!ok) failures.push(message) }

// First run: three library proxies; two get a check as the 代理 IP page would have saved it.
let instance = await launchApp({ app }, userData)
let ids
try {
  const run = (expression) => evaluate(instance.client, expression)
  ids = {}
  for (const [name, host] of [['mx', '198.51.100.31'], ['us', '198.51.100.32'], ['none', '198.51.100.33']]) {
    ids[name] = await run(`window.browserApi.proxy.create({ protocol: 'socks5', host: '${host}', port: 1080, username: 'a', password: 'b', note: '${name}' }).then((proxy) => proxy.id)`)
  }
} finally {
  await quitApp(instance)
}
const file = join(userData, 'vault', 'profiles.json')
const stored = JSON.parse(await readFile(file, 'utf8'))
const checkedAt = new Date(Date.now() - 3600_000).toISOString()
const result = (countryCode, country, timezone, latitude, longitude) => ({
  ok: true, latencyMs: 120, ip: '203.0.113.9', countryCode, country, timezone, latitude, longitude, checkedAt
})
for (const proxy of stored.proxies) {
  if (proxy.id === ids.mx) proxy.check = result('MX', 'Mexico', 'America/Mexico_City', 19.43, -99.13)
  if (proxy.id === ids.us) proxy.check = result('US', 'United States', 'America/Chicago', 41.88, -87.63)
}
await writeFile(file, JSON.stringify(stored))

instance = await launchApp({ app }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  await run('location.reload(), true')
  await delay(2500)
  const drawer = `document.querySelector('.ant-drawer-open')`
  const click = (text, scope = 'document') => run(`(() => {
    const target = [...(${scope}).querySelectorAll('button, [role="tab"], .ant-tabs-tab, label, .ant-radio-button-wrapper')].find((node) => node.innerText?.trim() === ${JSON.stringify(text)})
    if (!target) return false
    target.click()
    return true
  })()`)
  const row = (label) => `[...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim().startsWith(${JSON.stringify(label)}))`
  const rowText = (label) => run(`(() => { const found = ${row(label)}; return found ? found.innerText.replace(/\\s+/g, ' ').trim() : 'no row' })()`)
  const choose = async (label, text) => {
    await run(`(() => { ${row(label)}.querySelector('.ant-select').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
    await delay(300)
    // The list only draws the options in view: search for the one wanted.
    if (await run(`(() => { const input = ${row(label)}.querySelector('input'); if (!input || input.readOnly) return false; input.focus(); return true })()`)) {
      await instance.client.send('Input.insertText', { text })
    }
    await delay(500)
    const chosen = await run(`(() => {
      const option = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((node) => node.innerText.includes(${JSON.stringify(text)}))
      if (!option) return false
      option.click()
      return true
    })()`)
    await delay(500)
    if (!chosen) failures.push(`no option ${text} in ${label}`)
  }
  const tab = async (name) => { await click(name, drawer); await delay(500) }
  const openNew = async () => {
    if (!await click('新建窗口')) failures.push('新建窗口 not found')
    await delay(900)
  }
  const pickProxy = async (host) => {
    await tab('代理设置')
    await click('从代理库选择', drawer)
    await delay(300)
    await choose('选择代理', host)
  }
  const proxyCard = () => run(`${drawer}.innerText.replace(/\\s+/g, ' ')`)
  // The select's own line names the library proxy's last IP; a result of this window would show below 检测代理.
  const noResult = async () => { const text = await proxyCard(); return !text.slice(text.indexOf('检测代理')).includes('203.0.113.9') }

  // 1. Nothing picked by hand: the checked proxy's country fills the window.
  await openNew()
  await pickProxy('198.51.100.31')
  const mx = await rowText('时区和语言')
  check(mx.includes('基于 IP 生成') && mx.includes('墨西哥') && mx.includes('America/Mexico_City'), `墨西哥代理 → ${mx}`)
  check(await noResult(), 'no check result shown in this window')
  await tab('指纹设置')
  const region = await rowText('国家/地区')
  check(region.includes('按代理库上次检测的 IP 配好'), `country hint: ${region}`)
  const ui = await rowText('系统语言')
  check(ui.includes('墨西哥 · es-419'), `系统语言: ${ui}`)
  for (const label of ['语音', '媒体设备名']) {
    const text = await rowText(label)
    check(text.includes('墨西哥 · es-mx'), `${label}: ${text}`)
  }

  // 2. Another checked proxy: the country follows it.
  await pickProxy('198.51.100.32')
  const us = await rowText('时区和语言')
  check(us.includes('基于 IP 生成') && us.includes('美国') && us.includes('America/Chicago'), `美国代理 → ${us}`)

  // 3. A proxy never checked: the country stays, with a hint to check it.
  await pickProxy('198.51.100.33')
  const none = await rowText('时区和语言')
  check(none.includes('美国'), `未检测代理 → ${none}`)
  await tab('指纹设置')
  const noneHint = await rowText('国家/地区')
  check(noneHint.includes('这个代理还没检测，检测后按 IP 配'), `未检测代理 hint: ${noneHint}`)

  // 4. The system language picked on its own: the rows under it say they follow it.
  await choose('系统语言', 'Deutsch')
  const voices = await rowText('语音')
  check(voices.includes('跟随系统语言') && voices.includes('de-de'), `语音 after picking German system language: ${voices}`)
  await click('取 消', drawer) || await click('取消', drawer)
  await delay(800)

  // 5. A country picked by hand first stays; the mismatch is pointed out.
  await openNew()
  await tab('指纹设置')
  await choose('国家/地区', '日本')
  const manual = await rowText('系统语言')
  check(manual.includes('日本 · ja'), `手动日本 系统语言: ${manual}`)
  await pickProxy('198.51.100.31')
  const kept = await rowText('时区和语言')
  check(kept.includes('手动选择') && kept.includes('日本'), `手动日本 then 墨西哥代理 → ${kept}`)
  await tab('指纹设置')
  const alert = await run(`${drawer}.innerText.includes('代理 IP 在墨西哥，窗口是日本')`)
  check(alert, 'mismatch alert shown')
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('a library proxy\'s country fills a new window')
