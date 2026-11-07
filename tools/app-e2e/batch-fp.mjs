#!/usr/bin/env node
/**
 * Batch fingerprint test on Windows (user 2026-11-07): a test copy of the launcher (its own data folder,
 * never the user's) makes 20 windows with its own 新建窗口 screen, then opens them a few at a time and
 * visits the detection sites in each real window (a local DevTools port, PRISM_E2E_DEVTOOLS; no
 * Runtime.enable, so pages see no debugger). Page text and a screenshot per site go to the output folder.
 *
 *   set PRISM_APP=...\win-unpacked\Fingerprint Browser.exe
 *   node tools/app-e2e/batch-fp.mjs create <userData> <out> <round> <proxyHost>
 *   node tools/app-e2e/batch-fp.mjs run    <userData> <out> <round> [concurrency=5] [only=w01,w02]
 *   node tools/app-e2e/batch-fp.mjs reopen <userData> <out> <round> w01,w02,w03
 *
 * round: a name (mx, hk). The windows of a round are named "<round>-w01" … "<round>-w20".
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { evaluate, launchApp, quitApp } from './run.mjs'

const [phase, userData, out, round, arg5, arg6] = process.argv.slice(2)
if (!phase || !userData || !out || !round) {
  console.error('usage: batch-fp.mjs <create|run|reopen> <userData> <out> <round> …')
  process.exit(2)
}
const app = resolve(process.env.PRISM_APP)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const stamp = () => new Date().toTimeString().slice(0, 8)
const log = (...parts) => console.log(stamp(), ...parts)
await mkdir(out, { recursive: true })

const SITES = [
  ['creepjs', 'https://abrahamjuliot.github.io/creepjs/', 30000],
  ['browserscan', 'https://www.browserscan.net/', 35000],
  ['browserscan-bot', 'https://www.browserscan.net/bot-detection', 25000],
  ['pixelscan', 'https://pixelscan.net/fingerprint-check', 45000],
  ['iphey', 'https://iphey.com/', 40000],
  ['fpcom', 'https://demo.fingerprint.com/playground', 35000],
  ['sannysoft', 'https://bot.sannysoft.com/', 15000],
  ['dbi-bot', 'https://deviceandbrowserinfo.com/are_you_a_bot', 25000],
  ['whoer', 'https://whoer.net/', 35000],
  ['bl-js', 'https://browserleaks.com/javascript', 15000],
  ['bl-canvas', 'https://browserleaks.com/canvas', 15000],
  ['bl-webgl', 'https://browserleaks.com/webgl', 20000],
  ['bl-fonts', 'https://browserleaks.com/fonts', 30000],
  ['bl-hints', 'https://browserleaks.com/client-hints', 12000],
  ['bl-webrtc', 'https://browserleaks.com/webrtc', 15000],
  ['amiunique', 'https://amiunique.org/fingerprint', 40000]
]

/** The plan (11-07): 156 / 155, Intel / AMD 10 each, GPU tiers 5 each, binding and media devices half each, a few Win10. */
const TIERS = ['entry', 'mid', 'high', 'top']
const plan = Array.from({ length: 20 }, (_, i) => ({
  name: `${round}-w${String(i + 1).padStart(2, '0')}`,
  kernel: i % 2 === 0 ? '156' : '155',
  vendor: i < 10 ? 'Intel' : 'AMD',
  tier: TIERS[i % 4],
  binding: Math.floor(i / 2) % 2 === 0 ? 'on' : 'off',
  media: Math.floor(i / 5) % 2 === 0 ? 'auto' : 'other',
  // Win11 / Win10 10 each (user 11-07), spread over kernels, vendors and tiers.
  windows: [3, 4, 6, 8, 9, 11, 13, 14, 17, 18].includes(i) ? 'Windows 10' : 'Windows 11'
}))
// hardware-match.ts gpuTier, same regexes.
const gpuTier = (model) => /RTX (3080 Ti|3090|4080|4090|4070 Ti SUPER|5070 Ti|5080|5090)/.test(model) ? 'top'
  : /RTX (2080|3070|3080|4070|5070)/.test(model) ? 'high' : /RTX (2060 SUPER|2070|3060|4060)/.test(model) ? 'mid' : 'entry'

