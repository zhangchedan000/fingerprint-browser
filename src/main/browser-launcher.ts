import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { BrowserCrashRecord, BrowserProfile, FingerprintConfig, LaunchDiagnosticCheck, LaunchDiagnosticReport, ProfileLaunchOptions, ProxyConfig, ProxyTestResult, TunnelRoute } from '../shared/types'
import { locateBrowserForProfile } from './browser-locator'
import { buildLaunchArgs, type HostScreen } from './launch-args'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'
import { closeProxyBridge, openProxyBridge } from './proxy-bridge'
import { resolveApiProxy } from './api-proxy'
import { apiProxyFor } from './api-window'
import { windowWebRtcRelay, type WebRtcRelay } from './webrtc-relay'
import type { Logger } from './app-logger'
import type { ExtensionStore } from './extension-store'
import { findManagedProcess, SystemProcessInspector, type ProcessInspector } from './process-inspector'
import { assertFingerprintKernelCompatibility } from '../shared/fingerprint-consistency'
import { safeErrorText } from './redaction'
import { hardwareProfile, hardwareProfileSummary } from '../shared/hardware-profiles'
import { applyChromePreferences } from './chrome-preferences'
import { hostHardwareSnapshot } from './host-hardware'
import { classifyProxyFailure, locateServer, testProxy } from './proxy-tester'
import { effectiveNetworkIdentity, fixedIdentityForCheck, GEOIP_CONFLICT_CONFIRMATION_PREFIX, hasCompleteProxyIdentity, proxyLaunchError } from '../shared/network-identity'
import { sameProxyIdentity } from './profile-secrets'
import { BrowserControlSession, PipeCdpTransport } from './browser-control-session'
import type { Readable, Writable } from 'node:stream'
import { assertKernelCanOpenProfileData } from './profile-data-version'
import { analyzeCrash, captureStream, isLaunchLogOf, launchLogArgs, launchLogFiles, pruneLaunchLogs, readLaunchLog, type CrashAnalysis } from './browser-log'
import type { WriteStream } from 'node:fs'

type ProxyTester = (config: ProxyConfig) => Promise<ProxyTestResult>

interface RunningBrowser {
  process: ChildProcess
  /** The kernel it runs, to hand it more pages (openUrl). */
  executable?: string
  automation?: BrowserControlSession
  proxyUrl?: string
  proxyIdentityIp?: string
  proxyMonitor?: ReturnType<typeof setInterval>
  proxyMonitorRunning: boolean
  proxyQuarantined: boolean
  proxyIdentityMismatch: boolean
  expectedExit: boolean
  exited: Promise<void>
  proxyFailureTimes: number[]
  proxyWarningIssued: boolean
  finalize: (status: 'closed' | 'error', lastError?: string) => Promise<void>
}

export interface LauncherRuntimeSnapshot {
  managedProcesses: number
  orphanProcesses: number
  launchOperations: number
  closeOperations: number
  activeLaunches: number
  queuedLaunches: number
  closingAll: boolean
}

export type { BrowserCrashRecord } from '../shared/types'

const MAX_PROFILE_CRASH_RECORDS = 20
const MAX_CLOSE_ALL_ROUNDS = 4
const MAX_STAGNANT_CLOSE_ALL_ROUNDS = 2

function validCrashHistory(value: unknown): BrowserCrashRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((record): record is BrowserCrashRecord => Boolean(
    record && typeof record === 'object'
    && typeof (record as BrowserCrashRecord).occurredAt === 'string'
    && ((record as BrowserCrashRecord).code === null || typeof (record as BrowserCrashRecord).code === 'number')
    && ((record as BrowserCrashRecord).signal === null || typeof (record as BrowserCrashRecord).signal === 'string')
    && ['starting', 'running'].includes((record as BrowserCrashRecord).phase)
  )).slice(-MAX_PROFILE_CRASH_RECORDS)
}

/** Waits (briefly) until captured stderr is on disk. */
function closeCapture(file: WriteStream | undefined): Promise<void> {
  if (!file || file.closed) return Promise.resolve()
  return new Promise((resolve) => {
    // The child's stderr ends with the process and the pipe then closes the file; only end it
    // ourselves when that does not happen in time.
    const timer = setTimeout(() => { file.end(); resolve() }, 1000)
    file.once('close', () => { clearTimeout(timer); resolve() })
  })
}

/** Work around a window's run that lives outside the launcher (team windows: lock and sync). */
/**
 * What a window needs on this computer before it opens, fetched instead of failing: a window
 * that came from another computer (or the cloud) may use a kernel, 网络加速 or a language font
 * pack this one does not have yet.
 */
const WHITELIST_HINT = '。如果代理或 API 是按 IP 白名单授权的，换电脑后要把这台电脑的公网 IP 加进服务商白名单（开着网络加速时，是加速节点的 IP）'

export interface LaunchPrerequisites {
  /** Downloads and installs this kernel version. */
  installKernel(version: string): Promise<void>
  /** Starts 网络加速 when the window goes through it (and makes sure its node is there). */
  ensureTunnel(route: TunnelRoute): Promise<void>
  /** Installs the Windows language font pack the window's system language needs, when missing. */
  ensureFonts(uiLocale: string): Promise<void>
}

export interface LaunchHooks {
  /** Before the browser starts, while the window is still closed. Throwing cancels the launch. */
  beforeLaunch(id: string): Promise<void>
  /** The launch failed after beforeLaunch succeeded. */
  launchFailed(id: string): Promise<void>
  /** After the browser exited and the window is closed again. */
  afterExit(id: string): Promise<void>
}

export class BrowserLauncher {
  private hooks?: LaunchHooks
  private readonly processes = new Map<string, RunningBrowser>()
  private readonly orphanProcesses = new Map<string, number>()
  private readonly launchOperations = new Map<string, Promise<BrowserProfile>>()
  private readonly closeOperations = new Map<string, Promise<BrowserProfile>>()
  private activeLaunches = 0
  private readonly launchWaiters: Array<() => void> = []
  private closeAllOperation?: Promise<void>

  constructor(
    private readonly profiles: ProfileStore,
    private readonly settings: SettingsStore,
    private readonly onChanged: (profile: BrowserProfile) => void,
    private readonly extensions: ExtensionStore,
    private readonly logger?: Logger,
    private readonly processInspector: ProcessInspector = new SystemProcessInspector(),
    private readonly proxyTester: ProxyTester = testProxy,
    private readonly maxConcurrentLaunches = 3,
    private readonly browserSpawner: typeof spawn = spawn,
    private readonly proxyMonitorIntervalMs = 5 * 60_000
  ) {
    if (!Number.isInteger(maxConcurrentLaunches) || maxConcurrentLaunches < 1 || maxConcurrentLaunches > 20) {
      throw new Error('浏览器并发启动数必须在 1 到 20 之间')
    }
    if (!Number.isInteger(proxyMonitorIntervalMs) || proxyMonitorIntervalMs < 10) {
      throw new Error('代理出口复检间隔不能小于 10 毫秒')
    }
  }

  private hostScreen: () => HostScreen | undefined = () => undefined

  setLaunchHooks(hooks: LaunchHooks): void {
    this.hooks = hooks
  }

  private prerequisites?: LaunchPrerequisites

