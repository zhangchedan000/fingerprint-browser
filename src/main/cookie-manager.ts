import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PortableCookie } from './cookie-file'
import type { Logger } from './app-logger'
import { locateBrowserForProfile } from './browser-locator'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'
import { waitForBrowserExit, type StuckChoice } from './browser-exit'
import { CdpClient, stopChild, waitForPage } from './devtools-session'
import { assertKernelCanOpenProfileData } from './profile-data-version'
import { answerBlankPasswordCheck, restoreWindowState, snapshotWindowState } from './chrome-preferences'

/** Settles when the process has exited. */
function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

/** Asked when a browser looks stuck (window name, seconds so far, what it was doing). */
export type StuckPrompt = (name: string, seconds: number, doing: 'cookies' | 'close') => Promise<StuckChoice>

export class CookieManager {
  private readonly busyProfiles = new Set<string>()
  /** No UI (tests): a browser that looks stuck is ended, as before. */
  private stuckPrompt: StuckPrompt = async () => 'force'

  setStuckPrompt(prompt: StuckPrompt): void {
    this.stuckPrompt = prompt
  }

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
    this.logger?.info('[登录态] 已从窗口读出 Cookie', { profileId: id, count: cookies.length })
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
    this.logger?.info('[登录态] 已把 Cookie 写进窗口', { profileId: id, count: cookies.length, replace: options.replace === true })
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
      // Cookies can come before the window's first start: answer Chrome's blank-password logon here too.
      await answerBlankPasswordCheck(userDataPath)
      // The headless run only handles cookies: the window keeps its own size and last session.
      const windowState = await snapshotWindowState(userDataPath)
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
        // Chrome writes cookies set through CDP to disk on a 30 s timer or when it shuts down. Ended
        // before that (it used to be after 1 s), a slow computer kept none of the cookies just
        // imported: a team window opened there signed out, every cookie gone. It is waited for until
        // it exits by itself; only one that looks stuck is ended, when the user says so.
        const wait = await waitForBrowserExit(exitOf(child), userDataPath, {
          onStuck: (seconds) => this.stuckPrompt(profile.name, seconds, 'cookies'),
          kill: () => { child.kill() }
        })
        if (wait.forced) this.logger?.error('[登录态] 后台浏览器卡住，按用户选择强制结束（可能少了最后几秒写入的 Cookie）', { profileId: id, seconds: wait.seconds })
        else this.logger?.info('[登录态] 后台浏览器已正常退出（写完了）', { profileId: id, seconds: wait.seconds, stuckPrompts: wait.stuckPrompts })
        await stopChild(child)
        await rm(activePort, { force: true })
        await restoreWindowState(userDataPath, windowState).catch((error) => {
          this.logger?.error('窗口大小和上次页面没能恢复', { profileId: id, error: error instanceof Error ? error.message : String(error) })
        })
      }
    } finally {
      this.busyProfiles.delete(id)
    }
  }
}