process.env.PRISM_E2E_TEAM_OFFLINE = '1'
process.env.PRISM_E2E_DEVTOOLS = '1'
const instance = await launchApp({ app, packaged: true, headed: true }, resolve(userData))
const run = (expression) => evaluate(instance.client, expression)
const J = JSON.stringify

async function windows() {
  return run(`window.browserApi.profiles.list().then((list) => list.map((p) => ({ id: p.id, name: p.name, status: p.status, fp: p.fingerprint, kernelVersion: p.kernelVersion, proxyId: p.proxyId })))`)
}

// ---- create: the launcher's own 新建窗口 screen ----------------------------------------------------
const drawer = `document.querySelector('.ant-drawer-open')`
const rowOf = (label) => `[...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim().replace(/\\s*\\*$/, '') === ${J(label)})`
const clickText = (text, scope = 'document', exact = true) => run(`(() => {
  const nodes = [...(${scope}).querySelectorAll('button, [role="tab"], .ant-tabs-tab, label, .ant-radio-button-wrapper, .ant-radio-wrapper')]
  const target = nodes.find((node) => ${exact ? `node.innerText?.trim() === ${J(text)}` : `node.innerText?.trim().startsWith(${J(text)})`})
  if (!target) return false
  target.click()
  return true
})()`)
/** Opens the select (the nth in the row, or the one with this aria-label) and clicks the option whose text passes `test`. */
async function choose(row, test, nth = 0) {
  const opened = await run(`(() => {
    const row = ${rowOf(row)}
    const select = row?.querySelectorAll('.ant-select')[${nth}]
    if (!select) return false
    select.querySelector('.ant-select-selector, .ant-select-content')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return true
  })()`)
  if (!opened) return `no select in ${row}`
  await delay(500)
  const picked = await run(`(() => {
    const options = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option:not(.ant-select-item-option-disabled)')]
    const test = ${test}
    const target = options.find((node) => test(node.innerText.trim(), options.indexOf(node), options.length))
    if (!target) return 'none of ' + options.length + ': ' + options.slice(0, 6).map((n) => n.innerText.trim()).join(' | ')
    target.click()
    return true
  })()`)
  await delay(400)
  return picked
}
const rowText = (label) => run(`(${rowOf(label)})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)

async function createOne(spec, proxyHost) {
  if (!await clickText('新建窗口')) throw new Error('新建窗口 not found')
  await delay(1200)
  await clickText('代理设置', drawer)
  await delay(400)
  if (!await clickText('从代理库选择', drawer)) throw new Error('从代理库选择 not found')
  await delay(400)
  const proxy = await choose('选择代理', `(text) => text.includes(${J(proxyHost)})`)
  if (proxy !== true) throw new Error(`proxy: ${proxy}`)
  await delay(2500)
  await clickText('基础设置', drawer)
  await delay(300)
  const bindingLabel = spec.binding === 'on' ? '绑定' : '不绑定'
  const bound = await run(`(() => {
    const row = ${rowOf('设备绑定登录')}
    const target = [...(row?.querySelectorAll('.ant-radio-wrapper') ?? [])].find((node) => node.innerText.trim().replace(/（推荐）$/, '') === ${J(bindingLabel)})
    if (!target) return false
    target.click()
    return true
  })()`)
  if (!bound) throw new Error('device binding radio not found')
  await clickText('指纹设置', drawer)
  await delay(500)
  const kernel = await choose('浏览器内核', `(text) => new RegExp('Chrome ${spec.kernel}\\\\b').test(text) && !/跟随/.test(text)`)
  if (kernel !== true) throw new Error(`kernel: ${kernel}`)
  await delay(800)
  const version = await choose('操作系统', `(text) => text === ${J(spec.windows)}`, 1)
  if (version !== true) throw new Error(`windows version: ${version}`)
  // The card the launcher picks with 换一换 brings its own CPU, memory and resolution (matchedToGpu).
  let gpu = ''
  let cpu = ''
  let tries = 0
  for (; tries < 120; tries++) {
    await run(`(() => { const b = [...(${rowOf('显卡')})?.querySelectorAll('button') ?? []].find((n) => n.innerText.trim() === '换一换'); b?.click(); return Boolean(b) })()`)
    await delay(150)
    gpu = await rowText('显卡')
    cpu = await rowText('CPU 型号')
    if (gpuTier(gpu) === spec.tier && (/Ryzen/.test(cpu) ? 'AMD' : 'Intel') === spec.vendor) break
  }
  if (tries >= 120) throw new Error(`no ${spec.tier} card with ${spec.vendor} after 120 tries`)
  if (spec.media === 'other') {
    const media = await choose('媒体设备', `(text, index, count) => index > 0 && index < count - 1 && !text.startsWith('自动')`)
    if (media !== true) throw new Error(`media: ${media}`)
  }
  // The name last, on the basic tab.
  await clickText('基础设置', drawer)
  await delay(300)
  await run(`(() => {
    const input = (${rowOf('窗口名称')})?.querySelector('input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${J(spec.name)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await delay(300)
  if (!await clickText('确定创建', drawer)) throw new Error('确定创建 not found')
  await delay(2500)
  const modal = await run(`document.querySelector('.ant-modal-confirm, .ant-modal-wrap:not([style*="display: none"]) .ant-modal')?.innerText.replace(/\\s+/g, ' ').slice(0, 300) ?? ''`)
  if (modal) log('  dialog:', modal)
  const open = await run(`Boolean(document.querySelector('.ant-drawer-open'))`)
  if (open) throw new Error(`drawer still open: ${await run(`${drawer}.innerText.match(/[^\\n]*(请|不能|失败|无效)[^\\n]*/)?.[0] ?? ''`)}`)
  return { tries: tries + 1, gpu, cpu }
}

if (phase === 'create') {
  const proxyHost = arg5
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  await run('location.reload(), true')
  await delay(3000)
  // RESET=1: the round's windows made before go first (to the recycle bin, then emptied).
  if (process.env.RESET === '1') {
    for (const w of (await windows()).filter((item) => item.name.startsWith(`${round}-`))) await run(`window.browserApi.profiles.remove(${J(w.id)}).then(() => true)`)
    await run(`window.browserApi.profiles.emptyTrash().then(() => true, () => false)`)
  }
  // The proxy is checked first, as in a user's library: 新建窗口 then takes the country, time zone and
  // language from its IP.
  const proxies = await run(`window.browserApi.proxy.list().then((list) => list.map((p) => ({ id: p.id, host: p.host })))`)
  const target = proxies.find((p) => p.host === proxyHost)
  if (!target) throw new Error(`no proxy ${proxyHost} in the test library`)
  const checked = await run(`window.browserApi.proxy.check(${J(target.id)}).then((p) => p.check, (e) => ({ ok: false, error: e.message }))`)
  log('proxy check', proxyHost, J({ ok: checked?.ok, ip: checked?.ip, country: checked?.countryCode, city: checked?.city, tz: checked?.timezone, error: checked?.error }))
  if (!checked?.ok) throw new Error('proxy check failed')
  const existing = new Set((await windows()).map((w) => w.name))
  const made = []
  // LIMIT=1: only the first window (to try the screen out before making all).
  for (const spec of plan.slice(0, Number(process.env.LIMIT) || plan.length)) {
    if (existing.has(spec.name)) { log('exists', spec.name); continue }
    try {
      const result = await createOne(spec, proxyHost)
      log('made', spec.name, J(spec), `tries=${result.tries}`)
      made.push(spec.name)
    } catch (error) {
      log('FAIL', spec.name, error.message)
      await run(`(() => { const b = [...document.querySelectorAll('.ant-drawer-open button')].find((n) => n.innerText.trim() === '取消'); b?.click(); return true })()`)
      await delay(800)
    }
  }
  const list = (await windows()).filter((w) => w.name.startsWith(`${round}-`)).sort((a, b) => a.name.localeCompare(b.name))
  await writeFile(join(out, `${round}-windows.json`), J(list.map((w) => ({ id: w.id, name: w.name, kernelVersion: w.kernelVersion, fp: w.fp, plan: plan.find((p) => p.name === w.name) })), null, 2))
  log(`windows of ${round}: ${list.length}`)
}

// ---- run: open each window, visit the sites ------------------------------------------------------
let fpcomGate = Promise.resolve()
/** Fingerprint.com answers 429 when one IP asks too often: one visit a minute for the round. */
function fpcomTurn() {
  const turn = fpcomGate
  fpcomGate = turn.then(() => delay(60_000))
  return turn
}

function cdp(url) {
  const socket = new WebSocket(url)
  let seq = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message.result ?? { error: message.error }); pending.delete(message.id) }
  })
  return new Promise((done, fail) => {
    socket.addEventListener('open', () => done({
      send: (method, params = {}) => new Promise((answer) => { const id = ++seq; pending.set(id, answer); socket.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); answer({ error: 'timeout' }) } }, 60_000) }),
      close: () => socket.close()
    }), { once: true })
    socket.addEventListener('error', () => fail(new Error('cdp failed')), { once: true })
  })
}

