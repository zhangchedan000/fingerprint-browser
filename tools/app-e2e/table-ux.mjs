#!/usr/bin/env node
/**
 * Tables and lists the user arranges (rule of 11-07): rows dragged into the user's own order, a column
 * of their own added (written in, renamed), a header renamed, the drag locked while a header sort is
 * on, all kept after a restart (in the account's settings); the 检测网站 lists of the deep check and
 * of IP 评分 dragged into another order. Screenshots go to the folder given.
 *
 *   npm run build && xvfb-run -a node tools/app-e2e/table-ux.mjs [folder]
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
const failures = []
const check = (ok, message) => { console.log(ok ? 'ok  ' : 'FAIL', message); if (!ok) failures.push(message) }
const J = JSON.stringify
await mkdir(folder, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), 'prism-table-ux-'))
const version = 'prism-156.0.8078.47'
const kernel = join(userData, 'vault', 'kernels', version)
await mkdir(join(kernel, 'browser'), { recursive: true })
await writeFile(join(kernel, 'browser', 'chrome'), '#!/bin/sh\n', { mode: 0o755 })
await writeFile(join(kernel, 'manifest.json'), J({ version, executableRelative: 'browser/chrome', releaseTag: 'prism24', assetName: 'k.zip', sha256: '0'.repeat(64), installedAt: new Date().toISOString(), windowScreen: true, webrtcRelay: true }))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'

// In-page helpers: rows of the window table, an HTML5 drag from a handle onto a row, typing into an input.
const HELPERS = `
  window.__rows = () => [...document.querySelectorAll('.fb-table-panel .ant-table-tbody tr[data-row-key]')].map((tr) => tr.getAttribute('data-row-key'))
  window.__drag = (handle, target, before) => {
    const data = new DataTransfer()
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
    const box = target.getBoundingClientRect()
    const y = before ? box.top + 2 : box.bottom - 2
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientY: y }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientY: y }))
    handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
  }
  window.__type = (input, text, enter) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (enter) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  }
  true
`

let instance = await launchApp({ app }, userData)
const ids = []
try {
  const run = (expression) => evaluate(instance.client, expression)
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  for (const [index, name] of ['窗口甲', '窗口乙', '窗口丙'].entries()) {
    const value = draft(name, 900 + index, 'https://example.com/')
    value.kernelVersion = version
    ids.push(await run(`window.browserApi.profiles.create(${J(value)}).then((profile) => profile.id)`))
  }
} finally {
  await quitApp(instance)
}

const screenshot = async (name) => {
  const shot = await instance.client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(folder, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

instance = await launchApp({ app }, userData)
let tableKeyRows
try {
  const run = (expression) => evaluate(instance.client, expression)
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await delay(2500)
  await run(HELPERS)
  const before = await run('window.__rows()')
  check(before.length === 3, `three windows listed (${before.length})`)
  check((await run(`document.querySelectorAll('.fb-row-handle').length`)) === 3, 'every row has a drag handle')
  await screenshot('table-1-start')

  // 1. Drag the last row above the first.
  await run(`(() => { const rows = document.querySelectorAll('.fb-table-panel .ant-table-tbody tr[data-row-key]'); window.__drag(rows[2].querySelector('.fb-row-handle'), rows[0], true); return true })()`)
  await delay(800)
  const dragged = await run('window.__rows()')
  check(dragged[0] === before[2] && dragged[1] === before[0] && dragged[2] === before[1], `last row dragged to the top (${dragged.join(',')})`)
  await screenshot('table-2-row-dragged')

  // 2. A column of my own: 负责人, written in for the first row.
  await run(`document.querySelector('.fb-colset-button').click(), true`)
  await delay(500)
  await run(`(() => { const input = document.querySelector('.fb-colset-add input'); window.__type(input, '负责人'); return true })()`)
  await delay(200)
  await run(`[...document.querySelectorAll('.fb-colset-add button')].find((b) => b.innerText.includes('新建列')).click(), true`)
  await delay(700)
  await screenshot('table-3-column-added')
  const headers = await run(`[...document.querySelectorAll('.fb-table-panel thead th')].map((th) => th.innerText.trim())`)
  check(headers.includes('负责人'), `new column 负责人 in the header (${headers.filter(Boolean).join(' | ')})`)
  // Close the settings, write in the first row's cell.
  await run(`document.body.click(), document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await delay(400)
  await run(`document.querySelector('.fb-table-panel .ant-table-tbody tr[data-row-key] .fb-custom-cell').click(), true`)
  await delay(300)
  await run(`(() => { const input = document.querySelector('.fb-table-panel .ant-table-tbody input.ant-input'); window.__type(input, '小王', true); return true })()`)
  await delay(900)
  const cell = await run(`document.querySelector('.fb-table-panel .ant-table-tbody tr[data-row-key] .fb-custom-cell')?.innerText.trim()`)
  check(cell === '小王', `written in the new column (${cell})`)

  // 2b. A column named 时区 finds the window's time zone by itself; a second one is not offered it again.
  await run(`document.querySelector('.fb-colset-button').click(), true`)
  await delay(500)
  await run(`(() => { const input = document.querySelector('.fb-colset-add input'); window.__type(input, '时区'); return true })()`)
  await delay(300)
  const matched = await run(`({ hint: document.querySelector('.fb-colset-hint')?.innerText.trim(), chosen: document.querySelector('.fb-colset-content .ant-select')?.innerText.trim() })`)
  check(matched.chosen === '时区' && /已按名称匹配到「时区」/.test(matched.hint ?? ''), `typing 时区 picks the time zone data (${matched.chosen} / ${matched.hint})`)
  await screenshot('table-3b-matched')
  await run(`[...document.querySelectorAll('.fb-colset-add button')].find((b) => b.innerText.includes('新建列')).click(), true`)
  await delay(700)
  const zoneCells = await run(`(() => {
    const ths = [...document.querySelectorAll('.fb-table-panel thead th')]
    const at = ths.findIndex((th) => th.innerText.trim() === '时区')
    if (at < 0) return null
    return [...document.querySelectorAll('.fb-table-panel .ant-table-tbody tr[data-row-key]')].map((tr) => tr.children[at]?.innerText.trim())
  })()`)
  const zoneValues = await run(`window.browserApi.profiles.list().then((list) => list.map((p) => p.fingerprint.timezone))`)
  check(Array.isArray(zoneCells) && zoneCells.length === 3 && zoneCells.every((text) => zoneValues.includes(text)), `时区 column shows each window's time zone (${zoneCells?.join(', ')})`)
  await run(`(() => { const input = document.querySelector('.fb-colset-add input'); window.__type(input, '时区'); return true })()`)
  await delay(300)
  const again = await run(`document.querySelector('.fb-colset-hint')?.innerText.trim()`)
  check(/没有匹配的数据/.test(again ?? ''), `the time zone is not offered to a second column (${again})`)
  await run(`(() => { const input = document.querySelector('.fb-colset-add input'); window.__type(input, ''); return true })()`)
  await run(`document.body.click(), document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await delay(400)

  // 3. Rename the 备注 header to 店铺.
  await run(`document.querySelector('.fb-colset-button').click(), true`)
  await delay(500)
  const renamed = await run(`(() => {
    const item = [...document.querySelectorAll('.fb-colset li')].find((li) => li.innerText.trim().startsWith('备注'))
    if (!item) return 'no 备注 in the column settings'
    item.querySelector('button[aria-label="改名"]').click()
    return true
  })()`)
  await delay(300)
  if (renamed === true) {
    await run(`(() => { const input = document.querySelector('.fb-colset li input.ant-input'); window.__type(input, '店铺', true); return true })()`)
    await delay(800)
  }
  await screenshot('table-4-settings')
  const headersAfter = await run(`[...document.querySelectorAll('.fb-table-panel thead th')].map((th) => th.innerText.trim())`)
  check(renamed === true && headersAfter.includes('店铺') && !headersAfter.includes('备注'), `备注 renamed to 店铺 (${renamed})`)
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), document.body.click(), true`)
  await delay(400)

  // 4. A header sort on: the handles are off; off again: back to my order.
  await run(`[...document.querySelectorAll('.fb-table-panel thead th')].find((th) => th.innerText.trim() === '序号').click(), true`)
  await delay(500)
  check((await run(`document.querySelectorAll('.fb-row-handle.is-off').length`)) === 3, 'drag handles off while the header sort is on')
  await screenshot('table-5-sorted')
  for (let i = 0; i < 2; i++) {
    await run(`[...document.querySelectorAll('.fb-table-panel thead th')].find((th) => th.innerText.trim() === '序号').click(), true`)
    await delay(400)
  }
  check((await run(`document.querySelectorAll('.fb-row-handle.is-off').length`)) === 0, 'handles back once the sort is off')
  check(J(await run('window.__rows()')) === J(dragged), 'my own order back once the sort is off')
  await delay(1200)
  const prefs = await run(`window.browserApi.app.preferences()`)
  const tables = Object.values(prefs.uiPrefs?.tables ?? {})
  tableKeyRows = tables.find((table) => table.rows)?.rows
  check(J(tableKeyRows) === J(dragged), 'row order kept in the account settings')
  check(tables.some((table) => table.custom?.some((column) => column.title === '时区' && column.field === 'timezone')), 'the 时区 column keeps its data field in the account settings')
  check(tables.some((table) => table.custom?.[0]?.title === '负责人' && Object.values(table.values ?? {}).some((cells) => Object.values(cells).includes('小王'))), 'added column and its text kept in the account settings')
  check(tables.some((table) => Object.values(table.titles ?? {}).includes('店铺')), 'renamed header kept in the account settings')
} finally {
  await quitApp(instance)
}

// 5. After a restart: the same order, column and names.
instance = await launchApp({ app }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await delay(2500)
  await run(HELPERS)
  check(J(await run('window.__rows()')) === J(tableKeyRows), 'row order the same after a restart')
  const headers = await run(`[...document.querySelectorAll('.fb-table-panel thead th')].map((th) => th.innerText.trim())`)
  check(headers.includes('负责人') && headers.includes('店铺'), 'added column and renamed header the same after a restart')
  await screenshot('table-6-after-restart')

  // 6. The two 检测网站 lists in the window editor: drag the last site to the top.
  await run(`[...document.querySelectorAll('.fb-table-panel .ant-table-tbody tr[data-row-key] button, .fb-table-panel .ant-table-tbody tr[data-row-key] a')].find((n) => n.innerText.trim() === '编辑' || n.getAttribute('aria-label') === '编辑')?.click(), true`)
  await delay(1500)
  const opened = await run(`Boolean(document.querySelector('.ant-drawer-open'))`)
  check(opened, 'window editor opened')
  const tryList = async (label, tab, read) => {
    await run(`[...document.querySelectorAll('.ant-drawer-open [role="tab"], .ant-drawer-open .ant-tabs-tab')].find((n) => n.innerText.trim() === ${J(tab)})?.click(), true`)
    await delay(600)
    const clicked = await run(`(() => {
      const buttons = [...document.querySelectorAll('.ant-drawer-open button')].filter((b) => b.innerText.trim() === '检测网站' && b.offsetParent)
      if (!buttons.length) return false
      buttons[0].click()
      return true
    })()`)
    await delay(700)
    if (!clicked) { check(false, `${label}: 检测网站 button found`); return }
    const order = await run(`[...document.querySelectorAll('.ant-modal-wrap:not([style*="display: none"]) .fb-deep-sites-row b')].map((b) => b.innerText.trim())`)
    await run(`(() => {
      const rows = [...document.querySelectorAll('.ant-modal-wrap:not([style*="display: none"]) .fb-deep-sites-row')]
      window.__drag(rows[rows.length - 1].querySelector('.fb-row-handle'), rows[0], true)
      return true
    })()`)
    await delay(900)
    await screenshot(`table-7-${tab}-sites`)
    const after = await run(`[...document.querySelectorAll('.ant-modal-wrap:not([style*="display: none"]) .fb-deep-sites-row b')].map((b) => b.innerText.trim())`)
    check(order.length > 1 && after[0] === order[order.length - 1] && after.length === order.length, `${label}: last site dragged to the top (${after.join(', ')})`)
    const saved = await run(`window.browserApi.app.preferences().then((p) => (p[${J(read)}] ?? []).map((s) => s.name))`)
    check(J(saved) === J(after), `${label}: new order saved (${saved.join(', ')})`)
    await run(`[...document.querySelectorAll('.ant-modal-wrap:not([style*="display: none"]) .ant-modal-close')].pop()?.click(), true`)
    await delay(500)
  }
  await tryList('深度检测', '指纹设置', 'deepCheckSites')
  await tryList('IP 检测', '代理设置', 'ipCheckSites')
} finally {
  await quitApp(instance)
}

await removeTemporaryTree(userData)
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall ok')
process.exit(failures.length ? 1 : 0)