  setPrerequisites(prerequisites: LaunchPrerequisites): void {
    this.prerequisites = prerequisites
  }

  /** Provides the primary display size for windows whose resolution follows the computer. */
  setHostScreenProvider(provider: () => HostScreen | undefined): void {
    this.hostScreen = provider
  }

  async initialize(): Promise<void> {
    let systemProcesses
    try {
      systemProcesses = await this.processInspector.list()
    } catch (error) {
      this.logger?.error('启动时无法扫描 Chromium 遗留进程', error)
      await Promise.allSettled(this.profiles.list().map(async (profile) => {
          const processMarker = join(this.profiles.profileRuntimePath(profile.id), 'process.json')
          const hadProcessMarker = await access(processMarker).then(() => true).catch(() => false)
          if (!hadProcessMarker && (profile.status === 'closed' || profile.status === 'error')) return
          const next = await this.profiles.setRuntime(profile.id, {
            status: 'error',
            lastError: '应用重启后无法扫描系统进程，请先执行启动诊断再重新打开环境'
          })
          this.onChanged(next)
        }))
      return
    }
    for (const profile of this.profiles.list()) {
      const process = findManagedProcess(systemProcesses, this.profiles.profileDataPath(profile.id))
      if (process) {
        this.orphanProcesses.set(profile.id, process.pid)
        await this.profiles.setRuntime(profile.id, {
          status: 'orphaned',
          lastError: `检测到上次异常退出遗留的浏览器进程（PID ${process.pid}）`
        })
        this.logger?.error('检测到遗留浏览器进程', { profileId: profile.id, pid: process.pid })
      } else {
        const processMarker = join(this.profiles.profileRuntimePath(profile.id), 'process.json')
        const hadProcessMarker = await access(processMarker).then(() => true).catch(() => false)
        await rm(processMarker, { force: true })
        if (hadProcessMarker || (profile.status !== 'closed' && profile.status !== 'error')) {
          const next = await this.profiles.setRuntime(profile.id, {
            status: 'error',
            lastError: '上次运行未正常结束，但当前未发现占用数据目录的浏览器进程'
          })
          this.onChanged(next)
          this.logger?.error('浏览器环境状态已从异常中断中恢复', { profileId: profile.id })
        }
      }
    }
  }

  async launch(id: string, options: ProfileLaunchOptions = {}): Promise<BrowserProfile> {
    if (this.closeAllOperation) throw new Error('正在关闭全部浏览器环境，请等待操作完成后再启动')
    const existing = this.launchOperations.get(id)
    if (existing) return existing
    const operation = (async () => {
      const closing = this.closeOperations.get(id)
      if (closing) await closing.catch(() => undefined)
      return this.withLaunchSlot(() => this.launchProfile(id, options))
    })()
    this.launchOperations.set(id, operation)
    try {
      return await operation
    } finally {
      if (this.launchOperations.get(id) === operation) this.launchOperations.delete(id)
    }
  }

