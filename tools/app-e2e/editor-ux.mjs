#!/usr/bin/env node
/**
 * The window editor as a user meets it: a mismatch shows 一键修正 inside its box and fixing it
 * clears it; a platform fills its start page (Amazon and TikTok Shop by the site picked) without
 * replacing an address typed by hand; saved passwords come back as dots; a click beside the drawer
 * or Esc does not close it; a checked window shows its exit IP as a card. Screenshots go to the
 * folder given.
 *
 *   npm run build && node tools/app-e2e/editor-ux.mjs [folder]        (Linux: xvfb-run -a …)
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
const userData = await mkdtemp(join(tmpdir(), 'prism-editor-ux-'))
const version = 'prism-156.0.8078.47'
const kernel = join(userData, 'vault', 'kernels', version)
await mkdir(join(kernel, 'browser'), { recursive: true })
await writeFile(join(kernel, 'browser', 'chrome'), '#!/bin/sh\n', { mode: 0o755 })
await writeFile(join(kernel, 'manifest.json'), JSON.stringify({ version, executableRelative: 'browser/chrome', releaseTag: '156.0.8078.47-prism9', assetName: 'ungoogled-chromium_156.0.8078.47-prism9_windows_x64.zip', sha256: '0'.repeat(64), installedAt: new Date().toISOString(), windowScreen: true, webrtcRelay: true }))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'

// A saved window with a typed proxy and an account, both with passwords, and a check of its proxy.
let instance = await launchApp({ app }, userData)
let savedId
try {
  const run = (expression) => evaluate(instance.client, expression)
  const value = draft('已保存窗口', 700, 'https://example.com/')
  value.kernelVersion = version
  value.proxy = { protocol: 'socks5', host: '198.51.100.40', port: 1080, username: 'user01', password: 'proxy-secret-1' }
  value.account = { platform: 'Facebook', username: 'shop@example.com', password: 'account-secret-1' }
  savedId = await run(`window.browserApi.profiles.create(${JSON.stringify(value)}).then((profile) => profile.id)`)
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
} finally {
  await quitApp(instance)
}
const file = join(userData, 'vault', 'profiles.json')
const stored = JSON.parse(await readFile(file, 'utf8'))
for (const profile of stored.profiles) {
  if (profile.id === savedId) profile.directCheck = { ok: true, latencyMs: 286, ip: '203.0.113.25', countryCode: 'MX', country: 'Mexico', city: 'Mexico City', timezone: 'America/Mexico_City', udp: true, checkedAt: new Date(Date.now() - 600_000).toISOString() }
}
await writeFile(file, JSON.stringify(stored))

instance = await launchApp({ app }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 3000, deviceScaleFactor: 1, mobile: false })
  await delay(2500)
  const drawer = `document.querySelector('.ant-drawer-open')`
  const click = (text, scope = 'document') => run(`(() => {
    const target = [...(${scope}).querySelectorAll('button, [role="tab"], .ant-tabs-tab, label, .ant-radio-button-wrapper')].find((node) => node.innerText?.trim() === ${JSON.stringify(text)})
    if (!target) return false
    target.click()
    return true
  })()`)
  const row = (label) => `[...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.offsetParent && node.querySelector('.fb-form-label')?.innerText.trim().startsWith(${JSON.stringify(label)}))`
  const rowText = (label) => run(`(() => { const found = ${row(label)}; return found ? found.innerText.replace(/\\s+/g, ' ').trim() : 'no row' })()`)
  const choose = async (label, text, selector = '.ant-select') => {
    await run(`(() => { ${row(label)}.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
    await delay(300)
    if (await run(`(() => { const input = ${row(label)}.querySelector(${JSON.stringify(selector)} + ' input'); if (!input || input.readOnly) return false; input.focus(); return true })()`)) {
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
  const shot = async (name) => {
    await delay(600)
    const { data } = await instance.client.send('Page.captureScreenshot', { format: 'png', clip: { x: 720, y: 0, width: 720, height: 3000, scale: 1 } })
    await writeFile(join(folder, `${name}.png`), Buffer.from(data, 'base64'))
  }
  const tab = async (name) => { await click(name, drawer); await delay(500) }
  const urls = () => run(`${drawer}.querySelector('textarea#startUrlsText, textarea[id$="startUrlsText"]')?.value ?? [...${drawer}.querySelectorAll('textarea')].find((area) => area.placeholder.startsWith('https://seller'))?.value`)

  // New window: platform → start page; Amazon and TikTok Shop by site.
  await click('新建窗口')
  await delay(900)
  const typePlatform = async (name) => {
    await run(`(() => { const input = ${row('平台账号')}.querySelector('input'); input.focus(); input.select(); return true })()`)
    await instance.client.send('Input.insertText', { text: name })
    await delay(400)
    await run(`(() => { const option = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((node) => node.innerText.trim() === ${JSON.stringify(name)}); option?.click(); return Boolean(option) })()`)
    await delay(400)
  }
  await typePlatform('TikTok Shop')
  check((await urls()) === 'https://seller-us.tiktok.com/', `TikTok Shop → ${await urls()}`)
  const mode = await run(`${row('启动页面')}.querySelector('.ant-radio-wrapper-checked')?.innerText.trim()`)
  check(mode === '打开上次关闭的页面', `a platform opens its page the first time, then the last session (${mode})`)
  await typePlatform('Meta Business')
  check((await urls()) === 'https://business.facebook.com/', `then Meta Business → ${await urls()}`)
  await typePlatform('Amazon Seller')
  check((await urls()) === 'https://sellercentral.amazon.com/', `then Amazon Seller → ${await urls()}`)
  await choose('启动页面', '日本', '.fb-site-select')
  check((await urls()) === 'https://sellercentral.amazon.co.jp/', `Amazon site 日本 → ${await urls()}`)
  await shot('1-basic-amazon-site')
  await run(`(() => { const area = [...${drawer}.querySelectorAll('textarea')].find((node) => node.value.includes('sellercentral')); area.focus(); area.select(); return true })()`)
  await instance.client.send('Input.insertText', { text: 'https://my-shop.example.com/' })
  await delay(300)
  await typePlatform('Facebook')
  check((await urls()) === 'https://my-shop.example.com/', `an address typed by hand stays → ${await urls()}`)

  // Esc and a click beside it leave the drawer open.
  await instance.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await delay(500)
  await run(`document.querySelector('.ant-drawer-mask')?.click(), true`)
  await delay(600)
  check(await run(`Boolean(document.querySelector('.ant-drawer-open'))`), 'Esc and a click beside it do not close the editor')

  // A mismatch: 一键修正 in the box, the reason under it; fixing clears it.
  await tab('指纹设置')
  await choose('操作系统', 'Windows')
  await choose('国家/地区', '墨西哥')
  await choose('浏览器语言', 'en-US')
  const fixShown = await run(`(() => { const r = ${row('浏览器语言')}; return Boolean(r?.classList.contains('has-fix') && r.querySelector('.fb-inbox-fix')) })()`)
  check(fixShown, `浏览器语言 en-US in 墨西哥: 一键修正 in the box · ${await rowText('浏览器语言')}`)
  const inBox = await run(`(() => { const r = ${row('浏览器语言')}; const box = r.querySelector('.ant-select').getBoundingClientRect(); const fix = r.querySelector('.fb-inbox-fix').getBoundingClientRect(); return fix.left > box.left && fix.right < box.right && fix.top > box.top && fix.bottom < box.bottom })()`)
  check(inBox, '一键修正 sits inside the box')
  const fixLeft = await run(`(() => ${row('浏览器语言')}.querySelector('.fb-inbox-fix').getBoundingClientRect().right)()`)
  await choose('时区', 'Asia/Tokyo')
  const zoneFixLeft = await run(`(() => ${row('时区')}.querySelector('.fb-inbox-fix')?.getBoundingClientRect().right)()`)
  check(Math.abs(zoneFixLeft - fixLeft) < 1, `一键修正 in the same place on every row (${zoneFixLeft} / ${fixLeft})`)
  const quiet = await run(`(() => !${row('系统语言')}.querySelector('.fb-inbox-fix'))()`)
  check(quiet, 'a row that fits shows no 一键修正')
  await shot('2-fingerprint-fixes')
  await run(`(() => { ${row('浏览器语言')}.querySelector('.fb-inbox-fix').click(); return true })()`)
  await delay(500)
  check(await run(`(() => !${row('浏览器语言')}.querySelector('.fb-inbox-fix'))()`), `一键修正 clears it · ${await rowText('浏览器语言')}`)
  await shot('3-fingerprint-after-fix')
  await click('取 消', drawer) || await click('取消', drawer)
  await delay(800)

  // The saved window: passwords as dots, the exit IP as a card.
  await run(`(() => { const row = [...document.querySelectorAll('.ant-table-row')].find((node) => node.innerText.includes('已保存窗口')); row?.querySelector('a, .fb-name-link, button')?.click(); return Boolean(row) })()`)
  await delay(300)
  await run(`window.dispatchEvent(new CustomEvent('prism-e2e-noop')), true`)
  const opened = await run(`Boolean(document.querySelector('.ant-drawer-open'))`)
  if (!opened) {
    // Open the editor from the row's edit action.
    await run(`(() => { const row = [...document.querySelectorAll('.ant-table-row')].find((node) => node.innerText.includes('已保存窗口')); const edit = [...row.querySelectorAll('button, a')].find((node) => node.innerText.trim() === '编辑' || node.getAttribute('aria-label') === '编辑'); edit?.click(); return Boolean(edit) })()`)
    await delay(900)
  }
  check(await run(`Boolean(document.querySelector('.ant-drawer-open'))`), 'saved window editor opens')
  await delay(600)
  const account = await run(`(() => { const input = ${row('平台账号')}.querySelector('input[type="password"]'); return input ? input.value.length : -1 })()`)
  check(account === 'account-secret-1'.length, `account password comes back as dots (${account} characters)`)
  await tab('代理设置')
  const card = await run(`${drawer}.querySelector('.fb-ip-card')?.innerText.replace(/\\s+/g, ' ') ?? 'no card'`)
  check(card.includes('203.0.113.25') && card.includes('墨西哥'), `exit IP card: ${card}`)
  await shot('4-proxy-saved')
  // Unticked: closing the editor keeps nothing of that check.
  await run(`(() => { ${drawer}.querySelector('.fb-ip-mark.is-toggle')?.click(); return true })()`)
  await delay(300)
  const unticked = await run(`${drawer}.querySelector('.fb-ip-card')?.innerText.replace(/\\s+/g, ' ') ?? 'no card'`)
  check(unticked.includes('不保留'), `the tick comes off: ${unticked}`)
  await shot('4b-proxy-unticked')
  await click('取 消', drawer) || await click('取消', drawer)
  await delay(800)
  await run(`(() => { const row = [...document.querySelectorAll('.ant-table-row')].find((node) => node.innerText.includes('已保存窗口')); const edit = [...row.querySelectorAll('button, a')].find((node) => node.innerText.trim() === '编辑' || node.getAttribute('aria-label') === '编辑'); edit?.click(); return Boolean(edit) })()`)
  await delay(900)
  await tab('代理设置')
  const reopened = await run(`${drawer}.querySelector('.fb-ip-card') ? 'card' : (${drawer}.innerText.includes('还没检测') ? 'not checked' : 'other')`)
  check(reopened === 'not checked', `reopened, the window has no check left (${reopened})`)
  await click('取 消', drawer) || await click('取消', drawer)
  await delay(800)

  // The proxy it saved to the library: its password as dots in 编辑代理.
  await run(`(() => { const target = [...document.querySelectorAll('.fb-sidebar .fb-nav-item')].find((node) => node.innerText.trim().startsWith('代理 IP')); target?.click(); return Boolean(target) })()`)
  await delay(1200)
  await run(`(() => { const row = [...document.querySelectorAll('.ant-table-row')].find((node) => node.innerText.includes('198.51.100.40')); const edit = [...(row?.querySelectorAll('button, a') ?? [])].find((node) => node.innerText.trim() === '编辑'); edit?.click(); return Boolean(edit) })()`)
  await delay(1200)
  const proxyPassword = await run(`(() => { const input = document.querySelector('.ant-modal input[type="password"]'); return input ? input.value.length : -1 })()`)
  check(proxyPassword === 'proxy-secret-1'.length, `proxy password comes back as dots in 编辑代理 (${proxyPassword} characters)`)
  const { data } = await instance.client.send('Page.captureScreenshot', { format: 'png', clip: { x: 300, y: 0, width: 840, height: 1100, scale: 1 } })
  await writeFile(join(folder, '5-proxy-dialog.png'), Buffer.from(data, 'base64'))
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('editor works as described')
