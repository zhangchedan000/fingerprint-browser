#!/usr/bin/env node
/**
 * Canvas / AudioContext / ClientRects real by default (11-07): a window made in the editor gets the
 * real values, the editor offers 本机真实（推荐）, and 批量操作 → Canvas / AudioContext / ClientRects sets
 * older windows real or back to each window its own, keeping their other settings.
 *
 *   npm run build && xvfb-run -a node tools/app-e2e/real-surfaces.mjs [folder]
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/electron/dist/electron')
const folder = resolve(process.argv[2] ?? 'ui-shots')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const failures = []
const check = (ok, message) => { console.log(ok ? 'ok  ' : 'FAIL', message); if (!ok) failures.push(message) }
const J = JSON.stringify
await mkdir(folder, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), 'prism-real-surfaces-'))
const version = 'prism-156.0.8078.47'
const kernel = join(userData, 'vault', 'kernels', version)
await mkdir(join(kernel, 'browser'), { recursive: true })
await writeFile(join(kernel, 'browser', 'chrome'), '#!/bin/sh\n', { mode: 0o755 })
await writeFile(join(kernel, 'manifest.json'), J({ version, executableRelative: 'browser/chrome', releaseTag: 'prism24', assetName: 'k.zip', sha256: '0'.repeat(64), installedAt: new Date().toISOString(), windowScreen: true, webrtcRelay: true }))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'

const instance = await launchApp({ app }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  // A window made by an older launcher: every surface noisy, fonts real.
  const older = draft('旧窗口', 4242, 'https://example.com/')
  older.kernelVersion = version
  older.fingerprint = { ...older.fingerprint, hardwareProfileId: process.platform === 'win32' ? 'windows-seeded-nvidia' : 'macos-m3-pro', disabledSpoofing: ['font'] }
  const olderId = await run(`window.browserApi.profiles.create(${J(older)}).then((profile) => profile.id)`)
  await run('location.reload(), true')
  await delay(2500)
  const fingerprintOf = (id) => run(`window.browserApi.profiles.list().then((list) => list.find((p) => p.id === ${J(id)})?.fingerprint.disabledSpoofing.slice().sort())`)
  const clickButton = (text, scope = 'document') => run(`(() => { const node = [...(${scope}).querySelectorAll('button')].find((n) => n.innerText.replace(/\\s+/g, '').trim() === ${J(text.replace(/\s+/g, ''))} && !n.disabled); node?.click(); return Boolean(node) })()`)

  // New window in the editor.
  check(await clickButton('新建窗口'), '新建窗口 opens the editor')
  await delay(1200)
  await run(`[...document.querySelectorAll('.ant-drawer-open .ant-tabs-tab')].find((n) => n.innerText.includes('指纹设置'))?.click(), true`)
  await delay(800)
  await run(`[...document.querySelectorAll('.ant-drawer-open .fb-form-label, .ant-drawer-open label, .ant-drawer-open div')].find((n) => n.childElementCount === 0 && n.innerText.trim() === 'Canvas')?.scrollIntoView({ block: 'center' }), true`)
  await delay(500)
  const shown = await run(`(document.querySelector('.ant-drawer-open')?.innerText ?? '').split('本机真实（推荐）').length - 1`)
  check(shown >= 3, `editor shows 本机真实（推荐） for the three surfaces (${shown})`)
  const shot = await instance.client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(folder, 'real-surfaces-editor.png'), Buffer.from(shot.data, 'base64'))
  check(await clickButton('确定创建', `document.querySelector('.ant-drawer-open')`), '确定创建')
  await delay(1500)
  const created = await run(`window.browserApi.profiles.list().then((list) => list.filter((p) => p.id !== ${J(olderId)}).map((p) => p.fingerprint.disabledSpoofing.slice().sort()))`)
  check(created.length === 1 && J(created[0]) === J(['audio', 'canvas', 'clientrects']), `new window is real: ${J(created)}`)

  // Batch: the older window real, then back to noise; its fonts setting stays.
  const pick = async () => {
    await run(`(() => { const box = document.querySelector('.fb-table-panel tr[data-row-key=${J(olderId)}] .ant-checkbox-input'); if (box && !box.checked) box.click(); return true })()`)
    await delay(400)
    await clickButton('批量操作')
    await delay(500)
    await run(`[...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')].find((n) => n.innerText.includes('Canvas / AudioContext / ClientRects'))?.click(), true`)
    await delay(800)
  }
  await pick()
  const title = await run(`document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal-title')?.innerText ?? ''`)
  check(title.includes('为 1 个窗口设置 Canvas、AudioContext、ClientRects'), `batch dialog: ${title}`)
  const modalShot = await instance.client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(folder, 'real-surfaces-batch.png'), Buffer.from(modalShot.data, 'base64'))
  await clickButton('应用', `document.querySelector('.ant-modal-wrap:not([style*="display: none"])')`)
  await delay(1200)
  check(J(await fingerprintOf(olderId)) === J(['audio', 'canvas', 'clientrects', 'font']), `older window set real, fonts kept: ${J(await fingerprintOf(olderId))}`)
  await pick()
  await run(`[...document.querySelectorAll('.ant-modal-wrap:not([style*="display: none"]) .ant-radio-wrapper')].find((n) => n.innerText.includes('每个窗口不同'))?.click(), true`)
  await delay(300)
  await clickButton('应用', `document.querySelector('.ant-modal-wrap:not([style*="display: none"])')`)
  await delay(1200)
  check(J(await fingerprintOf(olderId)) === J(['font']), `older window back to each its own: ${J(await fingerprintOf(olderId))}`)
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall ok')
process.exit(failures.length ? 1 : 0)
