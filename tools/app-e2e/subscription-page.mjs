#!/usr/bin/env node
/**
 * 代理 IP → 订阅 in the real app: the side menu counts what the page lists; node rows sort, and their
 * headers resize and move like the other lists; 清理旧记录 removes the records of nodes gone (or of a
 * deleted subscription) except those a window uses; deleting a subscription takes its unused records.
 * Checking more nodes than there are node slots works (each check gives its slot back).
 *
 *   npm run build && TUNNEL_CORE_BIN=build/tunnel-core/current/mihomo xvfb-run -a node tools/app-e2e/subscription-page.mjs [shot.png]
 *   Windows, the packaged app, more nodes than its 128 slots:
 *   set PRISM_APP=...\win-unpacked\Fingerprint Browser.exe & set NODES=140 & node tools\app-e2e\subscription-page.mjs shot.png
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { draft, evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const packaged = Boolean(process.env.PRISM_APP)
const app = packaged ? resolve(process.env.PRISM_APP) : resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const shot = process.argv[2]
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const failures = []
const expect = (label, actual, wanted) => {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (wanted ${JSON.stringify(wanted)})`}`)
  if (!ok) failures.push(label)
}

// SOCKS5 nodes on this computer that go straight to where they are asked (no outside network needed).
// OFFLINE_NODES=1: they refuse every connection, so checks fail at once and ask no outside service.
const servers = []
const socksNode = () => new Promise((done) => {
  const server = createServer((client) => {
    client.on('error', () => undefined)
    if (process.env.OFFLINE_NODES === '1') return client.destroy()
    client.once('data', () => {
      client.write(Buffer.from([5, 0]))
      client.once('data', (request) => {
        const host = request[3] === 1 ? [...request.subarray(4, 8)].join('.') : request.subarray(5, 5 + request[4]).toString()
        const upstream = createConnection(request.readUInt16BE(request.length - 2), host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          client.pipe(upstream).pipe(client)
        })
        upstream.on('error', () => client.destroy())
      })
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1', () => done(server.address().port))
})
const NAMED = ['香港 10', '香港 2', '日本 01', '美国 03', '新加坡 01', '台湾 01']
const NODES = Math.max(NAMED.length, Number(process.env.NODES) || NAMED.length)
const ports = []
for (let index = 0; index < NODES; index++) ports.push(await socksNode())

const userData = await mkdtemp(join(tmpdir(), 'prism-subscription-page-'))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const instance = await launchApp({ app, packaged }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  const names = [...NAMED, ...Array.from({ length: NODES - NAMED.length }, (_, index) => `节点 ${index + 1}`)]
  const content = ['proxies:', ...names.map((name, index) => `  - {name: ${name}, type: socks5, server: 127.0.0.1, port: ${ports[index]}}`), ''].join('\n')
  await run(`window.browserApi.subscriptions.addSource({ name: '订阅', kind: 'links', content: ${JSON.stringify(content)} }).then(() => true)`)
  await run(`window.browserApi.subscriptions.addSource({ name: 'EMSL', kind: 'links', content: ${JSON.stringify(`proxies:\n  - {name: 旧 01, type: socks5, server: 127.0.0.1, port: ${ports[0]}}\n  - {name: 旧 02, type: socks5, server: 127.0.0.1, port: ${ports[0]}}\n`)} }).then(() => true)`)
  // Records: a node of 订阅 checked, a node 订阅 no longer has, and two of EMSL (one used by a window).
  const entry = (source, node) => run(`window.browserApi.subscriptions.nodeProxy({ source: ${JSON.stringify(source)}, node: ${JSON.stringify(node)} }).then((proxy) => proxy.id)`)
  const hk = await entry('订阅', '香港 10')
  await entry('订阅', '韩国 99')
  await entry('EMSL', '旧 01')
  const usedOld = await entry('EMSL', '旧 02')
  const windowId = await run(`window.browserApi.profiles.create(${JSON.stringify(draft('用旧节点的窗口', 300003, 'https://example.com/'))}).then((profile) => profile.id)`)
  await run(`window.browserApi.profiles.assignMany([${JSON.stringify(windowId)}], { proxyId: ${JSON.stringify(usedOld)} }).then(() => true)`).catch((error) => failures.push(`assign: ${error.message}`))
  // EMSL deleted: its record no window uses goes with it; the one a window uses stays (and becomes a 旧记录).
  const emsl = await run(`window.browserApi.subscriptions.status().then((status) => status.sources.find((source) => source.name === 'EMSL').id)`)
  await run(`window.browserApi.subscriptions.removeSource(${JSON.stringify(emsl)}).then(() => true)`)
  const left = await run(`window.browserApi.proxy.list().then((list) => list.filter((proxy) => proxy.subscription).map((proxy) => proxy.subscription.source + '/' + proxy.subscription.node).sort())`)
  expect('records after deleting EMSL', left, ['EMSL/旧 02', '订阅/韩国 99', '订阅/香港 10'].sort())

  // Every node checked, 8 at a time like 全部检测 (NODES=140 is more than the app's 128 slots): each
  // check gives its slot back, so none fails for want of one.
  const started = Date.now()
  const checks = []
  for (let index = 0; index < names.length; index += 8) {
    checks.push(...await run(`Promise.all(${JSON.stringify(names.slice(index, index + 8))}.map((node) => window.browserApi.subscriptions.nodeProxy({ source: '订阅', node }).then((proxy) => window.browserApi.proxy.check(proxy.id)).then((proxy) => proxy.check?.ok ? 'ok' : proxy.check?.error ?? '?', (error) => error.message)))`))
  }
  console.log(`checked ${checks.length} nodes in ${Math.round((Date.now() - started) / 1000)} s: ${checks.filter((result) => result === 'ok').length} ok`)
  expect('checks never fail for want of a slot', checks.filter((result) => /不能超过/.test(result)), [])

  await run('location.reload(), true')
  await delay(2500)
  const click = (text) => run(`(() => {
    const target = [...document.querySelectorAll('button, [role="tab"], .ant-tabs-tab')].find((node) => node.innerText?.trim().startsWith(${JSON.stringify(text)}))
    if (!target) return false
    target.click()
    return true
  })()`)
  const sideCount = () => run(`[...document.querySelectorAll('.fb-nav-item')].find((node) => node.innerText.includes('代理 IP'))?.querySelector('b')?.innerText`)
  await click('代理 IP')
  await delay(800)
  expect('side menu counts the listed nodes, not old records', await sideCount(), String(NODES))
  await click('订阅')
  await delay(1200)
  const nodeNames = () => run(`[...document.querySelectorAll('.ant-table-expanded-row .ant-table-tbody tr.ant-table-row')].map((row) => row.querySelector('td')?.innerText.trim())`)
  const before = await nodeNames()
  expect('node rows listed', before.length, Math.min(NODES, 50))
  const header = (title) => `[...document.querySelectorAll('.ant-table-expanded-row th')].find((th) => th.innerText.trim() === ${JSON.stringify(title)})`
  expect('node headers can be resized and moved', await run(`(() => { const th = ${header('协议')}; return Boolean(th?.querySelector('.fb-col-resize')) && th.classList.contains('fb-col-movable') })()`), true)
  expect('subscription headers can be resized', await run(`Boolean([...document.querySelectorAll('.ant-table-thead th')].find((th) => th.innerText.trim() === '订阅名称')?.querySelector('.fb-col-resize'))`), true)
  await run(`(${header('节点名称')}).querySelector('.ant-table-column-sorters, .ant-table-column-title')?.click() ?? (${header('节点名称')}).click(), true`)
  await delay(400)
  const sorted = await nodeNames()
  expect('sorted by node name', sorted, [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 50))
  expect('two column-settings buttons', await run(`[...document.querySelectorAll('.fb-colset-button')].map((button) => button.innerText.trim())`), ['订阅列', '节点列'])
  const cleanLabel = await run(`[...document.querySelectorAll('button')].find((button) => button.innerText.includes('清理旧记录'))?.innerText.trim()`)
  expect('清理旧记录 counts both old records', cleanLabel, '清理旧记录 2')
  if (shot) {
    const { data } = await instance.client.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(shot, Buffer.from(data, 'base64'))
  }
  await click('清理旧记录')
  await delay(600)
  expect('confirm names what is removed and what stays', await run(`document.querySelector('.ant-modal-confirm')?.innerText.replace(/\\s+/g, ' ')`).then((text) => [/清理 1 条旧节点记录/.test(text ?? ''), /另有 1 条绑定了窗口/.test(text ?? '')]), [true, true])
  await run(`[...document.querySelectorAll('.ant-modal-confirm button')].find((button) => button.innerText.replace(/\\s/g, '') === '清理').click(), true`)
  await delay(1200)
  const after = await run(`window.browserApi.proxy.list().then((list) => list.filter((proxy) => proxy.subscription).map((proxy) => proxy.subscription.source + '/' + proxy.subscription.node).sort())`)
  expect('records after 清理: every node checked, and the old one a window uses', [after.length, after.includes('EMSL/旧 02'), after.includes('订阅/韩国 99')], [NODES + 1, true, false])
  expect('hk record kept', after.includes('订阅/香港 10') && Boolean(hk), true)
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
  for (const server of servers) server.close()
}
if (failures.length) { console.error(`failed: ${failures.join(', ')}`); process.exit(1) }
console.log('subscription page ok')
