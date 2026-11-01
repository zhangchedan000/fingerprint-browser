#!/usr/bin/env node
/**
 * Real-app check of the reference model: upgrade of an old vault, proxy and group libraries,
 * assignment, deletion rules, recycle restore and saved preferences — all through the real
 * Renderer → Preload → Main path. Does not start browsers.
 *
 *   npm run build && node tools/app-e2e/library.mjs [--output report.json] [--keep-data]
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const args = process.argv.slice(2)
const output = args.includes('--output') ? resolve(args[args.indexOf('--output') + 1]) : resolve('app-e2e-library.json')
const keepData = args.includes('--keep-data')
const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')

function legacyWindow(id, serial, patch) {
  return {
    id,
    serialNumber: serial,
    name: id,
    note: '',
    tags: [],
    extensionIds: [],
    color: '#5965e8',
    startUrls: [],
    kernelVersion: '',
    window: { mode: 'auto', x: 0, y: 0, width: 1200, height: 800 },
    favorite: false,
    account: { platform: '', username: '', password: '' },
    fingerprint: {
      seed: 1000 + serial, hardwareProfileId: 'legacy-custom', platform: 'windows', platformVersion: '10.0.0', brand: 'Chrome',
      brandVersion: '', hardwareConcurrency: 8, language: 'en-US', acceptLanguages: 'en-US,en', timezone: 'America/New_York',
      webrtcPolicy: 'proxy_only', networkIdentityMode: 'proxy', proxyExitPolicy: 'block', screenWidth: 1920, screenHeight: 1080, disabledSpoofing: []
    },
    createdAt: `2026-09-0${serial}T00:00:00.000Z`,
    updatedAt: `2026-09-0${serial}T00:00:00.000Z`,
    status: 'closed',
    ...patch
  }
}

const SHARED = { protocol: 'socks5', host: '203.0.113.9', port: 1080, username: 'u1', password: 'secret' }

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'fb-library-e2e-'))
  const vault = join(root, 'vault')
  await mkdir(vault, { recursive: true })
  // A vault written by the version before the libraries existed (schema 11).
  await writeFile(join(vault, 'profiles.json'), JSON.stringify({
    schemaVersion: 11,
    nextSerialNumber: 4,
    profiles: [
      legacyWindow('w-a', 1, { group: '美区', proxy: SHARED }),
      legacyWindow('w-b', 2, { group: '美区', proxy: { ...SHARED } }),
      legacyWindow('w-c', 3, { group: '', proxy: { protocol: 'direct', host: '', username: '', password: '' } })
    ]
  }, null, 2))
  const checks = {}
  let first
  let second
  try {
    first = await launchApp({ app, packaged: false }, root)
    const result = await evaluate(first.client, `(async () => {
      const api = window.browserApi
      const out = {}
      const windows = await api.profiles.list()
      const proxies = await api.proxy.list()
      const groups = await api.groups.list()
      const a = windows.find((w) => w.id === 'w-a'), b = windows.find((w) => w.id === 'w-b'), c = windows.find((w) => w.id === 'w-c')
      out.upgradeMergedProxies = proxies.length === 1 && a.proxyId === b.proxyId && a.proxyId === proxies[0].id && !c.proxyId
      out.upgradeExtractedGroups = groups.length === 1 && groups[0].name === '美区' && a.groupId === groups[0].id && a.group === '美区'
      out.passwordsNeverReachUi = proxies[0].password === '' && proxies[0].passwordStored === true && a.proxy.password === ''

      // A typed proxy that already exists is not stored twice.
      const typed = await api.profiles.create({ ...a, name: 'typed', proxyId: undefined, proxy: { ...a.proxy, password: 'secret' }, group: '美区' })
      out.typedProxyReused = typed.proxyId === a.proxyId && (await api.proxy.list()).length === 1

      // Library edits show on every window that uses the proxy / group.
      await api.proxy.update(a.proxyId, { protocol: 'socks5', host: '198.51.100.7', port: 1080, username: 'u1', password: '', passwordStored: true, note: 'moved' })
      const after = await api.profiles.list()
      out.proxyEditReachesAllWindows = ['w-a', 'w-b', typed.id].every((id) => after.find((w) => w.id === id).proxy.host === '198.51.100.7')
      await api.groups.update(a.groupId, { name: '美国', note: '' })
      out.groupRenameReachesAllWindows = (await api.profiles.list()).filter((w) => w.groupId === a.groupId).every((w) => w.group === '美国')

      // One assign call for proxy, group and extension-free cases.
      const spare = await api.proxy.create({ protocol: 'http', host: '192.0.2.10', port: 8080, username: '', password: '', note: 'spare' })
      const g2 = await api.groups.create({ name: '测试组' })
      const assigned = await api.profiles.assignMany(['w-c'], { proxyId: spare.id, groupId: g2.id, followProxyIdentity: true })
      out.assignManyWorks = assigned[0].proxyId === spare.id && assigned[0].group === '测试组'

      // A proxy in use cannot be removed without a replacement.
      let refused = false
      try { await api.proxy.remove(spare.id) } catch { refused = true }
      await api.proxy.remove(spare.id, '')
      out.removeNeedsReplacement = refused && (await api.profiles.list()).find((w) => w.id === 'w-c').proxy.protocol === 'direct'

      // Deleting a group moves its windows to ungrouped.
      await api.groups.remove(g2.id)
      out.groupDeleteUngroups = (await api.profiles.list()).find((w) => w.id === 'w-c').groupId === ''

      // Recycle: the proxy comes back from the saved copy if it was removed meanwhile.
      await api.profiles.remove('w-b')
      const solo = await api.proxy.create({ protocol: 'http', host: '192.0.2.20', port: 3128, username: '', password: '', note: '' })
      await api.profiles.assignMany(['w-a', typed.id], { proxyId: solo.id })
      await api.proxy.remove(a.proxyId)
      const [trashed] = await api.profiles.trash()
      const restored = await api.profiles.restore(trashed.trashId)
      out.restoreBringsProxyBack = restored.proxy.host === '198.51.100.7' && !restored.proxyMissing

      await api.app.setPreferences({ theme: 'dark', batchLaunchGapSeconds: 2 })
      out.preferencesSaved = (await api.app.preferences()).theme === 'dark'
      return out
    })()`)
    Object.assign(checks, result)
    await quitApp(first)
    first = undefined

    const files = await readdir(vault)
    const saved = JSON.parse(await readFile(join(vault, 'profiles.json'), 'utf8'))
    checks.oldFileKeptBeforeUpgrade = files.includes('profiles.v11.before-upgrade.json')
    checks.storedAsReferences = saved.schemaVersion === 12 && saved.profiles.every((w) => w.proxy === undefined && typeof w.proxyId === 'string')
    checks.noPlainPasswordOnDisk = !JSON.stringify(saved).includes('"secret"')

    second = await launchApp({ app, packaged: false }, root)
    const reopened = await evaluate(second.client, `(async () => {
      for (let i = 0; i < 100 && !document.querySelector('.app-shell'); i++) await new Promise((r) => setTimeout(r, 100))
      const windows = await window.browserApi.profiles.list()
      return {
        restartKeepsReferences: windows.length === 4 && windows.every((w) => !w.proxyMissing),
        themeRestoredAtStart: document.documentElement.dataset.theme === 'dark'
      }
    })()`)
    Object.assign(checks, reopened)
  } finally {
    if (first) await quitApp(first).catch(() => first.child.kill('SIGKILL'))
    if (second) await quitApp(second).catch(() => second.child.kill('SIGKILL'))
    if (!keepData) await removeTemporaryTree(root)
  }
  const passed = Object.values(checks).every(Boolean)
  await writeFile(output, `${JSON.stringify({ checkedAt: new Date().toISOString(), checks, passed }, null, 2)}\n`)
  console.log(`Library E2E: ${passed ? 'PASS' : 'FAIL'}`)
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
