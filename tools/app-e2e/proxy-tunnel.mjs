#!/usr/bin/env node
/**
 * 网络加速 follows the library proxy picked for a window: a proxy with it on turns the window's
 * switch on, one without leaves it off, and the window saves what the switch shows.
 *
 *   npm run build && node tools/app-e2e/proxy-tunnel.mjs        (Linux: xvfb-run -a …)
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const userData = await mkdtemp(join(tmpdir(), 'prism-proxy-tunnel-'))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const instance = await launchApp({ app }, userData)
const failures = []
try {
  const run = (expression) => evaluate(instance.client, expression)
  const fast = await run(`window.browserApi.proxy.create({ protocol: 'socks5', host: '198.51.100.21', port: 1080, username: 'a', password: 'b', note: '开了加速', tunnel: { enabled: true, mode: 'auto' } }).then((proxy) => proxy.id)`)
  await run(`window.browserApi.proxy.create({ protocol: 'socks5', host: '198.51.100.22', port: 1080, username: 'a', password: 'b', note: '没开加速' }).then(() => true)`)
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  await run('location.reload(), true')
  await delay(2500)
  const click = (text, scope = 'document') => run(`(() => {
    const target = [...(${scope}).querySelectorAll('button, [role="tab"], .ant-tabs-tab, label, .ant-radio-button-wrapper')].find((node) => node.innerText?.trim() === ${JSON.stringify(text)})
    if (!target) return false
    target.click()
    return true
  })()`)
  const drawer = `document.querySelector('.ant-drawer-open')`
  const pick = async (host) => {
    await run(`(() => {
      const row = [...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim().startsWith('选择代理'))
      const select = row.querySelector('.ant-select')
      select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      return true
    })()`)
    await delay(500)
    const chosen = await run(`(() => {
      const option = [...document.querySelectorAll('.ant-select-item-option')].find((node) => node.innerText.includes(${JSON.stringify(host)}))
      if (!option) return false
      option.click()
      return true
    })()`)
    await delay(500)
    if (!chosen) failures.push(`no option for ${host}`)
  }
  const switchOn = () => run(`(() => {
    const row = [...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim() === '网络加速')
    const toggle = row?.querySelector('.ant-switch')
    return toggle ? toggle.classList.contains('ant-switch-checked') : 'no switch'
  })()`)
  if (!await click('新建窗口')) failures.push('新建窗口 not found')
  await delay(900)
  await click('代理设置', drawer)
  await delay(400)
  if (!await click('从代理库选择', drawer)) failures.push('从代理库选择 not found')
  await delay(400)
  await pick('198.51.100.22')
  const offShown = await switchOn()
  console.log('proxy without 网络加速 → switch', offShown)
  if (offShown !== false) failures.push(`proxy without it: switch ${offShown}`)
  await pick('198.51.100.21')
  const onShown = await switchOn()
  console.log('proxy with 网络加速 → switch', onShown)
  if (onShown !== true) failures.push(`proxy with it: switch ${onShown}`)
  await click('确定创建', drawer)
  await delay(1500)
  const saved = await run(`window.browserApi.profiles.list().then((list) => list.map((profile) => ({ proxyId: profile.proxyId, tunnel: profile.tunnel ?? profile.proxy?.tunnel })))`)
  console.log('saved', JSON.stringify(saved))
  const window = saved.find((profile) => profile.proxyId === fast)
  if (!window?.tunnel?.enabled) failures.push(`saved window: ${JSON.stringify(window)}`)
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('网络加速 follows the picked proxy')