async function visitAll(window, label, sites = SITES) {
  const result = { name: window.name, id: window.id, started: new Date().toISOString(), sites: {} }
  // 「不绑定」 is the default the screen shows, so a window made with it is still "not asked": the first
  // opening asks (the dialog's own call, setDeviceBinding).
  if (window.fp.deviceBinding !== 'on' && window.fp.deviceBinding !== 'off') {
    const want = plan.find((p) => p.name === window.name)?.binding ?? 'off'
    await run(`window.browserApi.profiles.setDeviceBinding(${J(window.id)}, ${J(want)}).then(() => true)`)
  }
  const launched = await run(`window.browserApi.profiles.launch(${J(window.id)}).then((p) => p.status, (e) => 'error: ' + e.message)`)
  if (launched !== 'running') { result.error = `launch: ${launched}`; return result }
  const portFile = join(resolve(userData), 'vault', 'profiles', window.id, 'user-data', 'DevToolsActivePort')
  let port
  for (let i = 0; i < 60 && !port; i++) {
    if (existsSync(portFile)) port = Number((await readFile(portFile, 'utf8')).split(/\r?\n/)[0]) || undefined
    if (!port) await delay(500)
  }
  try {
    if (!port) throw new Error('no DevToolsActivePort')
    let page
    for (let i = 0; i < 60 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page') } catch { /* starting */ }
      if (!page) await delay(500)
    }
    if (!page) throw new Error('no page target')
    const tab = await cdp(page.webSocketDebuggerUrl)
    await tab.send('Page.enable')
    for (const [site, url, wait] of sites) {
      if (site === 'fpcom') await fpcomTurn()
      const began = Date.now()
      try {
        await tab.send('Page.navigate', { url })
        await delay(wait)
        await tab.send('Runtime.evaluate', { awaitPromise: true, expression: '(async()=>{for(let y=0;y<document.body.scrollHeight;y+=700){scrollTo(0,y);await new Promise(r=>setTimeout(r,250))}scrollTo(0,0)})()' })
        await delay(3000)
        const text = (await tab.send('Runtime.evaluate', { returnByValue: true, expression: 'document.body ? document.body.innerText : ""' })).result?.value ?? ''
        await writeFile(join(out, `${label}-${site}.txt`), text)
        const shot = await tab.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 })
        if (shot?.data) await writeFile(join(out, `${label}-${site}.jpg`), Buffer.from(shot.data, 'base64'))
        result.sites[site] = { chars: text.length, seconds: Math.round((Date.now() - began) / 1000) }
      } catch (error) {
        result.sites[site] = { error: String(error?.message ?? error) }
      }
    }
    tab.close()
  } catch (error) {
    result.error = String(error?.message ?? error)
  } finally {
    await run(`window.browserApi.profiles.close(${J(window.id)}).then(() => true, () => false)`)
    await delay(3000)
  }
  result.finished = new Date().toISOString()
  return result
}

