#!/usr/bin/env node
/**
 * A new window picking a library proxy that was checked before takes that IP's country (time zone,
 * languages) without a check of its own, and shows that check and its IP 评分 (the proxy's latest,
 * shared by every window on it); typing the same proxy does too, and so does the proxy's edit form
 * on the 代理 IP page. A country picked by hand first stays, with the mismatch pointed out. The
 * language rows say what they follow (国家 · language · code).
 *
 *   npm run build && node tools/app-e2e/library-country.mjs [screenshot folder]        (Linux: xvfb-run -a …)
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const userData = await mkdtemp(join(tmpdir(), 'prism-library-country-'))
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const failures = []
const check = (ok, message) => { console.log(ok ? 'ok  ' : 'FAIL', message); if (!ok) failures.push(message) }
const shots = process.argv[2] ? resolve(process.argv[2]) : undefined
if (shots) await mkdir(shots, { recursive: true })

// First run: three library proxies; two get a check as the 代理 IP page would have saved it.
let instance = await launchApp({ app }, userData)
let ids
try {
  const run = (expression) => evaluate(instance.client, expression)
  ids = {}
  for (const [name, host] of [['mx', '198.51.100.31'], ['us', '198.51.100.32'], ['none', '198.51.100.33'], ['fb', '198.51.100.34'], ['noscore', '198.51.100.35'], ['shot', '198.51.100.36']]) {
    ids[name] = await run(`window.browserApi.proxy.create({ protocol: 'socks5', host: '${host}', port: 1080, username: 'a', password: 'b', note: '${name}' }).then((proxy) => proxy.id)`)
  }
} finally {
  await quitApp(instance)
}
const file = join(userData, 'vault', 'profiles.json')
const stored = JSON.parse(await readFile(file, 'utf8'))
const checkedAt = new Date(Date.now() - 3600_000).toISOString()
const result = (countryCode, country, timezone, latitude, longitude) => ({
  ok: true, latencyMs: 120, ip: '203.0.113.9', countryCode, country, timezone, latitude, longitude, checkedAt
})
for (const proxy of stored.proxies) {
  if (proxy.id === ids.mx) {
    proxy.check = result('MX', 'Mexico', 'America/Mexico_City', 19.43, -99.13)
    proxy.ipSites = { checkedAt, checkIp: '203.0.113.9', baseline: { site: 'iplark', name: 'IPLark', url: 'https://iplark.com/', ip: '203.0.113.9', score: '82', scoreOf: '100', scoreKind: 'quality', countryCode: 'MX' } }
  }
  if (proxy.id === ids.us) proxy.check = result('US', 'United States', 'America/Chicago', 41.88, -87.63)
  // IPLark timed out, ping0.cc was read: ping0's verdicts are shown.
  if (proxy.id === ids.fb) {
    proxy.check = result('MX', 'Mexico', 'America/Mexico_City', 19.43, -99.12)
    proxy.ipSites = {
      checkedAt, checkIp: '203.0.113.9',
      baseline: { site: 'iplark', name: 'IPLark', url: 'https://iplark.com/', error: '页面 30 秒内没出结果（代理太慢、网站要求验证，或页面改版）' },
      other: { site: 'ping0', name: 'ping0.cc', url: 'https://ping0.cc/', ip: '203.0.113.9', score: '13%', scoreKind: 'risk', scoreNote: '极度纯净', country: '墨西哥', company: 'Podernet', usage: 'residential', usageText: '家庭宽带 IP', native: true, nativeText: '原生 IP' }
    }
  }
  const timedOut = { site: 'iplark', name: 'IPLark', url: 'https://iplark.com/', error: '页面 30 秒内没出结果（代理太慢、网站要求验证，或页面改版）' }
  // The other site gave no score this time, only the rest.
  if (proxy.id === ids.noscore) {
    proxy.check = result('MX', 'Mexico', 'America/Mexico_City', 19.43, -99.12)
    proxy.ipSites = { checkedAt, checkIp: '203.0.113.9', baseline: timedOut, other: { site: 'ping0', name: 'ping0.cc', url: 'https://ping0.cc/', ip: '203.0.113.9', country: '墨西哥', company: 'Podernet', usage: 'residential', usageText: '家庭宽带 IP', native: true, nativeText: '原生 IP' } }
  }
  // The other site is one the user added: only its page.
  if (proxy.id === ids.shot) {
    proxy.check = result('MX', 'Mexico', 'America/Mexico_City', 19.43, -99.12)
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    proxy.ipSites = { checkedAt, checkIp: '203.0.113.9', baseline: timedOut, other: { site: 'mine', name: 'MyCheck', url: 'https://example.com/', screenshot: pixel } }
  }
}
await writeFile(file, JSON.stringify(stored))

instance = await launchApp({ app }, userData)
try {
  const run = (expression) => evaluate(instance.client, expression)
  await instance.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await run(`window.browserApi.uiLanguage.set('zh-CN').then(() => true)`)
  await run('location.reload(), true')
  await delay(2500)
  const drawer = `document.querySelector('.ant-drawer-open')`
  const click = (text, scope = 'document') => run(`(() => {
    const target = [...(${scope}).querySelectorAll('button, [role="tab"], .ant-tabs-tab, label, .ant-radio-button-wrapper')].find((node) => node.innerText?.trim() === ${JSON.stringify(text)})
    if (!target) return false
    target.click()
    return true
  })()`)
  const row = (label) => `[...${drawer}.querySelectorAll('.fb-form-row')].find((node) => node.querySelector('.fb-form-label')?.innerText.trim().startsWith(${JSON.stringify(label)}))`
  const rowText = (label) => run(`(() => { const found = ${row(label)}; return found ? found.innerText.replace(/\\s+/g, ' ').trim() : 'no row' })()`)
  const choose = async (label, text) => {
    await run(`(() => { ${row(label)}.querySelector('.ant-select').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
    await delay(300)
    // The list only draws the options in view: search for the one wanted.
    if (await run(`(() => { const input = ${row(label)}.querySelector('input'); if (!input || input.readOnly) return false; input.focus(); return true })()`)) {
      await instance.client.send('Input.insertText', { text })
    }
    await delay(500)
    const chosen = await run(`(() => {
      const option = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((node) => node.innerText.includes(${JSON.stringify(text)}))
      if (!option) return false
      option.click()
      return true
    })()`)
    await delay(500)
    if (!chosen) failures.push(`no option ${text} in ${label}`)
  }
  const tab = async (name) => { await click(name, drawer); await delay(500) }
  const openNew = async () => {
    if (!await click('新建窗口')) failures.push('新建窗口 not found')
    await delay(900)
  }
  const pickProxy = async (host) => {
    await tab('代理设置')
    await click('从代理库选择', drawer)
    await delay(300)
    await choose('选择代理', host)
  }
  const proxyCard = () => run(`${drawer}.innerText.replace(/\\s+/g, ' ')`)
  // The exit IP card (below 出口 IP): the proxy's latest check, marked as shared, with its IP 评分.
  const exitCard = async () => { const text = await proxyCard(); return text.slice(text.indexOf('出口 IP')) }
  const shot = async (name) => {
    if (!shots) return
    await run(`(() => { document.querySelector('.fb-ip-card-wrap')?.scrollIntoView({ block: 'center' }); return true })()`)
    await delay(400)
    const image = await instance.client.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(shots, name), Buffer.from(image.data, 'base64'))
  }

  // 1. Nothing picked by hand: the checked proxy's country fills the window.
  await openNew()
  await pickProxy('198.51.100.31')
  const mx = await rowText('网络身份')
  check(mx.includes('基于 IP 生成') && mx.includes('墨西哥') && mx.includes('America/Mexico_City'), `墨西哥代理 → ${mx}`)
  await delay(800)
  const shared = await exitCard()
  check(shared.includes('203.0.113.9') && shared.includes('代理 IP 库里这个代理最近一次的检测'), `shared check shown: ${shared.slice(0, 300)}`)
  check(/评分\s*82|82\s*\/\s*100|\b82\b/.test(shared), `shared IP 评分 shown: ${shared.slice(0, 400)}`)
  await shot('exit-card-editor.png')
  await tab('指纹设置')
  const region = await rowText('国家/地区')
  check(region.includes('按代理库上次检测的 IP 配好'), `country hint: ${region}`)
  const ui = await rowText('系统语言')
  check(/墨西哥 · [^·]+ · es-419/.test(ui), `系统语言: ${ui}`)
  for (const label of ['语音', '媒体设备名']) {
    const text = await rowText(label)
    check(/墨西哥 · ([^·]+ · )?es-mx/.test(text), `${label}: ${text}`)
  }

  // 2. Another checked proxy: the country follows it.
  await pickProxy('198.51.100.32')
  const us = await rowText('网络身份')
  check(us.includes('基于 IP 生成') && us.includes('美国') && us.includes('America/Chicago'), `美国代理 → ${us}`)
  // Checked but no IP 评分 kept (checked where none was read): it is read now, without a click.
  let usCard = ''
  for (let i = 0; i < 20 && !/正在用这个窗口打开检测网站读取|没读到|重新读取/.test(usCard); i++) { await delay(300); usCard = await exitCard() }
  check(/正在用这个窗口打开检测网站读取|没读到|重新读取/.test(usCard) && !usCard.includes('基础信息格式无效'), `IP 评分 read by itself for a checked proxy without one: ${usCard.slice(0, 300)}`)

  // 3. A proxy never checked: the country stays, with a hint to check it.
  await pickProxy('198.51.100.33')
  const none = await rowText('网络身份')
  check(none.includes('美国'), `未检测代理 → ${none}`)
  await tab('指纹设置')
  const noneHint = await rowText('国家/地区')
  check(noneHint.includes('这个代理还没检测，检测后按 IP 配'), `未检测代理 hint: ${noneHint}`)

  // 4. The system language picked on its own: the rows under it say they follow it.
  await choose('系统语言', 'Deutsch')
  const voices = await rowText('语音')
  check(voices.includes('跟随系统语言') && voices.includes('de-de'), `语音 after picking German system language: ${voices}`)
  await click('取 消', drawer) || await click('取消', drawer)
  await delay(800)

  // 5. A country picked by hand first stays; the mismatch is pointed out.
  await openNew()
  await tab('指纹设置')
  await choose('国家/地区', '日本')
  const manual = await rowText('系统语言')
  check(manual.includes('日本 · 日本語 · ja'), `手动日本 系统语言: ${manual}`)
  await pickProxy('198.51.100.31')
  const kept = await rowText('网络身份')
  check(kept.includes('手动选择') && kept.includes('日本'), `手动日本 then 墨西哥代理 → ${kept}`)
  await tab('指纹设置')
  const alert = await run(`${drawer}.innerText.includes('代理 IP 在墨西哥，窗口是日本')`)
  check(alert, 'mismatch alert shown')
  await click('取 消', drawer) || await click('取消', drawer)
  await delay(800)

  // 6. The same proxy typed (pasted) into a new window: the library entry's latest check shows.
  await openNew()
  await tab('代理设置')
  await run(`(() => { const box = ${drawer}.querySelector('textarea.fb-paste'); box.focus(); return true })()`)
  await instance.client.send('Input.insertText', { text: 'socks5://a:b@198.51.100.31:1080' })
  await delay(1500)
  const typed = await exitCard()
  check(typed.includes('203.0.113.9') && typed.includes('代理 IP 库里这个代理最近一次的检测'), `typed library proxy shows its check: ${typed.slice(0, 300)}`)
  await click('取 消', drawer) || await click('取消', drawer)
  await delay(800)

  // 7. The 代理 IP page's edit form opens with the proxy's latest check and IP 评分.
  await run(`(() => { const item = [...document.querySelectorAll('.fb-sidebar .fb-nav-item')].find((node) => node.innerText?.trim().startsWith('代理 IP')); item?.click(); return Boolean(item) })()`)
  await delay(1200)
  const opened = await run(`(() => {
    const line = [...document.querySelectorAll('tr')].find((node) => node.innerText.includes('198.51.100.31'))
    const edit = line && [...line.querySelectorAll('button')].find((node) => node.innerText.trim() === '编辑')
    edit?.click()
    return Boolean(edit)
  })()`)
  check(opened, 'edit form of the checked proxy opened')
  await delay(1500)
  const form = await run(`(document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal') ?? document.body).innerText.replace(/\s+/g, ' ')`)
  const formExit = form.slice(form.indexOf('出口 IP'))
  check(formExit.includes('203.0.113.9') && formExit.includes('检测于') && !formExit.includes('还没检测'), `edit form shows the check: ${formExit.slice(0, 300)}`)
  check(/\b82\b/.test(formExit), `edit form shows the IP 评分: ${formExit.slice(0, 400)}`)
  await shot('exit-card-proxy-form.png')
  // Narrow (the form): IP 评分 below the IP, the IP's details as wide as the card.
  const layout = await run(`(() => { const row = document.querySelector('.ant-modal .fb-ip-card-row'); const aside = row?.querySelector('.fb-ip-card-aside'); const card = row?.querySelector('.fb-ip-card'); return row && aside && card ? { stacked: aside.getBoundingClientRect().top >= card.getBoundingClientRect().bottom - 1, cardWidth: Math.round(card.getBoundingClientRect().width), rowWidth: Math.round(row.getBoundingClientRect().width) } : null })()`)
  check(layout?.stacked && layout.cardWidth >= layout.rowWidth - 4, `proxy form exit card stacks: ${JSON.stringify(layout)}`)
  await click('取 消') || await click('取消')
  await delay(800)

  // 8. The edit form reads IP 评分 itself (it used to fail before reading: 浏览器环境基础信息格式无效).
  await run(`(() => {
    const line = [...document.querySelectorAll('tr')].find((node) => node.innerText.includes('198.51.100.32'))
    const edit = line && [...line.querySelectorAll('button')].find((node) => node.innerText.trim() === '编辑')
    edit?.click()
    return Boolean(edit)
  })()`)
  await delay(1500)
  const modal = `(document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal') ?? document.body)`
  const asked = await run(`(() => { const button = [...${modal}.querySelectorAll('button')].find((node) => ['读取 IP 评分', '重新读取'].includes(node.innerText.trim())); button?.click(); return Boolean(button) })()`)
  check(asked, 'edit form offers 读取 IP 评分')
  let formScore = ''
  for (let i = 0; i < 30; i++) {
    await delay(500)
    formScore = await run(`${modal}.innerText.replace(/\\s+/g, ' ')`)
    if (!formScore.includes('正在用这个窗口打开检测网站读取')) break
  }
  check(!formScore.includes('基础信息格式无效'), `edit form reading gets past the draft check: ${formScore.slice(formScore.indexOf('出口 IP'), formScore.indexOf('出口 IP') + 300)}`)
  await click('取 消') || await click('取消')
  await delay(800)

  // 9. IPLark not read, ping0.cc read: ping0's verdicts fill the panel, with why.
  await run(`(() => {
    const line = [...document.querySelectorAll('tr')].find((node) => node.innerText.includes('198.51.100.34'))
    const edit = line && [...line.querySelectorAll('button')].find((node) => node.innerText.trim() === '编辑')
    edit?.click()
    return Boolean(edit)
  })()`)
  await delay(1500)
  const fallbackText = await run(`${modal}.innerText.replace(/\\s+/g, ' ')`)
  const panel = fallbackText.slice(fallbackText.indexOf('出口 IP'))
  check(/IP 评分 13% 风控值 · 极度纯净/.test(panel) && panel.includes('家庭宽带 IP') && panel.includes('原生 IP') && panel.includes('Podernet'), `ping0.cc shown when IPLark was not read: ${panel.slice(0, 400)}`)
  check(panel.includes('IPLark 没读到') && panel.includes('这次用 ping0.cc 的结果') && panel.includes('重新读取'), `the panel says why: ${panel.slice(0, 500)}`)
  await shot('exit-card-fallback.png')
  await click('取 消') || await click('取消')
  await delay(800)
  const formPanel = async (host) => {
    await run(`(() => {
      const line = [...document.querySelectorAll('tr')].find((node) => node.innerText.includes('${host}'))
      const edit = line && [...line.querySelectorAll('button')].find((node) => node.innerText.trim() === '编辑')
      edit?.click()
      return Boolean(edit)
    })()`)
    await delay(1500)
    const text = await run(`${modal}.innerText.replace(/\\s+/g, ' ')`)
    return text.slice(text.indexOf('出口 IP'))
  }

  // 10. The other site gave no score: what it did give fills the panel, with no score line.
  const noScore = await formPanel('198.51.100.35')
  // The same five rows as always; the score the site did not give is "-".
  check(/IP 评分 - 地区 墨西哥 厂商 Podernet 类型 家庭宽带 IP 原生 原生 IP/.test(noScore), `no score: same rows, score "-": ${noScore.slice(0, 400)}`)
  check(noScore.includes('这次用 ping0.cc 的结果'), `no score: says whose: ${noScore.slice(0, 500)}`)
  await click('取 消') || await click('取消')
  await delay(800)

  // 11. The other site is the user's own: its page is shown in place.
  const onlyShot = await formPanel('198.51.100.36')
  const images = await run(`${modal}.querySelectorAll('.fb-ip-score img').length`)
  check(/IP 评分 - 地区 - 厂商 - 类型 - 原生 -/.test(onlyShot) && onlyShot.includes('这次只有 MyCheck 的页面截图') && images >= 1, `user's site: same rows, its page below: ${onlyShot.slice(0, 400)} (${images} image)`)
  await shot('exit-card-only-shot.png')
} finally {
  await quitApp(instance)
  await removeTemporaryTree(userData)
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('a library proxy\'s country fills a new window')
