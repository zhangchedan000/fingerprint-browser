// Windows, by hand on a real team: v0.5.57's changes in a test launcher on its own data folder, signed in to
// the team like this computer (team.json and the key in Local State copied, the computer's windows counted
// as deleted here so nothing is added by itself). No window is opened and nothing new is saved, so nothing
// is uploaded; only what the steps say is changed on the server.
//   1. 团队 → tick <names> → batch 「添加到本机」: the picker lists each window's copies; 「全部改成：云端最新」, add.
//   2. 窗口 → <first name> → 恢复其他电脑的备份: the copies with system / id; with --delete <device short id>,
//      that copy is deleted (confirm) and the list read again.
//   3. 新建窗口 → 代理设置: API 提取 with a link, then 直连, 检测: the result is this computer's network, and the
//      IP 评分 side does not say 「API 提取的代理类型无效」; then 取消 (the window is not created).
// Output: <test folder>\v057.log and screenshots there.
// node v057-win.mjs <launcher exe> <real Local State> <real vault folder> <test folder> <name,name> [--delete <id>]
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const [app, localState, vault, folder, namesArg, ...flags] = process.argv.slice(2)
const names = namesArg.split(',')
const deleteId = flags.includes('--delete') ? flags[flags.indexOf('--delete') + 1] : ''
const userData = join(folder, 'appdata')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => appendFileSync(join(folder, 'v057.log'), `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}\n`)

rmSync(userData, { recursive: true, force: true })
mkdirSync(join(userData, 'vault'), { recursive: true })
copyFileSync(localState, join(userData, 'Local State'))
copyFileSync(join(vault, 'settings.json'), join(userData, 'vault', 'settings.json'))
for (const dir of ['kernels', 'kernel-fonts']) {
  try { execFileSync('robocopy', [join(vault, dir), join(userData, 'vault', dir), '/E', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' }) } catch (e) { if (e.status >= 8) throw e }
}
const team = JSON.parse(readFileSync(join(vault, 'team.json'), 'utf8'))
team.removed = { ...(team.removed ?? {}), ...team.links }
team.links = {}
delete team.localTouched
writeFileSync(join(userData, 'vault', 'team.json'), JSON.stringify(team, null, 2))

const port = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const child = spawn(app, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, PRISM_E2E: '1', PRISM_E2E_USER_DATA: userData } })
let ws
for (let i = 0; i < 240 && !ws; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); ws = t.find((x) => x.type === 'page' && /index\.html/.test(x.url))?.webSocketDebuggerUrl } catch {}
  if (!ws) await delay(500)
}
const s = new WebSocket(ws); await new Promise((r) => s.addEventListener('open', r, { once: true }))
let seq = 0; const pend = new Map()
s.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pend.set(id, (m) => resolve(m.result)); s.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'error'); return r?.result?.value }
const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(folder, file), Buffer.from(r.data, 'base64')); log('screenshot', file) }
const J = JSON.stringify
/** Clicks the first visible element (button first) whose own text is `text`, inside the last `scope` (in the row containing `within`). */
const click = async (text, scope = 'body', within = '') => {
  for (let i = 0; i < 40; i++) {
    const done = await evaluate(`(() => { const root = [...document.querySelectorAll(${J(scope)})].filter((x) => x.offsetParent || x === document.body).pop(); if (!root) return false; const host = ${J(within)} ? [...root.querySelectorAll('tr')].find((tr) => tr.textContent.includes(${J(within)})) : root; if (!host) return false; const norm = (x) => x.textContent.replace(/\\s+/g, '').trim(); const want = ${J(text)}.replace(/\\s+/g, ''); const pick = (sel) => [...host.querySelectorAll(sel)].find((x) => norm(x) === want && x.offsetParent && !x.disabled); const el = pick('button') || pick('label') || pick('.ant-select-item-option') || pick('a, span, div, li, td'); if (!el) return false; el.click(); return true })()`)
    if (done) return true
    await delay(500)
  }
  throw new Error('not found: ' + text + (within ? ' in ' + within : ''))
}
const modalText = (needle) => evaluate(`(() => { const m = [...document.querySelectorAll('.ant-modal')].filter((x) => x.offsetParent && x.textContent.includes(${J(needle)})).pop(); return m ? m.innerText.replace(/\\s+/g, ' ').slice(0, 1500) : null })()`)
const waitModal = async (needle, seconds = 30) => { for (let i = 0; i < seconds * 2; i++) { const m = await modalText(needle); if (m) return m; await delay(500) } return null }
const notes = () => evaluate(`[...document.querySelectorAll('.ant-notification-notice, .ant-message-notice')].map((x) => x.innerText.replace(/\\s+/g, ' ')).join(' | ')`)

