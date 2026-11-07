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
 *   NODES=nodes.json (node names): create's windows each on a subscription node, picked in 新建窗口
 *   SITES_ONLY=fpcom,creepjs: run visits only these sites
 *
 * round: a name (mx, hk). The windows of a round are named "<round>-w01" … "<round>-w20".
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

// Pages only asked for by name (SITES_ONLY): tzprobe reads the time zone the way a page can, every way.
const EXTRA = [['tzprobe', 'about:blank', 1000]]
const TZ_PROBE = `(() => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const months = Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(2026, m, 15, 12)).getTimezoneOffset())
  // The day the offset changes, both ways, in 2026 (hour by hour).
  const changes = []
  let last = new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset()
  for (let h = 0; h < 365 * 24; h++) {
    const d = new Date(Date.UTC(2026, 0, 1, h))
    const o = d.getTimezoneOffset()
    if (o !== last) { changes.push(d.toISOString() + ' ' + last + '->' + o); last = o }
  }
  const sample = new Date(Date.UTC(2026, 10, 7, 12, 0, 0))
  const intlOffset = (date) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(date).find((x) => x.type === 'timeZoneName')?.value; return p }
  return JSON.stringify({
    zone, locale: Intl.DateTimeFormat().resolvedOptions().locale, months, changes,
    intlOffsetJan: intlOffset(new Date(Date.UTC(2026, 0, 15))), intlOffsetJul: intlOffset(new Date(Date.UTC(2026, 6, 15))),
    toString: sample.toString(), toTimeString: sample.toTimeString(), toLocaleString: sample.toLocaleString(),
    longName: new Intl.DateTimeFormat(undefined, { timeZoneName: 'long' }).format(sample),
    shortName: new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).format(sample),
    nowOffset: new Date().getTimezoneOffset(), languages: navigator.languages, language: navigator.language
  }, null, 1)
})()`

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
async function choose(row, test, nth = 0, search = '') {
  const opened = await run(`(() => {
    const row = ${rowOf(row)}
    const select = row?.querySelectorAll('.ant-select')[${nth}]
    if (!select) return false
    select.querySelector('.ant-select-selector, .ant-select-content')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    // A long list shows only the options in view: typed text narrows it (showSearch selects).
    const input = ${J(search)} && select.querySelector('input')
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${J(search)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
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
  if (spec.node) {
    // 代理方式「订阅」: the subscription, then the node by its name (checked before, so the window takes
    // its country, time zone and language from the node's exit IP).
    if (!await clickText('订阅', drawer)) throw new Error('订阅 mode not found')
    await delay(500)
    const source = await choose('选择订阅', `(text) => text.startsWith('订阅')`)
    if (source !== true) throw new Error(`subscription: ${source}`)
    await delay(600)
    const node = await choose('选择节点', `(text) => text.includes(${J(spec.node)})`, 0, spec.node)
    if (node !== true) throw new Error(`node: ${node}`)
    await delay(4000)
  } else {
    if (!await clickText('从代理库选择', drawer)) throw new Error('从代理库选择 not found')
    await delay(400)
    const proxy = await choose('选择代理', `(text) => text.includes(${J(proxyHost)})`)
    if (proxy !== true) throw new Error(`proxy: ${proxy}`)
    await delay(2500)
  }
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
  // NODES=<file.json> (a list of node names): window n uses node n of the subscription 订阅 instead of
  // the library proxy, each node checked first.
  const nodeNames = process.env.NODES ? JSON.parse(await readFile(process.env.NODES, 'utf8')) : null
  if (nodeNames) {
    nodeNames.forEach((node, index) => { if (plan[index]) plan[index].node = node })
    for (const node of nodeNames) {
      const checked = await run(`(async () => {
        const status = await window.browserApi.subscriptions.status()
        const found = status.nodes.find((n) => n.name.includes(${J(node)}))
        if (!found) return { ok: false, error: 'no node' }
        const source = status.sources.find((s) => s.id === found.sourceId)
        const short = found.name.startsWith(source.name + ' · ') ? found.name.slice(source.name.length + 3) : found.name
        const entry = await window.browserApi.subscriptions.nodeProxy({ source: source.name, node: short })
        return (await window.browserApi.proxy.check(entry.id)).check
      })().catch((e) => ({ ok: false, error: e.message }))`)
      log('node check', node, J({ ok: checked?.ok, country: checked?.countryCode, tz: checked?.timezone, error: checked?.error }))
    }
  } else {
    const proxies = await run(`window.browserApi.proxy.list().then((list) => list.map((p) => ({ id: p.id, host: p.host })))`)
    const target = proxies.find((p) => p.host === proxyHost)
    if (!target) throw new Error(`no proxy ${proxyHost} in the test library`)
    const checked = await run(`window.browserApi.proxy.check(${J(target.id)}).then((p) => p.check, (e) => ({ ok: false, error: e.message }))`)
    log('proxy check', proxyHost, J({ ok: checked?.ok, ip: checked?.ip, country: checked?.countryCode, city: checked?.city, tz: checked?.timezone, error: checked?.error }))
    if (!checked?.ok) throw new Error('proxy check failed')
  }
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
  // (「不绑定」 chosen is stored as no value; only 'ask' is the question still open.)
  if (window.fp.deviceBinding === 'ask') {
    const want = plan.find((p) => p.name === window.name)?.binding ?? 'off'
    await run(`window.browserApi.profiles.setDeviceBinding(${J(window.id)}, ${J(want)}).then(() => true)`)
  }
  // FRESH=1: the window opens with an empty data folder (the same settings and seed, nothing a site
  // stored before); its own folder is kept aside and put back after.
  const dataDir = join(resolve(userData), 'vault', 'profiles', window.id, 'user-data')
  const keptDir = `${dataDir}.kept`
  // A folder already kept aside is a window's own data from a visit that did not put it back: never overwrite it.
  if (process.env.FRESH === '1' && existsSync(keptDir)) return { ...result, error: `FRESH: ${keptDir} is still there, put it back first` }
  if (process.env.FRESH === '1' && existsSync(dataDir)) { await rename(dataDir, keptDir); await mkdir(dataDir) }
  // A window closed by force keeps the port file of its old browser: read only the new one.
  await rm(join(dataDir, 'DevToolsActivePort'), { force: true })
  // ALLOW_GEO=1: the window's time zone stays as it was on purpose (control tests change only the IP).
  const launchOptions = process.env.ALLOW_GEO === '1' ? ', { allowGeoConflict: true }' : ''
  const launched = await run(`window.browserApi.profiles.launch(${J(window.id)}${launchOptions}).then((p) => p.status, (e) => 'error: ' + e.message)`)
  // FRESH: the window's own data folder goes back whatever happens to this visit.
  const restore = async () => {
    if (process.env.FRESH !== '1' || !existsSync(keptDir)) return
    for (let i = 0; i < 10; i++) {
      try { await rm(dataDir, { recursive: true, force: true }); await rename(keptDir, dataDir); return } catch { await delay(2000) }
    }
    log('FRESH: could not put back', dataDir)
  }
  if (launched !== 'running') { result.error = `launch: ${launched}`; await restore(); return result }
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
        if (site === 'tzprobe') {
          const text = (await tab.send('Runtime.evaluate', { returnByValue: true, expression: TZ_PROBE })).result?.value ?? ''
          await writeFile(join(out, `${label}-${site}.txt`), text)
          result.sites[site] = { chars: text.length, seconds: Math.round((Date.now() - began) / 1000) }
          continue
        }
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
    await restore()
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

// clone <spec.json>: control-variable windows: a copy of a window of the round with one thing changed,
// as a NEW window (its own data folder: Fingerprint.com also remembers a visitor by its storage).
// spec: [{ source: "w09", name: "c2", note: "...", fingerprint: { … }, kernelVersion?: "…" }]
if (phase === 'clone') {
  const specs = JSON.parse(await readFile(arg5, 'utf8'))
  const all = await windows()
  for (const spec of specs) {
    const name = `${round}-${spec.name}`
    if (all.some((w) => w.name === name)) { log('exists', name); continue }
    const made = await run(`(async () => {
      const source = (await window.browserApi.profiles.list()).find((p) => p.name === ${J(`${round}-${spec.source}`)})
      const fingerprint = { ...source.fingerprint, ...${J(spec.fingerprint ?? {})} }
      const draft = { ...source, name: ${J(name)}, note: ${J(spec.note ?? '')}, fingerprint, kernelVersion: ${J(spec.kernelVersion ?? null)} ?? source.kernelVersion }
      delete draft.id
      const created = await window.browserApi.profiles.create(draft)
      return JSON.stringify({ id: created.id, kernel: created.kernelVersion, seed: created.fingerprint.seed, cpu: created.fingerprint.cpu, hc: created.fingerprint.hardwareConcurrency, gpu: created.fingerprint.gpu, mem: created.fingerprint.deviceMemory, screen: created.fingerprint.screenWidth + 'x' + created.fingerprint.screenHeight, binding: created.fingerprint.deviceBinding })
    })().catch((e) => 'error: ' + e.message)`)
    log('clone', name, 'from', spec.source, made)
    if (spec.node && !String(made).startsWith('error')) {
      // 代理方式「订阅」: the node by part of its name, reached directly (no 网络加速).
      const routed = await run(`(async () => {
        const status = await window.browserApi.subscriptions.status()
        const node = status.nodes.find((n) => n.name.includes(${J(spec.node)}))
        if (!node) return 'no node ' + ${J(spec.node)}
        const source = status.sources.find((s) => s.id === node.sourceId)
        const short = node.name.startsWith(source.name + ' · ') ? node.name.slice(source.name.length + 3) : node.name
        const entry = await window.browserApi.subscriptions.nodeProxy({ source: source.name, node: short })
        const id = JSON.parse(${J(made)}).id
        await window.browserApi.profiles.assignMany([id], { proxyId: entry.id })
        const profile = (await window.browserApi.profiles.list()).find((p) => p.id === id)
        await window.browserApi.profiles.update(id, { ...profile, tunnel: { enabled: false, mode: 'auto' } })
        return node.name + ' exit ' + (node.exitIp ?? '?')
      })().catch((e) => 'error: ' + e.message)`)
      log('  node', name, routed)
    }
  }
  const list = (await windows()).filter((w) => w.name.startsWith(`${round}-`)).sort((a, b) => a.name.localeCompare(b.name))
  await writeFile(join(out, `${round}-windows.json`), J(list.map((w) => ({ id: w.id, name: w.name, kernelVersion: w.kernelVersion, fp: w.fp, plan: plan.find((p) => p.name === w.name) })), null, 2))
}

// renode <spec.json>: [{ window: "w05", node: "美国 10" }]: the window moves to that subscription node
// (reached directly, no 网络加速); everything else about it stays.
// spec.window may name another round's window ("tt-w02"); spec.geoFrom (a full window name) gives the
// window that window's country, time zone and languages (read before any window here changes).
const GEO_KEYS = ['networkIdentityMode', 'region', 'regionSource', 'timezone', 'language', 'acceptLanguages', 'location', 'uiLocale', 'voicesLocale', 'mediaLocale', 'keyboardLayout']
if (phase === 'renode') {
  const specs = JSON.parse(await readFile(arg5, 'utf8'))
  const donors = {}
  // spec.langFrom (a full window name): only that window's languages (not its country or time zone).
  const LANG_KEYS = ['language', 'acceptLanguages', 'uiLocale', 'voicesLocale', 'mediaLocale', 'keyboardLayout']
  for (const spec of specs.filter((item) => item.langFrom)) {
    const langs = await run(`window.browserApi.profiles.list().then((list) => { const f = list.find((p) => p.name === ${J(spec.langFrom)})?.fingerprint; return f ? Object.fromEntries(${J(LANG_KEYS)}.map((k) => [k, f[k]])) : null })`)
    log('languages of', spec.langFrom, J(langs))
    spec.fingerprint = { ...(langs ?? {}), ...(spec.fingerprint ?? {}) }
  }
  for (const spec of specs.filter((item) => item.geoFrom)) {
    donors[spec.geoFrom] = await run(`window.browserApi.profiles.list().then((list) => { const f = list.find((p) => p.name === ${J(spec.geoFrom)})?.fingerprint; return f ? Object.fromEntries(${J(GEO_KEYS)}.map((k) => [k, f[k]])) : null })`)
    log('geo of', spec.geoFrom, J(donors[spec.geoFrom] && { region: donors[spec.geoFrom].region, timezone: donors[spec.geoFrom].timezone, language: donors[spec.geoFrom].language }))
  }
  for (const spec of specs) {
    const name = spec.window.includes('-') ? spec.window : `${round}-${spec.window}`
    const geo = spec.geoFrom ? donors[spec.geoFrom] : null
    const done = await run(`(async () => {
      const profile = (await window.browserApi.profiles.list()).find((p) => p.name === ${J(name)})
      if (!profile) return 'no window'
      const status = await window.browserApi.subscriptions.status()
      const node = status.nodes.find((n) => n.name.includes(${J(spec.node)}))
      if (!node) return 'no node'
      const source = status.sources.find((s) => s.id === node.sourceId)
      const short = node.name.startsWith(source.name + ' · ') ? node.name.slice(source.name.length + 3) : node.name
      const entry = await window.browserApi.subscriptions.nodeProxy({ source: source.name, node: short })
      const checked = await window.browserApi.proxy.check(entry.id).then((p) => p.check, () => undefined)
      await window.browserApi.profiles.assignMany([profile.id], { proxyId: entry.id })
      const fresh = (await window.browserApi.profiles.list()).find((p) => p.id === profile.id)
      const geo = ${J(geo)}
      // spec.fingerprint: one setting changed on purpose (seed, gpu …) for a control test.
      const fingerprint = { ...fresh.fingerprint, ...(geo ?? {}), ...${J(spec.fingerprint ?? {})} }
      // spec.kernelVersion: the same window on another kernel (155 / 156 comparisons).
      const kernelVersion = ${J(spec.kernelVersion ?? null)} ?? fresh.kernelVersion
      const saved = await window.browserApi.profiles.update(profile.id, { ...fresh, kernelVersion, fingerprint, tunnel: { enabled: false, mode: 'auto' } })
      return 'ok ' + saved.kernelVersion + ' off=' + (saved.fingerprint.disabledSpoofing ?? []).join('+') + ' ' + (checked?.countryCode ?? '?') + ' ' + (checked?.timezone ?? '?') + ' window ' + saved.fingerprint.region + ' ' + saved.fingerprint.timezone + ' ' + saved.fingerprint.language + ' seed ' + saved.fingerprint.seed + ' gpu ' + saved.fingerprint.gpu + ' hc ' + saved.fingerprint.hardwareConcurrency + ' mem ' + saved.fingerprint.deviceMemory + ' screen ' + saved.fingerprint.screenWidth + 'x' + saved.fingerprint.screenHeight
    })().catch((e) => 'error: ' + e.message)`)
    log('renode', name, done)
  }
}

// checks: the proxy check each window of the round keeps (the one its country and time zone came from),
// without its IP, to <out>/<round>-checks.txt.
if (phase === 'checks') {
  const text = await run(`window.browserApi.profiles.list().then((list) => list.filter((p) => p.name.startsWith(${J(`${round}-`)})).sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const c = p.proxyCheck ?? {}
    const keep = Object.fromEntries(Object.entries(c).filter(([k]) => !/^(ip|ipv6|host|address)$/i.test(k)))
    return p.name + ' window ' + p.fingerprint.region + ' ' + p.fingerprint.timezone + ' | check ' + JSON.stringify(keep)
  }).join('\\n'))`)
  await writeFile(join(out, `${round}-checks.txt`), text)
  log('checks written')
}

// nodes: the subscription nodes the test launcher has, with exit IPs (written to <out>/nodes.txt).
if (phase === 'nodes') {
  await delay(15000)
  const nodes = await run(`window.browserApi.subscriptions.status().then((st) => st.nodes.map((n) => n.name + ' | ' + n.type + ' | ' + (n.exitIp ?? '-') + ' | ' + (n.delay ?? '-')).join('\\n'))`)
  await writeFile(join(out, 'nodes.txt'), nodes)
  log('nodes', nodes.split('\n').length)
}

// route <node>: the round's windows reach their proxy through this 网络加速 node (as the editor's 手动固定).
if (phase === 'route') {
  // The node by part of its name (an ASCII argument survives the Windows command line).
  const node = await run(`window.browserApi.tunnel.status().then((st) => st.nodes.map((n) => n.name).find((n) => n.includes(${J(arg5)})) ?? '')`)
  if (!node) throw new Error(`no 网络加速 node with ${arg5}`)
  log('route node', node)
  for (const w of (await windows()).filter((item) => item.name.startsWith(`${round}-`))) {
    const done = await run(`(async () => {
      const profile = (await window.browserApi.profiles.list()).find((p) => p.id === ${J(w.id)})
      const saved = await window.browserApi.profiles.update(profile.id, { ...profile, tunnel: { enabled: true, mode: 'manual', node: ${J(node)} } })
      return JSON.stringify(saved.tunnel ?? saved.proxy?.tunnel)
    })().catch((e) => 'error: ' + e.message)`)
    log('route', w.name, done)
  }
}

// ---- geo: what each window of the round was set to, next to its proxy's last check (no IPs) ------
if (phase === 'geo') {
  const list = (await windows()).filter((w) => w.name.startsWith(`${round}-`)).sort((a, b) => a.name.localeCompare(b.name))
  const proxies = await run(`window.browserApi.proxy.list().then((list) => list.map((p) => ({ id: p.id, name: p.subscription?.node ?? p.remark ?? '', check: p.check && { ok: p.check.ok, country: p.check.countryCode, tz: p.check.timezone, geo: p.check.geoConfidence, by: p.check.countryBy, tzBy: p.check.timezoneBy, votes: (p.check.countryVotes ?? []).map((v) => v.countryCode + ':' + v.sources.length + ':' + (v.timezone ?? '-')).join(' ') } })))`)
  const rows = list.map((w) => {
    const proxy = proxies.find((p) => p.id === w.proxyId)
    return { window: w.name, node: proxy?.name, windowCountry: w.fp.region, windowZone: w.fp.timezone, language: w.fp.language, fromIp: w.fp.regionSource === 'ip', check: proxy?.check }
  })
  for (const row of rows) log(J(row))
  await writeFile(join(out, `${round}-geo.json`), J(rows, null, 2))
}

// ---- deep: the launcher's own 深度检测 for one window (arg5 = the end of its name), IPs masked -----
if (phase === 'deep') {
  const target = (await windows()).find((w) => w.name.startsWith(`${round}-`) && w.name.endsWith(arg5))
  if (!target) throw new Error(`no window ending ${arg5}`)
  // Started and then polled: one renderer call may take at most 30 s, the five sites take minutes.
  await run(`(() => {
    window.__deepDone = undefined
    window.browserApi.profiles.list().then((list) => {
      const profile = list.find((p) => p.id === ${J(target.id)})
      return window.browserApi.profiles.deepCheck(profile, profile.id)
    }).then(async (results) => {
      // The screenshot's size in pixels (a whole page is taller than the window).
      const size = (src) => src ? new Promise((done) => { const img = new Image(); img.onload = () => done(img.naturalWidth + 'x' + img.naturalHeight); img.onerror = () => done('?'); img.src = src }) : ''
      window.__deepDone = await Promise.all(results.map(async (r) => ({ site: r.site, status: r.status, score: r.score, findings: r.findings, error: r.error, shotKb: r.screenshot ? Math.round(r.screenshot.length * 3 / 4 / 1024) : 0, shotPx: await size(r.screenshot) })))
    },
      (error) => { window.__deepDone = [{ site: 'all', status: 'error', findings: [], error: error.message }] })
    return true
  })()`)
  let results
  for (let i = 0; i < 90 && !results; i++) {
    await delay(10_000)
    results = await run('window.__deepDone ?? null')
  }
  if (!results) throw new Error('deep check did not finish in 15 minutes')
  const mask = (text) => String(text ?? '').replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, 'x.x.x.x').replace(/\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}\b/gi, 'x:x::x')
  for (const r of results) log(r.site, r.status, mask(r.score), mask(r.findings.join(' ; ')), mask(r.error), `shot ${r.shotKb} KB ${r.shotPx ?? ''}`)
  await writeFile(join(out, `${round}-deep-${arg5}.json`), mask(J(results, null, 2)))
}

if (phase === 'run' || phase === 'reopen') {
  const all = (await windows()).filter((w) => w.name.startsWith(`${round}-`)).sort((a, b) => a.name.localeCompare(b.name))
  const only = phase === 'reopen' ? arg5 : arg6
  const concurrency = phase === 'reopen' ? 3 : Number(arg5) || 5
  // SITES_ONLY=fpcom,creepjs: only these sites (the other phases' quick checks).
  const sites = phase === 'reopen' ? SITES.filter(([site]) => ['fpcom', 'creepjs'].includes(site))
    : process.env.SITES_ONLY ? [...SITES, ...EXTRA].filter(([site]) => process.env.SITES_ONLY.split(',').includes(site)) : SITES
  const finished = (w) => sites.every(([site]) => existsSync(join(out, `${w.name}-${site}.txt`)))
  const chosen = (only ? all.filter((w) => only.split(',').some((key) => w.name.endsWith(key))) : all).filter((w) => phase === 'reopen' || process.env.FORCE === '1' || !finished(w))
  log(`${phase} ${chosen.length} windows of ${round}, ${concurrency} at a time, ${sites.length} sites each`)
  const results = []
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < chosen.length) {
      const window = chosen[next++]
      // LABEL=<word>: the reopen's pages are saved as <window>-<word>-<site> (default "reopen").
      const label = phase === 'reopen' && !/-c\d+$/.test(window.name) ? `${window.name}-${process.env.LABEL || 'reopen'}` : window.name
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
