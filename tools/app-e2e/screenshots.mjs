#!/usr/bin/env node
/**
 * Screenshots of every page of the real app (and the window editor's tabs) at a desktop size, for
 * looking over the UI after a change. Writes PNGs into the folder given (default ./ui-shots).
 *
 *   npm run build && node tools/app-e2e/screenshots.mjs [folder] [width] [height]   (Linux: xvfb-run -a …)
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const folder = resolve(process.argv[2] ?? 'ui-shots')
const width = Number(process.argv[3] ?? 1440)
const height = Number(process.argv[4] ?? 900)
const dark = process.argv[5] === 'dark'
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

await mkdir(folder, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), 'prism-ui-shots-'))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const instance = await launchApp({ app }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  const shot = async (name) => {
    await delay(700)
    const { data } = await instance.client.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(folder, `${name}.png`), Buffer.from(data, 'base64'))
    console.log('saved', name)
  }
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  for (let index = 1; index <= 6; index++) {
    const value = { ...draft(`示例窗口 ${index}`, 200 + index, 'https://example.com/'), group: index % 2 ? '电商' : '社媒' }
    if (index === 2) value.proxy = { protocol: 'socks5', host: '203.0.113.5', port: 1080, username: '', password: '' }
    await run(`window.browserApi.profiles.create(${JSON.stringify(value)}).then(() => true)`)
  }
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  await run('location.reload(), true')
  await delay(2500)
  const clickText = (text, selector = 'button, [role="tab"], .ant-tabs-tab, .ant-menu-item, a, li, span') => run(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.innerText?.trim() === ${JSON.stringify(text)})
    if (!target) return false
    target.click()
    return true
  })()`)
  const nav = (label) => run(`(() => {
    const target = [...document.querySelectorAll('.fb-sidebar .fb-nav-item')].find((node) => node.innerText.trim().startsWith(${JSON.stringify(label)}))
    if (!target) return false
    target.click()
    return true
  })()`)
  if (dark) {
    await nav('设置')
    await delay(500)
    await clickText('深色', 'label, .ant-radio-button-wrapper, span')
    await nav('窗口管理')
    await delay(500)
  }
  await shot('01-windows')
  const pages = [['分组管理', '02-groups'], ['代理 IP', '03-proxies'], ['团队', '04-team'], ['扩展中心', '05-extensions'], ['内核管理', '06-kernels'], ['回收站', '07-recycle'], ['设置', '08-settings']]
  for (const [label, name] of pages) {
    if (await nav(label)) await shot(name)
    else console.log('no menu entry', label)
  }
  await nav('窗口管理')
  await delay(800)
  if (await clickText('新建窗口', 'button')) {
    await delay(900)
    await shot('10-editor-basic')
    for (const [tab, name] of [['代理设置', '11-editor-proxy'], ['指纹设置', '12-editor-fingerprint']]) {
      await clickText(tab, '.ant-drawer-open [role="tab"], .ant-drawer-open .ant-tabs-tab')
      await shot(name)
    }
    await run(`(() => { const body = document.querySelector('.ant-drawer-open .ant-drawer-body'); if (body) body.scrollTop = body.scrollHeight / 2; return true })()`)
    await shot('13-editor-fingerprint-middle')
    await run(`(() => { const body = document.querySelector('.ant-drawer-open .ant-drawer-body'); if (body) body.scrollTop = body.scrollHeight; return true })()`)
    await shot('14-editor-fingerprint-end')
  }
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
