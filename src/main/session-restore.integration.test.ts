import { spawn, type SpawnOptions } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { BrowserLauncher } from './browser-launcher'
import { ProfileStore } from './profile-store'
import { SettingsStore } from './settings-store'
import { ExtensionStore } from './extension-store'

const browser = process.env.PROFILE_SESSION_BROWSER
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Actual browser, actual launcher close path, isolated profile; never reads the user's vault. */
describe.skipIf(!browser)('native session restoration', () => {
  let vault = ''
  let launcher: BrowserLauncher | undefined
  const site = createServer((_req, res) => { res.end('<title>Session restore test</title>') })
  afterEach(async () => {
    await launcher?.closeAll()
    site.close()
    if (vault) await rm(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('restores multiple tabs after closing through the app and switching back opens only configured pages', async () => {
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`
    vault = await mkdtemp(join(tmpdir(), 'fb-session-'))
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(vault)
    const extensions = new ExtensionStore(vault)
    await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
    await settings.update({ browserExecutable: browser!, fingerprintKernel: false, enginePreference: 'auto' })
    const profile = await profiles.create({ ...defaultProfileDraft(), startupMode: 'restore', startUrls: [`${base}/configured`] })
    const data = profiles.profileDataPath(profile.id)
    launcher = new BrowserLauncher(profiles, settings, () => undefined, extensions, undefined, undefined, undefined, 3,
      ((executable: string, args: readonly string[] = [], options: SpawnOptions = {}) => spawn(executable, [...args, '--remote-debugging-port=0', '--window-position=-32000,-32000'], options)) as unknown as typeof spawn)

    async function endpoint(): Promise<string> {
      for (let i = 0; i < 100; i++) {
        try {
          const port = (await readFile(join(data, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
          const result = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()) as { webSocketDebuggerUrl: string }
          return result.webSocketDebuggerUrl
        } catch { await wait(100) }
      }
      throw new Error('Browser debugger did not become ready')
    }
    async function pages(): Promise<string[]> {
      const ws = new WebSocket(await endpoint())
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject })
      try {
        return await new Promise<string[]>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Target list timed out')), 5000)
          ws.onmessage = (message) => {
            const response = JSON.parse(String(message.data))
            if (response.id === 1) { clearTimeout(timer); resolve(response.result.targetInfos.filter((target: { type: string }) => target.type === 'page').map((target: { url: string }) => target.url)) }
          }
          ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }))
        })
      } finally { ws.close() }
    }
    async function createTab(url: string): Promise<void> {
      const ws = new WebSocket(await endpoint())
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject })
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Create tab timed out')), 5000)
          ws.onmessage = (message) => { if (JSON.parse(String(message.data)).id === 1) { clearTimeout(timer); resolve() } }
          ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } }))
        })
      } finally { ws.close() }
    }
    await launcher.launch(profile.id)
    expect(await pages()).not.toContain(`${base}/configured`)
    await createTab(`${base}/one`)
    await createTab(`${base}/two`)
    await wait(2000)
    expect(await pages()).toEqual(expect.arrayContaining([`${base}/one`, `${base}/two`]))
    await launcher.close(profile.id)
    await launcher.launch(profile.id)
    let restored: string[] = []
    for (let i = 0; i < 50; i++) {
      restored = await pages()
      if (restored.includes(`${base}/one`) && restored.includes(`${base}/two`)) break
      await wait(100)
    }
    expect(restored).toEqual(expect.arrayContaining([`${base}/one`, `${base}/two`]))
    expect(restored).not.toContain(`${base}/configured`)
    await launcher.close(profile.id)
    await profiles.update(profile.id, { ...profiles.get(profile.id), startupMode: 'urls' })
    await launcher.launch(profile.id)
    let specified: string[] = []
    for (let i = 0; i < 50; i++) {
      specified = await pages()
      if (specified.includes(`${base}/configured`)) break
      await wait(100)
    }
    expect(specified).toContain(`${base}/configured`)
    expect(specified).not.toContain(`${base}/one`)
    expect(specified).not.toContain(`${base}/two`)
  }, 60_000)
})
