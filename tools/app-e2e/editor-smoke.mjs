#!/usr/bin/env node
/**
 * Opens the window editor of the real app for each kind of window (manual country, 基于 IP 生成,
 * API 提取, a window that has been opened) and goes through its tabs, failing when the page goes
 * blank or throws. Catches render errors that type checks cannot (a value used before it exists).
 *
 *   npm run build && node tools/app-e2e/editor-smoke.mjs        (on Linux: xvfb-run -a node …)
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

const userData = await mkdtemp(join(tmpdir(), 'prism-editor-smoke-'))
// No team server here: the app shows the UI as a signed-in user, offline (PRISM_E2E only).
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const instance = await launchApp({ app }, userData)
const failures = []
try {
  const run = (expression) => evaluate(instance.client, expression)
  // Windows of every kind the country row has to show.
  const kinds = {
    manual: draft('手动国家', 101, 'https://example.com/'),
    ip: { ...draft('基于 IP', 102, 'https://example.com/'), proxy: { protocol: 'socks5', host: '203.0.113.5', port: 1080, username: '', password: '' } },
    api: { ...draft('API 窗口', 103, 'https://example.com/'), proxy: { protocol: 'http', host: '', username: '', password: '', apiUrl: 'https://api.example.com/get?num=1' } }
  }
  kinds.ip.fingerprint = { ...kinds.ip.fingerprint, networkIdentityMode: 'proxy' }
  kinds.api.fingerprint = { ...kinds.api.fingerprint, networkIdentityMode: 'proxy', region: 'SG', regionSource: 'ip' }
  for (const [kind, value] of Object.entries(kinds)) {
    await run(`window.browserApi.profiles.create(${JSON.stringify(value)}).then(() => true)`).catch((error) => failures.push(`create ${kind}: ${error.message}`))
  }
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  await run('location.reload(), true')
  await delay(2500)
  await run(`window.__smokeErrors = []; window.addEventListener('error', (event) => window.__smokeErrors.push(String(event.message))); true`)

  const alive = () => run(`(() => { const root = document.querySelector('#root'); return Boolean(root && root.innerText.trim().length > 20) })()`)
  const clickText = (text, scope = 'document') => run(`(() => {
    const target = [...(${scope}).querySelectorAll('button, [role="tab"], .ant-tabs-tab')].find((node) => node.innerText.trim() === ${JSON.stringify(text)} && !node.disabled)
    if (!target) return false
    target.click()
    return true
  })()`)

  const editors = [
    ['新建窗口', `document`],
    ...Object.values(kinds).map((value) => [value.name, 'row'])
  ]
  for (const [name, where] of editors) {
    if (where === 'document') {
      if (!await clickText('新建窗口')) failures.push('新建窗口 button not found')
    } else {
      const opened = await run(`(() => {
        const row = [...document.querySelectorAll('tr')].find((node) => node.innerText.includes(${JSON.stringify(name)}))
        const button = row && [...row.querySelectorAll('button')].find((node) => node.innerText.trim() === '编辑')
        if (!button) return false
        button.click()
        return true
      })()`)
      if (!opened) { failures.push(`${name}: edit button not found`); continue }
    }
    await delay(800)
    for (const tab of ['代理设置', '指纹设置', '基础设置']) {
      await clickText(tab, `document.querySelector('.ant-drawer-open') ?? document`)
      await delay(400)
      if (!await alive()) failures.push(`${name} → ${tab}: the page went blank`)
      const text = await run(`document.querySelector('.ant-drawer-open')?.innerText ?? ''`)
      if (tab === '指纹设置' && !text.includes('国家/地区')) failures.push(`${name}: no 国家/地区 row in the fingerprint tab`)
      // The label after the country says how it was chosen.
      const label = name === kinds.manual.name ? '手动选择' : name === kinds.ip.name || name === kinds.api.name ? '基于 IP 生成' : undefined
      if (tab === '指纹设置' && label && !text.includes(label)) failures.push(`${name}: the country is not labelled ${label}`)
      if (tab === '指纹设置' && process.env.SMOKE_SCREENSHOTS) {
        await run(`[...document.querySelectorAll('.ant-drawer-open .fb-form-label')].find((node) => node.innerText.startsWith('国家/地区'))?.scrollIntoView({ block: 'center' }), true`)
        await delay(300)
        const shot = await instance.client.send('Page.captureScreenshot', { format: 'png' })
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(process.env.SMOKE_SCREENSHOTS, `${name}.png`), Buffer.from(shot.data, 'base64'))
      }
    }
    await clickText('取消', `document.querySelector('.ant-drawer-open') ?? document`)
    await delay(500)
  }
  const errors = await run('window.__smokeErrors')
  for (const error of errors) failures.push(`renderer error: ${error}`)
} finally {
  await quitApp(instance).catch(() => undefined)
  await removeTemporaryTree(userData).catch(() => undefined)
}
if (failures.length) {
  console.error(`editor smoke FAILED:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('editor smoke passed: every window kind opens in the editor, all tabs render')