// setver: windows made before the plan changed get the plan's system version (as 系统版本 in the editor).
if (phase === 'setver') {
  for (const w of (await windows()).filter((item) => item.name.startsWith(`${round}-`))) {
    const want = plan.find((p) => p.name === w.name)?.windows === 'Windows 10' ? '10.0.0' : '19.0.0'
    if (w.fp.platformVersion === want) continue
    const done = await run(`(async () => {
      const profile = (await window.browserApi.profiles.list()).find((p) => p.id === ${J(w.id)})
      const saved = await window.browserApi.profiles.update(profile.id, { ...profile, fingerprint: { ...profile.fingerprint, platformVersion: ${J(want)} } })
      return saved.fingerprint.platformVersion
    })().catch((e) => 'error: ' + e.message)`)
    log('setver', w.name, w.fp.platformVersion, '->', done)
  }
  const list = (await windows()).filter((w) => w.name.startsWith(`${round}-`)).sort((a, b) => a.name.localeCompare(b.name))
  await writeFile(join(out, `${round}-windows.json`), J(list.map((w) => ({ id: w.id, name: w.name, kernelVersion: w.kernelVersion, fp: w.fp, plan: plan.find((p) => p.name === w.name) })), null, 2))
}

// route <node>: the round's windows reach their proxy through this 网络加速 node (as the editor's 手动固定).
if (phase === 'route') {
  const node = arg5
  for (const w of (await windows()).filter((item) => item.name.startsWith(`${round}-`))) {
    const done = await run(`(async () => {
      const profile = (await window.browserApi.profiles.list()).find((p) => p.id === ${J(w.id)})
      const saved = await window.browserApi.profiles.update(profile.id, { ...profile, tunnel: { enabled: true, mode: 'manual', node: ${J(node)} } })
      return JSON.stringify(saved.tunnel ?? saved.proxy?.tunnel)
    })().catch((e) => 'error: ' + e.message)`)
    log('route', w.name, done)
  }
}

