import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PortableCookie } from './cookie-file'
import type { Logger } from './app-logger'
import { locateBrowserForProfile } from './browser-locator'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'
import { CdpClient, stopChild, waitForPage } from './devtools-session'
import { assertKernelCanOpenProfileData } from './profile-data-version'

export class CookieManager {
  private readonly busyProfiles = new Set<string>()

  constructor(
    private readonly profiles: ProfileStore,
    private readonly settings: SettingsStore,
    private readonly logger?: Logger
  ) {}

  isBusy(id: string): boolean {
    return this.busyProfiles.has(id)
  }

  async exportCookies(id: string): Promise<PortableCookie[]> {
    const profile = this.ensureClosed(id)
    const cookies = await this.withSession(id, async (client) => {
      const result = await client.send<{ cookies: PortableCookie[] }>('Network.getAllCookies')
      return result.cookies
    })
    this.logger?.info('环境 Cookie 已导出', { profileId: id, count: cookies.length })
    return cookies
  }

  /** replace: the window keeps exactly these cookies (team windows taking over another's state). */
  async importCookies(id: string, cookies: PortableCookie[], options: { replace?: boolean } = {}): Promise<number> {
    this.ensureClosed(id)
    const defaultExpires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    const persistentCookies = cookies.map((cookie) => ({ ...cookie, expires: cookie.expires ?? defaultExpires }))
    await this.withSession(id, async (client) => {
      if (options.replace) await client.send('Network.clearBrowserCookies')
      if (persistentCookies.length) await client.send('Network.setCookies', { cookies: persistentCookies })
    })
    this.logger?.info('环境 Cookie 已导入', { profileId: id, count: cookies.length })
    return cookies.length
  }

  private ensureClosed(id: string) {
    const profile = this.profiles.get(id)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭浏览器环境再管理 Cookie')
    return profile
  }

  private async withSession<T>(id: string, action: (client: CdpClient) => Promise<T>): Promise<T> {
    if (this.busyProfiles.has(id)) throw new Error('该环境正在执行 Cookie 操作')
    this.busyProfiles.add(id)
    try {
      const profile = this.profiles.get(id)
      await this.profiles.assertProfileDataIdentity(id)
      const engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion)
      if (!engine.executable) {
        throw new Error(profile.kernelVersion
          ? `环境绑定的内核 ${profile.kernelVersion} 不可用，无法管理 Cookie`
          : '没有找到浏览器内核')
      }
      const userDataPath = this.profiles.profileDataPath(id)
      await assertKernelCanOpenProfileData(userDataPath, engine.version)
      const activePort = join(userDataPath, 'DevToolsActivePort')
      await rm(activePort, { force: true })
      const child = spawn(engine.executable, [
        `--user-data-dir=${userDataPath}`,
        '--headless=new',
        '--disable-extensions',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
      ], { stdio: 'ignore', windowsHide: true, env: { ...process.env } })
      let client: CdpClient | undefined
      try {
        const { websocket } = await waitForPage(userDataPath)
        client = await CdpClient.connect(websocket)
        await client.send('Network.enable')
        return await action(client)
      } finally {
        if (client) {
          await Promise.race([
            client.send('Browser.close').catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 1000))
          ])
          client.close()
        }
        await stopChild(child)
        await rm(activePort, { force: true })
      }
    } finally {
      this.busyProfiles.delete(id)
    }
  }
}
