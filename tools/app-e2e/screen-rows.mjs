#!/usr/bin/env node
/**
 * The resolution row of the window editor on a Prism kernel: a 4K window (150%), a saved
 * 2560 × 1600 one and one larger than this screen. A stand-in kernel folder is made in the
 * temporary profile so the editor offers Prism choices.
 *
 *   npm run build && node tools/app-e2e/screen-rows.mjs [folder]   (Linux: xvfb-run -a …)
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const folder = resolve(process.argv[2] ?? 'ui-shots')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const version = 'prism-156.0.8078.47'

await mkdir(folder, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), 'prism-screen-rows-'))
const kernel = join(userData, 'vault', 'kernels', version)
await mkdir(join(kernel, 'browser'), { recursive: true })
await writeFile(join(kernel, 'browser', 'chrome'), '#!/bin/sh\n', { mode: 0o755 })
await writeFile(join(kernel, 'manifest.json'), JSON.stringify({ version, executableRelative: 'browser/chrome', releaseTag: '156.0.8078.47-prism9', windowScreen: true, webrtcRelay: true }))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const instance = await launchApp({ app }, userData)
const failures = []
try {
  const run = (expression) => evaluate(instance.client, expression)
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const windows = { '4K 窗口': [3840, 2160], '2560x1600 窗口': [2560, 1600], '3440 窗口': [3440, 1440] }
  for (const [name, [width, height]] of Object.entries(windows)) {
    const value = draft(name, 300 + width, 'https://example.com/')
    value.kernelVersion = version
    value.fingerprint = { ...value.fingerprint, platform: 'windows', hardwareProfileId: 'windows-host', platformVersion: '10.0.0', screenWidth: width, screenHeight: height, overrides: ['screen'] }
    await run(`window.browserApi.profiles.create(${JSON.stringify(value)}).then(() => true)`).catch((error) => failures.push(`create ${name}: ${error.message}`))
  }
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  await run('location.reload(), true')
  await delay(2500)
  for (const [index, name] of Object.keys(windows).entries()) {
    const opened = await run(`(() => {
      const row = [...document.querySelectorAll('tr')].find((node) => node.innerText.includes(${JSON.stringify(name)}))
      const button = row && [...row.querySelectorAll('button')].find((node) => node.innerText.trim() === '编辑')
      if (!button) return false
      button.click()
      return true
    })()`)
    if (!opened) { failures.push(`${name}: no edit button`); continue }
    await delay(900)
    await run(`(() => { const tab = [...document.querySelectorAll('.ant-drawer-open .ant-tabs-tab')].find((node) => node.innerText.trim() === '指纹设置'); tab?.click(); return true })()`)
    await delay(600)
    const row = await run(`(() => {
      const label = [...document.querySelectorAll('.ant-drawer-open .fb-row-label, .ant-drawer-open label, .ant-drawer-open span, .ant-drawer-open div')].find((node) => node.childElementCount === 0 && node.innerText?.trim() === '分辨率')
      const box = label?.closest('.fb-row') ?? label?.parentElement?.parentElement
      box?.scrollIntoView({ block: 'center' })
      return box ? box.innerText : ''
    })()`)
    console.log(`--- ${name}\n${row}`)
    await delay(500)
    const { data } = await instance.client.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(folder, `screen-row-${index + 1}.png`), Buffer.from(data, 'base64'))
    await run(`(() => { document.querySelector('.ant-drawer-open .ant-drawer-close')?.click(); return true })()`)
    await delay(700)
  }
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