  /** Settings → 下载位置 for this window (created if missing), or undefined for Chrome's own. */
  private async downloadFolder(profile: BrowserProfile): Promise<string | undefined> {
    const { downloadFolder, downloadPerWindow } = this.settings.get()
    if (!downloadFolder) return undefined
    // "18 环境 1": the serial keeps windows of the same name apart; no characters Windows refuses.
    const name = `${profile.serialNumber} ${profile.name}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 80)
    const folder = downloadPerWindow ? join(downloadFolder, name) : downloadFolder
    try {
      await mkdir(folder, { recursive: true })
      return folder
    } catch (error) {
      this.logger?.error('无法创建下载文件夹，窗口用 Chrome 默认下载位置', { profileId: profile.id, folder, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  /**
   * Opens a page in the window: a new tab when it is running (Chrome hands a second start on the
   * same user data folder to the running browser), otherwise the window starts as usual (its proxy
   * and fingerprint) with the page as an extra tab.
   */
  async openUrl(id: string, url: string, options: ProfileLaunchOptions = {}): Promise<BrowserProfile> {
    if (!/^https?:\/\//i.test(url)) throw new Error('只能打开 http 或 https 网址')
    const running = this.processes.get(id)
    if (!running) return this.launch(id, { ...options, openUrl: url })
    if (!running.executable) throw new Error('这个窗口正在启动，请稍后再试')
    const child = this.browserSpawner(running.executable, [`--user-data-dir=${this.profiles.profileDataPath(id)}`, url], {
      stdio: 'ignore',
      detached: true,
      windowsHide: false
    })
    child.unref()
    this.logger?.info('在窗口中打开网页', { profileId: id, url })
    return this.profiles.get(id)
  }

  private async launchProfile(id: string, options: ProfileLaunchOptions): Promise<BrowserProfile> {
    if (this.processes.has(id)) return this.profiles.get(id)
    if (this.orphanProcesses.has(id)) throw new Error('该环境仍有异常遗留进程，请先点击“结束遗留”')
    await this.guardProfileAvailable(id)
    // Hooks may bring a newer config, so the window is read after them.
    await this.hooks?.beforeLaunch(id)
    try {
      return await this.startProfile(id, options)
    } catch (error) {
      await this.hooks?.launchFailed(id).catch((hookError) => {
        this.logger?.error('启动失败后的清理出错', { profileId: id, error: hookError instanceof Error ? hookError.message : String(hookError) })
      })
      throw error
    }
  }

  private async startProfile(id: string, options: ProfileLaunchOptions): Promise<BrowserProfile> {
    let profile = this.profiles.get(id)
    // Never fall back to the real network when the chosen proxy is gone.
    if (profile.proxyMissing) throw new Error('这个窗口使用的代理已不在代理库中，请重新选择代理')
    let engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion)
    if (!engine.executable && profile.kernelVersion && this.prerequisites) {
      // A window made on another computer keeps its kernel: fetched here instead of changed.
      this.logger?.info('窗口的内核不在这台电脑上，自动下载', { profileId: id, kernel: profile.kernelVersion })
      try {
        await this.prerequisites.installKernel(profile.kernelVersion)
      } catch (error) {
        throw new Error(`环境绑定的内核 ${profile.kernelVersion} 不在这台电脑上，自动下载失败：${error instanceof Error ? error.message : String(error)}`)
      }
      engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion)
    }
    if (!engine.executable) {
      throw new Error(profile.kernelVersion
        ? `环境绑定的内核 ${profile.kernelVersion} 不可用，请先安装该版本或修改环境配置`
        : '没有找到浏览器内核，请先在“内核管理”里导入或下载 Prism 内核')
    }
    if (profile.proxy.tunnel?.enabled && this.prerequisites) await this.prerequisites.ensureTunnel(profile.proxy.tunnel)
    if (this.prerequisites && profile.fingerprint.fontSource !== 'host' && engine.webrtcRelay) {
      // prism7+ shows the fonts of the system language: its pack is fetched like Windows would have it.
      await this.prerequisites.ensureFonts(effectiveNetworkIdentity(profile.fingerprint).uiLocale).catch((error) => {
        this.logger?.error('语言字体包没有装上，窗口照常打开', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      })
    }
    if (profile.apiProxy) {
      // API 提取: the proxy it has while it works; a new one from the link otherwise (checked already).
      profile = await this.apiProxyForLaunch(profile, options.allowGeoConflict === true)
    } else {
      if (profile.proxy.apiUrl) {
        // A library proxy with an API link (from before they moved into the windows): a fresh proxy.
        const endpoint = await resolveApiProxy(profile.proxy.apiUrl, profile.proxy.tunnel)
        await this.profiles.setApiProxyEndpoint(profile.proxyId, endpoint)
        profile = this.profiles.get(id)
        this.logger?.info('从代理 API 取得代理', { profileId: id, protocol: endpoint.protocol, host: endpoint.host, port: endpoint.port })
      }
      if (profile.proxy.protocol !== 'direct') profile = await this.refreshProxyForLaunch(profile, options.allowGeoConflict === true)
    }
    profile = await this.lockOnLaunch(profile, options.allowGeoConflict === true)
    const hostHardware = hostHardwareSnapshot()
    const selectedHardware = hardwareProfile(profile.fingerprint.hardwareProfileId)
    if (selectedHardware?.hostMatched && selectedHardware.platform !== hostHardware.platform) {
      throw new Error(`${selectedHardware.label} 只能在对应系统上使用；请改用本机模板或成套模拟模板`)
    }
    assertFingerprintKernelCompatibility(profile, engine)
    await assertKernelCanOpenProfileData(this.profiles.profileDataPath(id), engine.version)
    this.logger?.info('准备启动浏览器环境', { profileId: id, engine: engine.label })

    this.onChanged(await this.profiles.setRuntime(id, { status: 'starting', lastError: undefined }))
    let localProxyUrl: string | undefined
    let webrtcRelay: WebRtcRelay | undefined
    try {
      localProxyUrl = await openProxyBridge(profile.proxy, {
        onFailure: (error) => {
          void this.noteProxyBridgeFailure(id, error).catch((callbackError) => {
            this.logger?.error('记录代理桥失败状态时出错', {
              profileId: id,
              error: callbackError instanceof Error ? callbackError.message : String(callbackError)
            })
          })
        },
        onTraffic: () => {
          void this.noteProxyBridgeTraffic(id).catch((error) => {
            this.logger?.error('记录代理桥恢复状态时出错', {
              profileId: id,
              error: error instanceof Error ? error.message : String(error)
            })
          })
        }
      })
      // 替换 on prism7+: WebRTC UDP through the proxy when it relays UDP (reached directly, not
      // through the tunnel or a system proxy); otherwise the kernel only reports its address.
      webrtcRelay = await windowWebRtcRelay(profile, engine)
      if (profile.fingerprint.webrtcPolicy === 'proxy_only' && engine.webrtcRelay && profile.proxy.protocol === 'socks5') {
        this.logger?.info(webrtcRelay ? 'WebRTC 经代理 UDP 转发' : 'WebRTC 替换为代理 IP（代理不转发 UDP）', { profileId: id })
      }
      const runtimePath = this.profiles.profileRuntimePath(id)
      await mkdir(runtimePath, { recursive: true })
      try {
        await applyChromePreferences(this.profiles.profileDataPath(id), profile.fingerprint, profile.startupMode ?? 'urls', await this.downloadFolder(profile))
      } catch (error) {
        this.logger?.error('写入浏览器偏好设置失败，继续使用上次的设置', {
          profileId: id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      const args = buildLaunchArgs(profile, {
        userDataDir: this.profiles.profileDataPath(id),
        proxyUrl: localProxyUrl,
        extensionPaths: this.extensions.paths(profile.extensionIds),
        engineVersion: engine.version,
        fingerprintKernel: engine.fingerprintKernel,
        hostHardwareConcurrency: hostHardware.hardwareConcurrency,
        hostPlatformVersion: hostHardware.platformVersion,
        proxyIdentity: profile.proxyCheck,
        allowGeoConflict: options.allowGeoConflict === true,
        hostScreen: this.hostScreen(),
        windowScreen: engine.windowScreen,
        webrtcRelaySupported: engine.webrtcRelay,
        languageFonts: engine.webrtcRelay,
        seededAudioRects: engine.webrtcRelay,
        webrtcRelayPort: webrtcRelay?.port,
        extraUrls: options.openUrl ? [options.openUrl] : undefined,
        firstOpen: !await hasSavedSession(this.profiles.profileDataPath(id))
      })
      if (process.env.PRISM_E2E === '1' && process.env.PRISM_E2E_BROWSER_HEADLESS === '1') {
        args.push('--headless=new')
        if (process.platform === 'darwin') args.push('--use-mock-keychain')
        // Test containers run as root, where Chromium refuses its sandbox.
        if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox')
      }
      const pipeControlEnabled = process.platform !== 'win32'
      if (pipeControlEnabled) args.push('--remote-debugging-pipe')
      // Every run writes a log so a crash can be explained in the window list.
      const launchedAt = new Date()
      const logFiles = launchLogFiles(runtimePath, launchedAt)
      await mkdir(logFiles.folder, { recursive: true })
      await pruneLaunchLogs(logFiles.folder, 9)
      args.push(...launchLogArgs(logFiles))
      await writeFile(
        join(runtimePath, 'last-launch.json'),
        JSON.stringify({ executable: engine.executable, args, launchedAt: new Date().toISOString() }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      )

      const child = this.browserSpawner(engine.executable, args, {
        stdio: pipeControlEnabled ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
        windowsHide: false,
        env: { ...process.env }
      })
      const stderrFile: WriteStream | undefined = captureStream(child.stderr, logFiles.stderrLog)
      let automation: BrowserControlSession | undefined
      if (pipeControlEnabled && Array.isArray(child.stdio)) {
        const writable = child.stdio[3] as Writable | null
        const readable = child.stdio[4] as Readable | null
        if (readable && writable) automation = new BrowserControlSession(new PipeCdpTransport(readable, writable))
      }
      let resolveExited!: () => void
      const exited = new Promise<void>((resolve) => { resolveExited = resolve })
      let resolveStarted!: () => void
      let rejectStarted!: (error: Error) => void
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve
        rejectStarted = reject
      })
      let startSettled = false
      const markStarted = (): void => {
        if (startSettled) return
        startSettled = true
        resolveStarted()
      }
      const markStartFailed = (error: unknown): void => {
        if (startSettled) return
        startSettled = true
        rejectStarted(error instanceof Error ? error : new Error(String(error)))
      }
      let finalized = false

      const finalize = async (status: 'closed' | 'error', lastError?: string): Promise<void> => {
        if (finalized) return
        finalized = true
        automation?.close()
        if (running?.proxyMonitor) clearInterval(running.proxyMonitor)
        this.processes.delete(id)
        this.orphanProcesses.delete(id)
        try {
          webrtcRelay?.close()
          const cleanup = await Promise.allSettled([
            closeProxyBridge(localProxyUrl),
            rm(join(runtimePath, 'process.json'), { force: true })
          ])
          for (const result of cleanup) {
            if (result.status === 'rejected') {
              this.logger?.error('浏览器退出资源清理失败', {
                profileId: id,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason)
              })
            }
          }
          const next = await this.profiles.setRuntime(id, { status, lastError })
          this.onChanged(next)
        } catch (error) {
          this.logger?.error('浏览器退出状态持久化失败', {
            profileId: id,
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          resolveExited()
        }
        // Not awaited: an upload can take minutes; the hook owner waits for it on quit.
        void this.hooks?.afterExit(id).catch((error) => {
          this.logger?.error('浏览器退出后的处理出错', { profileId: id, error: error instanceof Error ? error.message : String(error) })
        })
      }
      const running: RunningBrowser = {
        process: child,
        automation,
        executable: engine.executable,
        proxyUrl: localProxyUrl,
        proxyIdentityIp: profile.proxyCheck?.ip,
        proxyMonitorRunning: false,
        proxyQuarantined: false,
        proxyIdentityMismatch: false,
        expectedExit: false,
        exited,
        proxyFailureTimes: [],
        proxyWarningIssued: false,
        finalize
      }
      this.processes.set(id, running)

      child.once('spawn', () => {
        void (async () => {
          try {
            this.logger?.info('浏览器环境已启动', { profileId: id, pid: child.pid })
            await writeFile(join(runtimePath, 'process.json'), JSON.stringify({
              pid: child.pid,
              executable: engine.executable,
              userDataDir: this.profiles.profileDataPath(id),
              startedAt: new Date().toISOString()
            }, null, 2), { mode: 0o600 })
            const next = await this.profiles.setRuntime(id, {
              status: 'running',
              lastOpenedAt: new Date().toISOString(),
              lastError: undefined
            })
            this.onChanged(next)
            if (localProxyUrl) this.startProxyMonitor(id, profile.proxy)
            markStarted()
          } catch (error) {
            markStartFailed(error)
            running.expectedExit = true
            child.kill('SIGTERM')
            await finalize('error', safeErrorText(error))
          }
        })()
      })

      child.once('error', (error) => {
        this.logger?.error('浏览器进程启动失败', { profileId: id, error: error.message })
        markStartFailed(error)
        void finalize('error', error.message)
      })

      child.once('exit', (code, signal) => {
        const unexpected = !running.expectedExit && code !== 0
        const phase: BrowserCrashRecord['phase'] = startSettled ? 'running' : 'starting'
        if (!startSettled) {
          this.logger?.error('浏览器在启动完成前退出', { profileId: profile.id, code, signal })
          markStartFailed(new Error('浏览器在启动完成前退出，请重试或运行启动诊断'))
        }
        this.logger?.info('浏览器环境已退出', { profileId: id, code, signal, expected: !unexpected })
        void (async () => {
          await closeCapture(stderrFile)
          if (unexpected) {
            const analysis = await analyzeCrash(logFiles, this.profiles.profileDataPath(id), launchedAt)
              .catch((): CrashAnalysis => ({ logTail: [], dumps: [] }))
            this.logger?.error('浏览器异常退出', { profileId: id, code, signal, reason: analysis.reason, logFile: logFiles.chromeLog })
            await this.recordCrash(id, {
              occurredAt: new Date().toISOString(),
              pid: child.pid,
              code,
              signal,
              phase,
              kernelVersion: engine.version,
              logFile: logFiles.chromeLog,
              ...analysis,
              args
            }).catch((error) => {
              this.logger?.error('浏览器崩溃历史写入失败', {
                profileId: id,
                error: error instanceof Error ? error.message : String(error)
              })
            })
          }
          await finalize(
            unexpected ? 'error' : 'closed',
            unexpected ? `浏览器异常退出（code=${code ?? '-'}, signal=${signal ?? '-'}）` : undefined
          )
        })()
      })

      await started
      return this.profiles.get(id)
    } catch (error) {
      this.logger?.error('浏览器环境启动流程失败', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      await closeProxyBridge(localProxyUrl)
      webrtcRelay?.close()
      const safeError = safeErrorText(error)
      const next = await this.profiles.setRuntime(id, {
        status: 'error',
        lastError: safeError
      })
      this.onChanged(next)
      throw new Error(safeError)
    }
  }

  async close(id: string): Promise<BrowserProfile> {
    const existing = this.closeOperations.get(id)
    if (existing) return existing
    const operation = (async () => {
      const launching = this.launchOperations.get(id)
      if (launching) await launching.catch(() => undefined)
      return this.closeProfile(id)
    })()
    this.closeOperations.set(id, operation)
    try {
      return await operation
    } finally {
      if (this.closeOperations.get(id) === operation) this.closeOperations.delete(id)
    }
  }

  private async closeProfile(id: string): Promise<BrowserProfile> {
    const orphanPid = this.orphanProcesses.get(id)
    if (orphanPid) return this.closeOrphan(id, orphanPid)
    const running = this.processes.get(id)
    if (!running) {
      const profile = await this.profiles.setRuntime(id, { status: 'closed', lastError: undefined })
      this.onChanged(profile)
      return profile
    }

    running.expectedExit = true
    this.logger?.info('正在关闭浏览器环境', { profileId: id, pid: running.process.pid })
    this.onChanged(await this.profiles.setRuntime(id, { status: 'stopping', lastError: undefined }))
    if (this.profiles.get(id).startupMode === 'restore' && (running.automation || this.processInspector.requestClose)) {
      try {
        if (running.automation) {
          await Promise.race([running.automation.requestClose(), new Promise((resolve) => setTimeout(resolve, 3000))])
        } else if (running.process.pid) await this.processInspector.requestClose!(running.process.pid)
      } catch {
        // A close request can lose its reply as Chromium exits. Allow the normal shutdown
        // to finish; the timeout below still terminates an unresponsive process.
      }
    } else running.process.kill('SIGTERM')
    const exited = await new Promise<boolean>((resolve) => {
      const forceTimer = setTimeout(() => {
        running.process.kill('SIGKILL')
      }, 5000)
      const giveUpTimer = setTimeout(() => {
        clearTimeout(forceTimer)
        resolve(false)
      }, 8000)
      void running.exited.then(() => {
        clearTimeout(forceTimer)
        clearTimeout(giveUpTimer)
        resolve(true)
      })
    })
    if (!exited && this.processes.get(id) === running) {
      let managedProcess
      try {
        managedProcess = findManagedProcess(await this.processInspector.list(), this.profiles.profileDataPath(id))
      } catch (error) {
        const message = '浏览器关闭超时，且无法重新扫描进程；请稍后重试或执行启动诊断'
        this.onChanged(await this.profiles.setRuntime(id, { status: 'error', lastError: message }))
        this.logger?.error('浏览器关闭超时且进程扫描失败', {
          profileId: id,
          error: error instanceof Error ? error.message : String(error)
        })
        throw new Error(message)
      }
      if (managedProcess) {
        this.processes.delete(id)
        this.orphanProcesses.set(id, managedProcess.pid)
        const message = `浏览器关闭超时，仍检测到占用数据目录的进程（PID ${managedProcess.pid}）`
        const profile = await this.profiles.setRuntime(id, { status: 'orphaned', lastError: message })
        this.onChanged(profile)
        this.logger?.error('浏览器关闭后转为遗留进程', { profileId: id, pid: managedProcess.pid })
        return profile
      }
      await running.finalize('closed')
    }
    return this.profiles.get(id)
  }

  closeAll(): Promise<void> {
    if (this.closeAllOperation) return this.closeAllOperation
    const operation = (async () => {
      const failures = new Map<string, unknown>()
      let stagnantRounds = 0
      for (let round = 0; round < MAX_CLOSE_ALL_ROUNDS; round += 1) {
        const ids = new Set([
          ...this.processes.keys(),
          ...this.orphanProcesses.keys(),
          ...this.launchOperations.keys(),
          ...this.closeOperations.keys()
        ])
        if (!ids.size) return
        const before = this.closeAllState()
        const orderedIds = [...ids].sort()
        const results = await Promise.allSettled(orderedIds.map((id) => this.close(id)))
        results.forEach((result, index) => {
          if (result.status === 'rejected') failures.set(orderedIds[index], result.reason)
          else failures.delete(orderedIds[index])
        })
        const after = this.closeAllState()
        if (!after.length) return
        if (after.join('\n') === before.join('\n')) stagnantRounds += 1
        else stagnantRounds = 0
        if (stagnantRounds >= MAX_STAGNANT_CLOSE_ALL_ROUNDS) break
      }
      const remaining = [...new Set([
        ...this.processes.keys(),
        ...this.orphanProcesses.keys(),
        ...this.launchOperations.keys(),
        ...this.closeOperations.keys()
      ])].sort()
      const causes = remaining.map((id) => failures.get(id) ?? new Error(`环境 ${id} 仍有未结束的浏览器进程`))
      throw new AggregateError(causes, `仍有 ${remaining.length} 个浏览器环境无法关闭，请查看启动诊断或手动结束遗留进程`)
    })()
    this.closeAllOperation = operation
    const clearOperation = (): void => {
      if (this.closeAllOperation === operation) this.closeAllOperation = undefined
    }
    void operation.then(clearOperation, clearOperation)
    return operation
  }

  private closeAllState(): string[] {
    return [
      ...[...this.processes.keys()].map((id) => `managed:${id}`),
      ...[...this.orphanProcesses.keys()].map((id) => `orphan:${id}`),
      ...[...this.launchOperations.keys()].map((id) => `launch:${id}`),
      ...[...this.closeOperations.keys()].map((id) => `close:${id}`)
    ].sort()
  }

  isRunning(id: string): boolean {
    return this.processes.has(id) || this.orphanProcesses.has(id)
      || this.launchOperations.has(id) || this.closeOperations.has(id)
  }

  hasRunning(): boolean {
    return this.processes.size > 0 || this.orphanProcesses.size > 0
      || this.launchOperations.size > 0 || this.closeOperations.size > 0
  }

  async openPage(id: string, url: string): Promise<{ url: string; title: string; readyState: string }> {
    await this.launch(id)
    return this.controlSession(id).open(url)
  }

  pageSnapshot(id: string): ReturnType<BrowserControlSession['snapshot']> {
    return this.controlSession(id).snapshot()
  }

  clickPageElement(id: string, ref: string): ReturnType<BrowserControlSession['click']> {
    return this.controlSession(id).click(ref)
  }

  typePageElement(id: string, ref: string, text: string, clear = true): ReturnType<BrowserControlSession['type']> {
    return this.controlSession(id).type(ref, text, clear)
  }

  runtimeSnapshot(): LauncherRuntimeSnapshot {
    return {
      managedProcesses: this.processes.size,
      orphanProcesses: this.orphanProcesses.size,
      launchOperations: this.launchOperations.size,
      closeOperations: this.closeOperations.size,
      activeLaunches: this.activeLaunches,
      queuedLaunches: this.launchWaiters.length,
      closingAll: Boolean(this.closeAllOperation)
    }
  }

  private controlSession(id: string): BrowserControlSession {
    const running = this.processes.get(id)
    if (!running) throw new Error('浏览器环境尚未启动')
    if (!running.automation) {
      throw new Error(process.platform === 'win32'
        ? '当前 Windows 内部版本尚未启用 MCP 页面操作，请先在 macOS 验证后统一移植'
        : '当前浏览器内核没有建立安全页面控制管道，请关闭环境后重新启动')
    }
    return running.automation
  }

  async crashHistory(id: string): Promise<BrowserCrashRecord[]> {
    this.profiles.get(id)
    try {
      return validCrashHistory(JSON.parse(await readFile(
        join(this.profiles.profileRuntimePath(id), 'crash-history.json'),
        'utf8'
      )))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return []
      throw error
    }
  }

  /** Text of one of the window's launch logs. Only files in its own log folder are readable. */
  async readLaunchLog(id: string, logFile: string): Promise<{ text: string; truncated: boolean; files: string[] }> {
    const folder = this.launchLogFolder(id)
    if (typeof logFile !== 'string' || !isLaunchLogOf(folder, logFile)) throw new Error('日志文件不属于这个环境')
    return readLaunchLog(logFile)
  }

  launchLogFolder(id: string): string {
    this.profiles.get(id)
    return launchLogFiles(this.profiles.profileRuntimePath(id)).folder
  }

  async crashHistorySnapshot(): Promise<Record<string, BrowserCrashRecord[]>> {
    return Object.fromEntries(await Promise.all(this.profiles.list().map(async (profile) => [
      profile.id,
      await this.crashHistory(profile.id)
    ] as const)))
  }

  async diagnose(id: string): Promise<LaunchDiagnosticReport> {
    const profile = this.profiles.get(id)
    const checks: LaunchDiagnosticCheck[] = []
    const add = (key: string, label: string, status: LaunchDiagnosticCheck['status'], message: string): void => {
      checks.push({ key, label, status, message })
    }

    if (this.isRunning(id) || !['closed', 'error'].includes(profile.status)) {
      add('process', '进程状态', 'error', profile.status === 'orphaned' ? '存在异常遗留进程，需先结束遗留' : '环境当前正在运行或切换状态')
    } else {
      try {
        const process = findManagedProcess(await this.processInspector.list(), this.profiles.profileDataPath(id))
        add('process', '进程状态', process ? 'error' : 'pass', process ? `数据目录被 PID ${process.pid} 占用` : '未发现数据目录占用')
      } catch {
        add('process', '进程状态', 'error', '无法扫描系统进程，为保护数据不建议启动')
      }
    }

    try {
      await this.profiles.assertProfileDataIdentity(id)
      add('data-identity', '数据目录身份', 'pass', '环境 ID、用户数据目录与运行目录对应一致')
    } catch (error) {
      add('data-identity', '数据目录身份', 'error', error instanceof Error ? error.message : String(error))
    }

    const engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion)
    if (!engine.executable) {
      add('engine', '浏览器内核', 'error', engine.label)
    } else {
      try {
        await access(engine.executable, constants.X_OK)
        add('engine', '浏览器内核', engine.fingerprintKernel ? 'pass' : 'warning', engine.fingerprintKernel
          ? `${engine.label}${engine.version ? ` ${engine.version}` : ''} 可执行`
          : `${engine.label} 可执行，但不会应用指纹参数`)
      } catch {
        add('engine', '浏览器内核', 'error', '内核文件不存在、不可执行或权限不足')
      }
      try {
        assertFingerprintKernelCompatibility(profile, engine)
        add('version', '版本一致性', 'pass', engine.fingerprintKernel && engine.version
          ? `UA、UA-CH 与请求头版本将统一使用实际内核 ${engine.version}`
          : '兼容模式使用浏览器自身版本')
      } catch (error) {
        add('version', '版本一致性', 'error', error instanceof Error ? error.message : String(error))
      }
    }

    try {
      const paths = this.extensions.paths(profile.extensionIds)
      await Promise.all(paths.map((path) => access(path)))
      add('extensions', '浏览器扩展', 'pass', paths.length ? `${paths.length} 个扩展配置完整` : '未加载额外扩展')
    } catch (error) {
      add('extensions', '浏览器扩展', 'error', error instanceof Error ? error.message : String(error))
    }

    try {
      const fileSystem = await statfs(this.profiles.profileDataPath(id))
      const availableBytes = fileSystem.bavail * fileSystem.bsize
      const availableMb = Math.floor(availableBytes / 1024 / 1024)
      const status = availableBytes < 200 * 1024 * 1024 ? 'error' : availableBytes < 1024 * 1024 * 1024 ? 'warning' : 'pass'
      add('disk', '数据磁盘', status, `数据目录所在磁盘可用 ${availableMb.toLocaleString()} MB`)
    } catch {
      add('disk', '数据磁盘', 'error', '无法读取数据目录磁盘空间')
    }

    if (profile.proxy.protocol === 'direct') {
      add('proxy', '代理网络', 'warning', '当前使用本地直连网络，多个环境可能共享同一出口 IP')
    } else if (!profile.proxyCheck) {
      add('proxy', '代理网络', 'warning', '代理尚未检测，建议先确认出口 IP 和地区')
    } else if (!profile.proxyCheck.ok) {
      add('proxy', '代理网络', 'error', `最近一次代理检测失败：${safeErrorText(profile.proxyCheck.error ?? '连接失败')}`)
    } else {
      const stale = Date.now() - Date.parse(profile.proxyCheck.checkedAt) > 24 * 60 * 60 * 1000
      const geoConflict = profile.proxyCheck.geoConfidence === 'conflict'
      add('proxy', '代理网络', stale || profile.proxyCheck.degraded ? 'warning' : 'pass',
        `${profile.proxyCheck.ip ?? '代理可用'} · ${profile.proxyCheck.latencyMs} ms${stale ? ' · 结果已超过 24 小时' : ''}${profile.proxyCheck.geoConfidence === 'consensus' ? ' · GeoIP 双源一致' : ''}`)
      if (profile.proxyCheck.exitChanged) {
        add('proxy-exit', '出口稳定性', profile.fingerprint.proxyExitPolicy === 'block' ? 'error' : 'warning',
          `代理出口已从 ${profile.proxyCheck.previousIp ?? '原地址'} 变为 ${profile.proxyCheck.ip ?? '新地址'}`)
      } else {
        add('proxy-exit', '出口稳定性', 'pass', '最近两次检测未发现出口 IP 变化')
      }
      if (geoConflict) {
        add('timezone', '时区一致性', 'warning', `${profile.proxyCheck.geoConflict ?? 'GeoIP 数据源对代理地区或时区判断不一致'}；启动时将要求用户确认风险`)
      } else if (profile.proxyCheck.timezone && profile.proxyCheck.timezone !== profile.fingerprint.timezone) {
        add('timezone', '时区一致性', profile.fingerprint.networkIdentityMode === 'proxy' ? 'pass' : 'warning',
          profile.fingerprint.networkIdentityMode === 'proxy'
            ? `启动时自动使用代理时区 ${profile.proxyCheck.timezone}`
            : `代理为 ${profile.proxyCheck.timezone}，指纹为 ${profile.fingerprint.timezone}`)
      } else {
        add('timezone', '时区一致性', 'pass', '代理地区与指纹时区未发现冲突')
      }
      if (profile.fingerprint.networkIdentityMode === 'proxy') {
        const geoReady = Boolean(profile.proxyCheck.countryCode && profile.proxyCheck.timezone
          && profile.proxyCheck.latitude !== undefined && profile.proxyCheck.longitude !== undefined)
        add('geolocation', '地理身份', geoReady ? (geoConflict ? 'warning' : 'pass') : 'error', geoReady
          ? `${profile.proxyCheck.countryCode} · ${profile.proxyCheck.timezone} · 浏览器位置使用代理城市级坐标`
          : profile.proxyCheck.geoConflict ?? '自动网络身份缺少国家、时区或坐标，请重新检测代理')
      }
    }
    if (profile.proxy.protocol !== 'direct' && profile.fingerprint.webrtcPolicy === 'default') {
      add('webrtc', 'WebRTC', 'warning', 'WebRTC 为「允许」：不经过代理，会暴露本机公网地址')
    } else {
      add('webrtc', 'WebRTC', 'pass', profile.fingerprint.webrtcPolicy === 'proxy_only'
        ? 'WebRTC 走代理或只报代理地址，不暴露本机地址'
        : profile.fingerprint.webrtcPolicy === 'disabled' ? 'WebRTC 已关闭' : 'WebRTC 不提供任何地址')
    }
    if (profile.proxy.protocol !== 'direct') {
      add('dns', 'DNS 路由', 'pass', '域名解析、预取与 QUIC 均限制在代理路径，回环地址除外')
      add('ipv6', 'IPv6 路由', 'pass', profile.proxyCheck?.ipVersion === 6
        ? '代理出口已检测为 IPv6，WebRTC 不允许绕过代理'
        : '当前出口为 IPv4，宿主 IPv6 不允许通过 WebRTC 或直连 DNS 旁路')
    }

    const hardware = hardwareProfile(profile.fingerprint.hardwareProfileId)
    if (!hardware) {
      add('hardware', '硬件一致性', 'warning', '旧版自定义组合保持不变；新账号建议改用成套硬件模板')
    } else if (hardware.hostMatched && hardware.platform !== hostHardwareSnapshot().platform) {
      add('hardware', '硬件一致性', 'error', `${hardware.label} 不能在当前系统上使用`)
    } else {
      add('hardware', '硬件一致性', 'pass', `${hardware.label} · ${hardwareProfileSummary(hardware.id)}`)
      add('rendering', '渲染策略', 'pass', hardware.hostMatched
        ? 'GPU、字体、Canvas、Audio、ClientRects 使用本机原生结果'
        : `GPU 固定为 ${hardware.gpuModel}；Canvas、Audio、ClientRects 使用稳定原生结果`)
    }

    return {
      profileId: id,
      checkedAt: new Date().toISOString(),
      ready: !checks.some((check) => check.status === 'error'),
      checks
    }
  }

  private async withLaunchSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeLaunches >= this.maxConcurrentLaunches) {
      await new Promise<void>((resolve) => this.launchWaiters.push(resolve))
    }
    this.activeLaunches += 1
    try {
      return await operation()
    } finally {
      this.activeLaunches -= 1
      this.launchWaiters.shift()?.()
    }
  }

  private async recordCrash(id: string, record: BrowserCrashRecord): Promise<void> {
    const path = join(this.profiles.profileRuntimePath(id), 'crash-history.json')
    const temporary = `${path}.tmp`
    const history = [...await this.crashHistory(id), record].slice(-MAX_PROFILE_CRASH_RECORDS)
    await writeFile(temporary, JSON.stringify(history, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rm(path, { force: true })
    await rename(temporary, path)
  }

  private async guardProfileAvailable(id: string): Promise<void> {
    await this.profiles.assertProfileDataIdentity(id)
    let process
    try {
      process = findManagedProcess(await this.processInspector.list(), this.profiles.profileDataPath(id))
    } catch (error) {
      this.logger?.error('无法确认环境数据目录是否被占用', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      throw new Error('无法检查浏览器进程占用状态，为保护环境数据已取消启动')
    }
    if (!process) return
    this.orphanProcesses.set(id, process.pid)
    const profile = await this.profiles.setRuntime(id, {
      status: 'orphaned',
      lastError: `环境数据目录正被遗留浏览器进程占用（PID ${process.pid}）`
    })
    this.onChanged(profile)
    throw new Error('环境数据目录正被其他浏览器进程占用，请先结束遗留进程')
  }

  /**
   * The first launch keeps what it worked out: the country, time zone, languages and location of
   * the IP (基于 IP 生成), and this computer's screen and core count (跟随本机). Later launches,
   * on this computer or another, use the same values; a different IP is only pointed out.
   */
  private async lockOnLaunch(profile: BrowserProfile, allowGeoConflict: boolean): Promise<BrowserProfile> {
    const fp = profile.fingerprint
    const patch: Partial<FingerprintConfig> = {}
    if (fp.networkIdentityMode === 'proxy') Object.assign(patch, fixedIdentityForCheck(fp, profile.proxyCheck, { allowGeoConflict }) ?? {})
    const screen = this.hostScreen()
    if (fp.screenSource === 'host' && screen?.width && screen.height) {
      Object.assign(patch, { screenSource: undefined, screenWidth: screen.width, screenHeight: screen.height })
    }
    if (fp.coresSource === 'host') {
      Object.assign(patch, { coresSource: undefined, hardwareConcurrency: hostHardwareSnapshot().hardwareConcurrency })
    }
    if (!Object.keys(patch).length) return profile
    const locked = await this.profiles.lockFingerprint(profile.id, patch)
    this.onChanged(locked)
    this.logger?.info('窗口第一次打开，指纹值已固定', { profileId: profile.id, region: patch.region, timezone: patch.timezone, screen: patch.screenWidth && `${patch.screenWidth}×${patch.screenHeight}`, cores: patch.hardwareConcurrency })
    return locked
  }

  /**
   * An API window's proxy for this launch: its current one while it works (勾选: the window opens on
   * this IP; elsewhere or rotating, asked first); up to 3 new ones from the link when it stopped
   * working or was released (取消勾选). A new one still elsewhere: asked first.
   */
  private async apiProxyForLaunch(profile: BrowserProfile, allowGeoConflict: boolean): Promise<BrowserProfile> {
    const region = profile.fingerprint.region?.toUpperCase()
    const outcome = await apiProxyFor(this.profiles, profile.id, this.proxyTester, {
      region: allowGeoConflict ? undefined : region,
      keepWorking: true,
      attempts: 3,
      trigger: 'launch',
      // Where the link's server is, for the check log (not in tests with their own tester).
      locate: this.proxyTester === testProxy ? locateServer : undefined
    })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message.includes('白名单') ? message : `${message}${WHITELIST_HINT}`)
      })
    this.onChanged(outcome.profile)
    const { check } = outcome
    this.logger?.info('API 提取的代理', {
      profileId: profile.id,
      ip: check.ip,
      country: check.countryCode,
      newProxies: outcome.fetched,
      // Why the window's own proxy was not used: it did not answer, or (取消勾选) it was released.
      ...(outcome.replaced ? { replacedBecause: outcome.replaced.ok ? `出口 ${outcome.replaced.countryCode ?? '未知'}${outcome.replaced.rotating ? '，轮换' : ''}` : outcome.replaced.error ?? '连不上' } : {}),
      ...(profile.apiProxy?.released ? { replacedBecause: '取消勾选' } : {})
    })
    if (!check.ok) throw new Error(`${proxyLaunchError(check, 'warn') ?? '代理不可用'}${WHITELIST_HINT}`)
    if (outcome.mismatch && check.rotating) {
      throw new Error(`${GEOIP_CONFLICT_CONFIRMATION_PREFIX} 链接给的代理在轮换出口 IP（${check.geoConflict ?? check.ip}），没有再从 API 提取（这个链接给的都是轮换的，再取只会用掉提取次数）；网站会看到 IP 在变，请在代理商后台改成固定会话（粘性 IP）。是否仍要启动？`)
    }
    if (outcome.mismatch && !outcome.fetched) {
      const where = check.geoConfidence === 'conflict'
        ? `两个 IP 数据库对代理的国家判断不一致（${check.geoConflict ?? check.ip}）`
        : `这个窗口用的代理 IP 在 ${check.countryCode?.toUpperCase() ?? '未知国家'}（${check.ip}），窗口的国家是 ${region}`
      throw new Error(`${GEOIP_CONFLICT_CONFIRMATION_PREFIX} ${where}；窗口的时区和语言不会自动改，网站可能发现对不上。不想用这个 IP：在编辑页取消勾选它或点「换一个 IP」。是否仍要启动？`)
    }
    if (outcome.mismatch) {
      const where = check.geoConfidence === 'conflict'
        ? `两个 IP 数据库对代理的国家判断不一致（${check.geoConflict ?? check.ip}）`
        : `代理 IP 在 ${check.countryCode?.toUpperCase() ?? '未知国家'}（${check.ip}），窗口的国家是 ${region}`
      throw new Error(`${GEOIP_CONFLICT_CONFIRMATION_PREFIX} 从 API 换了 ${outcome.fetched} 次 IP 还是不对：${where}；窗口的时区和语言不会自动改，网站可能发现对不上。是否仍要启动？`)
    }
    return outcome.profile
  }

  private async refreshProxyForLaunch(profile: BrowserProfile, allowGeoConflict: boolean): Promise<BrowserProfile> {
    const result = await this.proxyTester(profile.proxy)
    const current = this.profiles.get(profile.id)
    if (!sameProxyIdentity(profile.proxy, current.proxy) || profile.proxy.password !== current.proxy.password) {
      throw new Error('启动检测期间代理配置已变更，请重新启动环境')
    }
    const updated = await this.profiles.setProxyCheck(profile.id, { ...result, checkedAt: new Date().toISOString() })
    this.onChanged(updated)
    const error = proxyLaunchError(updated.proxyCheck!, updated.fingerprint.proxyExitPolicy)
    // A proxy authorised by IP refuses another computer until its IP is added (common after a cloud restore).
    if (error) throw new Error(updated.proxyCheck?.ok ? error : `${error}${WHITELIST_HINT}`)
    if (updated.fingerprint.networkIdentityMode === 'proxy' && updated.proxyCheck?.geoConfidence === 'conflict' && !allowGeoConflict) {
      throw new Error(`${GEOIP_CONFLICT_CONFIRMATION_PREFIX} ${updated.proxyCheck.geoConflict ?? 'GeoIP 数据源对代理地区判断不一致'}；继续使用可能导致 IP 地区与时区、语言或地理位置不一致，影响指纹效果。是否仍要启动？`)
    }
    if (updated.fingerprint.networkIdentityMode === 'proxy' && !hasCompleteProxyIdentity(updated.proxyCheck, { allowGeoConflict })) {
      throw new Error('代理地理信息不完整，无法生成一致的时区、语言和地理位置；请重新检测或改用手动网络身份')
    }
    if (updated.proxyCheck?.geoConfidence === 'conflict' && allowGeoConflict) {
      this.logger?.error('用户已确认在 GeoIP 数据源冲突下继续启动', {
        profileId: profile.id,
        geoConflict: updated.proxyCheck.geoConflict
      })
    }
    if (updated.proxyCheck?.exitChanged) {
      this.logger?.error('代理出口 IP 已变化但策略允许继续', { profileId: profile.id })
    }
    // A window keeps its country; an IP somewhere else is pointed out (and, with 阻止启动, confirmed), never followed.
    const fp = updated.fingerprint
    const ipCountry = updated.proxyCheck?.ok ? updated.proxyCheck.countryCode?.toUpperCase() : undefined
    if (fp.networkIdentityMode !== 'proxy' && fp.region && ipCountry && ipCountry !== fp.region.toUpperCase()) {
      const where = `代理 IP 在 ${ipCountry}（${updated.proxyCheck!.ip}），窗口的国家是 ${fp.region.toUpperCase()}`
      if (fp.proxyExitPolicy === 'block' && !allowGeoConflict) {
        throw new Error(`${GEOIP_CONFLICT_CONFIRMATION_PREFIX} ${where}；窗口的时区和语言不会自动改，网站可能发现对不上。可以在编辑窗口里点「改成和 IP 一致」，或换一个这个国家的代理。是否仍要启动？`)
      }
      this.logger?.error('代理 IP 的国家和窗口的国家不一致', { profileId: profile.id, ipCountry, region: fp.region })
    }
    return updated
  }

  private async noteProxyBridgeFailure(id: string, error: unknown): Promise<void> {
    const running = this.processes.get(id)
    if (!running || running.expectedExit || running.proxyWarningIssued) return
    const failureKind = classifyProxyFailure(error)
    if (failureKind === 'unknown') return
    const now = Date.now()
    running.proxyFailureTimes = running.proxyFailureTimes.filter((time) => now - time <= 60_000)
    running.proxyFailureTimes.push(now)
    if (failureKind !== 'authentication' && running.proxyFailureTimes.length < 3) return
    running.proxyWarningIssued = true
    const message = failureKind === 'authentication'
      ? '代理认证在运行期间失败，请检查账号或代理授权；浏览器会继续尝试重连'
      : '代理连接在 60 秒内连续失败，出口网络可能已断开；浏览器会继续尝试重连'
    this.logger?.error('浏览器代理桥运行异常', {
      profileId: id,
      failureKind,
      error: safeErrorText(error)
    })
    if (this.profiles.get(id).fingerprint.proxyExitPolicy === 'block') {
      await this.quarantineProxyNetwork(id, message)
      return
    }
    this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: message }))
  }

  private async noteProxyBridgeTraffic(id: string): Promise<void> {
    const running = this.processes.get(id)
    if (!running || running.proxyQuarantined || running.proxyIdentityMismatch) return
    running.proxyFailureTimes = []
    if (!running.proxyWarningIssued) return
    running.proxyWarningIssued = false
    this.logger?.info('浏览器代理桥已恢复传输', { profileId: id })
    this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: undefined }))
  }

  private startProxyMonitor(id: string, proxy: ProxyConfig): void {
    const running = this.processes.get(id)
    if (!running || running.proxyMonitor) return
    running.proxyMonitor = setInterval(() => {
      void this.monitorProxyIdentity(id, proxy).catch((error) => {
        this.logger?.error('运行中代理出口复检失败', {
          profileId: id,
          error: safeErrorText(error)
        })
      })
    }, this.proxyMonitorIntervalMs)
    running.proxyMonitor.unref()
  }

  private async monitorProxyIdentity(id: string, proxy: ProxyConfig): Promise<void> {
    const running = this.processes.get(id)
    if (!running || running.expectedExit || running.proxyMonitorRunning || running.proxyQuarantined) return
    running.proxyMonitorRunning = true
    try {
      const current = this.profiles.get(id)
      if (!sameProxyIdentity(proxy, current.proxy) || proxy.password !== current.proxy.password) return
      const result = await this.proxyTester(proxy)
      const latest = this.profiles.get(id)
      if (!sameProxyIdentity(proxy, latest.proxy) || proxy.password !== latest.proxy.password) return
      const updated = await this.profiles.setProxyCheck(
        id,
        { ...result, checkedAt: new Date().toISOString() },
        running.proxyIdentityIp
      )
      this.onChanged(updated)
      if (!result.ok) {
        const message = `运行期间代理出口复检失败：${result.error ?? '无法连接代理'}`
        if (updated.fingerprint.proxyExitPolicy === 'block') {
          await this.quarantineProxyNetwork(id, message)
          return
        }
        await this.noteProxyBridgeFailure(id, new Error(result.error ?? result.failureKind ?? '代理出口复检失败'))
        return
      }
      if (!updated.proxyCheck?.exitChanged) {
        if (running.proxyIdentityMismatch && result.ip === running.proxyIdentityIp) {
          running.proxyIdentityMismatch = false
          running.proxyWarningIssued = false
          this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: undefined }))
        }
        return
      }
      running.proxyIdentityMismatch = true
      const message = `运行期间代理出口已从 ${updated.proxyCheck.previousIp ?? '启动地址'} 变为 ${updated.proxyCheck.ip ?? '新地址'}，当前浏览器网络身份已不一致`
      this.logger?.error('运行期间代理出口发生变化', { profileId: id })
      if (updated.fingerprint.proxyExitPolicy === 'block') {
        await this.quarantineProxyNetwork(id, message)
      } else {
        running.proxyWarningIssued = true
        this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: message }))
      }
    } finally {
      running.proxyMonitorRunning = false
    }
  }

  private async quarantineProxyNetwork(id: string, reason: string): Promise<void> {
    const running = this.processes.get(id)
    if (!running || running.proxyQuarantined) return
    running.proxyQuarantined = true
    running.proxyWarningIssued = true
    if (running.proxyMonitor) {
      clearInterval(running.proxyMonitor)
      running.proxyMonitor = undefined
    }
    await closeProxyBridge(running.proxyUrl)
    const message = `${reason}；已停止该环境的代理网络以防止身份泄漏，请关闭并重新启动环境`
    this.logger?.error('浏览器代理网络已隔离', { profileId: id, reason })
    this.onChanged(await this.profiles.setRuntime(id, { status: 'running', lastError: message }))
  }

  private async closeOrphan(id: string, pid: number): Promise<BrowserProfile> {
    this.onChanged(await this.profiles.setRuntime(id, { status: 'stopping', lastError: undefined }))
    try {
      await this.processInspector.terminate(pid, this.profiles.profileDataPath(id))
      this.orphanProcesses.delete(id)
      await rm(join(this.profiles.profileRuntimePath(id), 'process.json'), { force: true })
      const profile = await this.profiles.setRuntime(id, { status: 'closed', lastError: undefined })
      this.onChanged(profile)
      this.logger?.info('遗留浏览器进程已结束', { profileId: id, pid })
      return profile
    } catch (error) {
      const profile = await this.profiles.setRuntime(id, {
        status: 'orphaned',
        lastError: error instanceof Error ? error.message : String(error)
      })
      this.onChanged(profile)
      throw error
    }
  }

}

/** Chrome keeps the tabs to restore in Default/Sessions; a window never opened (or opened elsewhere and not brought here) has none. */
async function hasSavedSession(userDataDir: string): Promise<boolean> {
  try {
    return (await readdir(join(userDataDir, 'Default', 'Sessions'))).length > 0
  } catch {
    return false
  }
}