try {
  for (let i = 0; i < 120; i++) { if (await evaluate('!!(window.browserApi && document.readyState === "complete")').catch(() => false)) break; await delay(500) }
  for (let i = 0; i < 90; i++) { const st = await evaluate('window.browserApi.team.status().then((s) => ({ role: s.user?.role, offline: !!s.offline }))'); if (st.role && !st.offline) break; await delay(2000) }
  await delay(3000)

  // 1. Batch add with the picker.
  await click('团队')
  await delay(3000)
  for (const name of names) {
    await evaluate(`(() => { const tr = [...document.querySelectorAll('.ant-table tr')].find((x) => [...x.querySelectorAll('strong')].some((s) => s.textContent.trim() === ${J(name)})); tr?.querySelector('.ant-checkbox-input')?.click(); return !!tr })()`)
    await delay(300)
  }
  await click('添加到本机', '.fb-batch-group')
  const picker = await waitModal('用哪台电脑的登录状态')
  log('batch picker', picker ?? 'none')
  await shot('1-batch-picker.png')
  if (picker) {
    await click('某台电脑的', '.ant-modal')
    await delay(500)
    await shot('1-batch-one-computer.png')
    await click('云端最新', '.ant-modal')
    await delay(500)
    log('batch picker (latest)', await modalText('用哪台电脑的登录状态'))
    await shot('1-batch-latest.png')
    await evaluate(`[...document.querySelectorAll('.ant-modal-footer button')].filter((b) => b.offsetParent).pop().click()`)
  }
  let note = ''
  for (let i = 0; i < 240 && !/添加到本机|失败/.test(note); i++) { note = await notes(); await delay(500) }
  log('batch result', note || 'no message in 120 s')
  log('local windows', await evaluate(`window.browserApi.profiles.list().then((l) => l.map((p) => p.name).join(', '))`))

  // 2. The restore dialog of the first window: system, id, delete.
  await click('窗口管理')
  await delay(2500)
  await evaluate(`(() => { const tr = [...document.querySelectorAll('.ant-table tr')].find((x) => x.textContent.includes(${J(names[0])})); tr?.querySelector('button[aria-label="更多操作"]')?.click(); return !!tr })()`)
  await delay(800)
  await click('恢复其他电脑的备份', '.ant-dropdown')
  let restore = await waitModal('恢复其他电脑的备份')
  for (let i = 0; i < 30 && restore && !/大小/.test(restore); i++) { await delay(500); restore = await modalText('恢复其他电脑的备份') }
  log('restore dialog', restore ?? 'none')
  await shot('2-restore.png')
  if (deleteId && restore?.includes(deleteId)) {
    await click('删除', '.ant-modal', deleteId)
    const confirm = await waitModal('在云端的这份备份', 10)
    log('confirm', confirm ?? 'none')
    await shot('2-confirm.png')
    await evaluate(`[...document.querySelectorAll('.ant-modal-confirm .ant-btn-dangerous')].filter((b) => b.offsetParent).pop().click()`)
    await delay(4000)
    log('restore dialog after delete', await modalText('恢复其他电脑的备份'))
    await shot('2-after-delete.png')
  }
  await evaluate(`[...document.querySelectorAll('.ant-modal-footer button')].filter((b) => b.offsetParent).pop()?.click()`)
  await delay(800)

  // 3. API 提取 typed, then 直连 and 检测.
  await click('新建窗口')
  await delay(2000)
  await click('代理设置')
  await delay(800)
  await click('API 提取')
  await delay(800)
  await evaluate(`(() => { const box = [...document.querySelectorAll('textarea, input')].find((x) => x.offsetParent && /api|链接/i.test(x.placeholder + (x.id || ''))); if (!box) return false; const set = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set; set.call(box, 'https://example.com/api?num=1&format=txt'); box.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await delay(800)
  await shot('3-api-typed.png')
  await click('直连')
  await delay(800)
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent && /^(检测代理|重新检测)$/.test(x.textContent.replace(/\\s+/g, ''))); b?.click(); return !!b })()`)
  let card = ''
  for (let i = 0; i < 90 && !/定位来源|失败|错误|无效/.test(card); i++) {
    await delay(1000)
    card = await evaluate(`(() => { const c = document.querySelector('.fb-exit-card, .fb-exit-ip, [class*="exit"]'); return (c?.closest('section, .fb-fp-card') ?? c)?.innerText?.replace(/\\s+/g, ' ').slice(0, 1200) ?? '' })()`)
  }
  await delay(8000)
  card = await evaluate(`(() => { const c = document.querySelector('.fb-exit-card, .fb-exit-ip, [class*="exit"]'); return (c?.closest('section, .fb-fp-card') ?? c)?.innerText?.replace(/\\s+/g, ' ').slice(0, 1500) ?? '' })()`)
  log('direct check card', card.replace(/\d{1,3}(\.\d{1,3}){3}/g, (ip) => ip))
  log('says API type invalid', /API 提取的代理类型无效/.test(await evaluate('document.body.innerText')))
  await shot('3-direct-checked.png')
  await click('取消')
  await delay(1000)
} catch (error) {
  log('error', String(error?.message ?? error).slice(0, 300))
  await shot('error.png').catch(() => undefined)
}
try { log('launcher log', readFileSync(join(userData, 'vault', 'logs', 'prism.log'), 'utf8').split('\n').filter((l) => /恢复另一台电脑|删除一台电脑|已添加|失败/.test(l)).map((l) => l.replace(/\d{1,3}(\.\d{1,3}){3}/g, '<ip>').slice(0, 220)).join(' | ')) } catch {}
try { await evaluate('window.browserApi.diagnostics.e2eQuit()') } catch {}
await delay(4000)
try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {}
log('done')
process.exit(0)
