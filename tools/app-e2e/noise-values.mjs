#!/usr/bin/env node
/**
 * The 指纹值 rows show the value a site reads in the choice itself: a checked window shows its
 * Canvas / AudioContext / ClientRects values there, a window never checked says it is to be checked.
 * A stand-in Prism kernel folder and a saved check result stand in for a real kernel run.
 *
 *   npm run build && node tools/app-e2e/noise-values.mjs [folder]   (Linux: xvfb-run -a …)
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
const values = { canvas: '87312ba946662577', audio: '172.67164888085244', clientrects: '13a4b84bf613f545' }

await mkdir(folder, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), 'prism-noise-values-'))
const kernel = join(userData, 'vault', 'kernels', version)
await mkdir(join(kernel, 'browser'), { recursive: true })
await writeFile(join(kernel, 'browser', 'chrome'), '#!/bin/sh\n', { mode: 0o755 })
await writeFile(join(kernel, 'manifest.json'), JSON.stringify({ version, executableRelative: 'browser/chrome', releaseTag: '156.0.8078.47-prism9', assetName: 'ungoogled-chromium_156.0.8078.47-prism9_windows_x64.zip', sha256: '0'.repeat(64), installedAt: new Date().toISOString(), windowScreen: true, webrtcRelay: true }))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const failures = []
let instance = await launchApp({ app }, userData)
try {
  let run = (expression) => evaluate(instance.client, expression)
  for (const [index, name] of ['已检测窗口', '新窗口未检测'].entries()) {
    const value = draft(name, 500 + index, 'https://example.com/')
    value.kernelVersion = version
    value.fingerprint = { ...value.fingerprint, platform: 'windows', hardwareProfileId: 'windows-11-rtx4070', platformVersion: '19.0.0' }
    await run(`window.browserApi.profiles.create(${JSON.stringify(value)}).then(() => true)`)
  }
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  const checked = (await run('window.browserApi.profiles.list()')).find((profile) => profile.name === '已检测窗口')
  await quitApp(instance)
  // A check of that window, as the fingerprint check saves it.
  const fp = checked.fingerprint
  const report = {
    checkedAt: new Date(Date.now() - 3600_000).toISOString(),
    kernelVersion: checked.kernelVersion,
    checkedSettings: JSON.stringify({ seed: fp.seed, gpu: fp.gpu, kernelVersion: checked.kernelVersion, disabledSpoofing: fp.disabledSpoofing }),
    observed: { userAgent: '', cores: 8, screen: [1920, 1080], timezone: fp.timezone, language: fp.language, webdriver: false,
      canvas: [values.canvas, values.canvas], audio: [values.audio, values.audio], clientrects: [values.clientrects, values.clientrects], font: ['f', 'f'] },
    items: []
  }
  await writeFile(join(userData, 'vault', 'fingerprint-checks.json'), JSON.stringify({ [checked.id]: report }))
  instance = await launchApp({ app }, userData)
  run = (expression) => evaluate(instance.client, expression)
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await delay(2000)
  const drawer = `document.querySelector('.ant-drawer-open')`
  const rows = () => run(`(() => Object.fromEntries(['Canvas', 'AudioContext', 'ClientRects'].map((label) => {
    const row = [...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim() === label)
    return [label, row ? row.querySelector('.fb-form-control').innerText.split('\\n').filter(Boolean).slice(0, 3).join(' | ') : 'no row']
  })))()`)
  for (const [index, name] of ['已检测窗口', '新窗口未检测'].entries()) {
    await run(`(() => {
      const row = [...document.querySelectorAll('tr')].find((node) => node.innerText.includes(${JSON.stringify(name)}))
      ;[...row.querySelectorAll('button')].find((node) => node.innerText.trim() === '编辑').click()
      return true
    })()`)
    await delay(1200)
    await run(`(() => { [...${drawer}.querySelectorAll('.ant-tabs-tab')].find((node) => node.innerText.trim() === '指纹设置').click(); return true })()`)
    await delay(800)
    await run(`(() => { const row = [...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim() === 'Canvas'); row.scrollIntoView({ block: 'center' }); return true })()`)
    await delay(500)
    const shown = await rows()
    console.log(`--- ${name}`)
    for (const [label, text] of Object.entries(shown)) console.log(`  ${label}: ${text}`)
    if (index === 0) {
      if (!shown.Canvas.startsWith(values.canvas)) failures.push(`Canvas shows ${shown.Canvas}`)
      if (!shown.AudioContext.startsWith(values.audio)) failures.push(`AudioContext shows ${shown.AudioContext}`)
      if (!shown.ClientRects.startsWith(values.clientrects)) failures.push(`ClientRects shows ${shown.ClientRects}`)
    } else if (!Object.values(shown).every((text) => text.startsWith('每个窗口不同 · 待检测'))) failures.push(`unchecked window shows ${JSON.stringify(shown)}`)
    const { data } = await instance.client.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(folder, `noise-values-${index + 1}.png`), Buffer.from(data, 'base64'))
    await run(`(() => { ${drawer}.querySelector('.ant-drawer-close').click(); return true })()`)
    await delay(800)
  }
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('values shown in the choices')
