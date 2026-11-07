#!/usr/bin/env node
/**
 * Deep-check notes per site (11-07, window #80): a kept result where Pixelscan said inconsistent only for
 * "Proxy detected" shows 有风险 with Pixelscan's own notes, and whoer's "Proxy: …" keeps whoer's note.
 *
 *   npm run build && xvfb-run -a node tools/app-e2e/deep-notes.mjs [folder]
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
const userData = await mkdtemp(join(tmpdir(), 'prism-deep-notes-'))
const version = 'prism-156.0.8078.47'
const kernel = join(userData, 'vault', 'kernels', version)
await mkdir(join(kernel, 'browser'), { recursive: true })
await writeFile(join(kernel, 'browser', 'chrome'), '#!/bin/sh\n', { mode: 0o755 })
await writeFile(join(kernel, 'manifest.json'), J({ version, executableRelative: 'browser/chrome', releaseTag: 'prism24', assetName: 'k.zip', sha256: '0'.repeat(64), installedAt: new Date().toISOString(), windowScreen: true, webrtcRelay: true }))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'

const results = [
  { site: 'pixelscan', name: 'Pixelscan', url: 'https://pixelscan.net/fingerprint-check', status: 'warn', findings: ['Fingerprint is inconsistent', 'Proxy: Proxy detected'] },
  { site: 'whoer', name: 'whoer', url: 'https://whoer.net/', status: 'warn', score: '90%', findings: ['Proxy: Yes'] }
]

let instance = await launchApp({ app }, userData)
let id
try {
  const run = (expression) => evaluate(instance.client, expression)
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  const value = draft('深度检测说明', 990, 'https://example.com/')
  value.kernelVersion = version
  id = await run(`window.browserApi.profiles.create(${J(value)}).then((profile) => profile.id)`)
} finally {
  await quitApp(instance)
}
const runtime = join(userData, 'vault', 'profiles', id, 'runtime')
await mkdir(runtime, { recursive: true })
await writeFile(join(runtime, 'deep-check.json'), J({ checkedAt: new Date().toISOString(), results }))

instance = await launchApp({ app }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await delay(2500)
  await run(`[...document.querySelectorAll('.fb-table-panel .ant-table-tbody tr[data-row-key] button, .fb-table-panel .ant-table-tbody tr[data-row-key] a')].find((n) => n.innerText.trim() === '编辑' || n.getAttribute('aria-label') === '编辑')?.click(), true`)
  await delay(1500)
  await run(`[...document.querySelectorAll('.ant-drawer-open .ant-tabs-tab')].find((n) => n.innerText.includes('指纹设置'))?.click(), true`)
  await delay(1500)
  await run(`document.querySelector('.fb-deep-results')?.scrollIntoView(), true`)
  await delay(500)
  const sites = await run(`[...document.querySelectorAll('.fb-deep-site')].map((node) => ({ title: node.querySelector('.fb-deep-title')?.innerText.replace(/\\s+/g, ' ').trim(), findings: [...node.querySelectorAll('.fb-deep-finding')].map((f) => f.innerText.replace(/\\s+/g, ' ').trim()) }))`)
  const shot = await instance.client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(folder, 'deep-notes.png'), Buffer.from(shot.data, 'base64'))
  const pixelscan = sites.find((site) => site.title?.startsWith('Pixelscan'))
  const whoer = sites.find((site) => site.title?.startsWith('whoer'))
  check(Boolean(pixelscan?.title.includes('有风险')), `Pixelscan proxy only: 有风险 (${pixelscan?.title})`)
  check(Boolean(pixelscan?.findings.some((f) => f.includes('Proxy detected') && f.includes('Pixelscan 按 IP 数据库') && !f.includes('whoer'))), `Pixelscan proxy note is Pixelscan's (${pixelscan?.findings.join(' | ')})`)
  check(Boolean(pixelscan?.findings.some((f) => f.includes('inconsistent') && f.includes('任意一项报红'))), 'Pixelscan inconsistent has its note')
  check(Boolean(whoer?.findings.some((f) => f.includes('被 whoer 识别为代理'))), `whoer proxy keeps whoer's note (${whoer?.findings.join(' | ')})`)
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall ok')
process.exit(failures.length ? 1 : 0)