if (phase === 'run' || phase === 'reopen') {
  const all = (await windows()).filter((w) => w.name.startsWith(`${round}-`)).sort((a, b) => a.name.localeCompare(b.name))
  const only = phase === 'reopen' ? arg5 : arg6
  const concurrency = phase === 'reopen' ? 3 : Number(arg5) || 5
  const finished = (w) => SITES.every(([site]) => existsSync(join(out, `${w.name}-${site}.txt`)))
  const chosen = (only ? all.filter((w) => only.split(',').some((key) => w.name.endsWith(key))) : all).filter((w) => phase === 'reopen' || process.env.FORCE === '1' || !finished(w))
  const sites = phase === 'reopen' ? SITES.filter(([site]) => ['fpcom', 'creepjs'].includes(site)) : SITES
  log(`${phase} ${chosen.length} windows of ${round}, ${concurrency} at a time, ${sites.length} sites each`)
  const results = []
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < chosen.length) {
      const window = chosen[next++]
      const label = phase === 'reopen' ? `${window.name}-reopen` : window.name
      log('open', label)
      const result = await visitAll(window, label, sites)
      results.push(result)
      log('done', label, result.error ?? '', Object.entries(result.sites).filter(([, value]) => value.error).map(([site]) => site).join(',') || 'all sites ok')
      await writeFile(join(out, `${round}-${phase}-results-${process.pid}.json`), J(results, null, 2))
    }
  }))
  log(`${phase} finished: ${results.length} windows`)
}

await quitApp(instance)
process.exit(0)
