import { initializeUiLanguage } from './ui-language'
import { app, BrowserWindow, dialog, ipcMain, net, screen, session, shell } from 'electron'
import { instrumentIpc, watchMainStalls } from './timing'
import { rememberIpZone } from './proxy-tester'
import { t } from '../shared/i18n'
import { parseProxyRule, setLocalProxyResolver, setSubscriptionResolver } from './proxy-bridge'
import { NODE_SERVER_DNS } from './tunnel-config'
import { TunnelManager } from './tunnel-manager'
import { registerTunnelIpc } from './tunnel-ipc'
import { adoptAppCacheKey, APP_CACHE_FOLDER, resolveVaultLocation, vaultPathSync } from './vault-location'
import { registerVaultIpc } from './vault-ipc'
import { isAbsolute, join } from 'node:path'
import { BrowserLauncher } from './browser-launcher'
import { registerIpc } from './ipc'
import { ProfileStore } from './profile-store'
import { ElectronSecretCodec } from './secret-codec'
import { SettingsStore, validPreferences } from './settings-store'
import { KernelManager } from './kernel-manager'
import { AppLogger } from './app-logger'
import { ExtensionStore } from './extension-store'
import { CookieManager, type StuckPrompt } from './cookie-manager'
import { publicProfile } from './profile-secrets'
import { ProfileBackupManager } from './profile-backup'
import { AppSessionTracker } from './app-session'
import { migrateMacLegacyKernelSelection } from './browser-locator'
import { WorkspaceMigrationManager } from './workspace-migration'
import { defaultKernelId, pinWindowsToCurrentKernel } from './kernel-pinning'
import electronUpdater from 'electron-updater'
import { AppUpdater, type UpdaterEngine } from './app-updater'
import { registerAppUpdateIpc } from './app-update-ipc'
import { installKernelFontPack } from './language-fonts'
import { ensureKernelFonts, KERNEL_FONT_PROGRESS } from './kernel-fonts'
import { TeamManager } from './team/team-manager'
import { TEAM_FEATURE_ENABLED } from '../shared/team'
import type { AppPreferences, ProxyDraft, TunnelRoute } from '../shared/types'
import { registerTeamIpc } from './team/team-ipc'
import { readWindowState, windowPlacement, writeWindowState } from './window-state'

let mainWindow: BrowserWindow | null = null
let launcher: BrowserLauncher | null = null
let logger: AppLogger | null = null
let appSession: AppSessionTracker | null = null
let tunnel: TunnelManager | null = null
let subscriptions: TunnelManager | null = null
let team: TeamManager | null = null

if (process.platform === 'win32') app.setAppUserModelId('com.fingerprintbrowser.desktop')

if (process.env.PRISM_E2E === '1' && process.env.PRISM_E2E_USER_DATA && isAbsolute(process.env.PRISM_E2E_USER_DATA)) {
  app.setPath('userData', process.env.PRISM_E2E_USER_DATA)
}

/** electron-updater for the installed Windows app; other builds update from the release page. */
function installedUpdater(log: AppLogger): UpdaterEngine | undefined {
  if (!app.isPackaged || process.platform !== 'win32' || process.env.PORTABLE_EXECUTABLE_FILE) return undefined
  const { autoUpdater } = electronUpdater
  autoUpdater.logger = {
    info: (message?: unknown) => log.info('自动更新', { message: String(message) }),
    warn: (message?: unknown) => log.info('自动更新', { warning: String(message) }),
    error: (message?: unknown) => log.error('自动更新出错', { message: String(message) }),
    debug: () => undefined
  }
  // Update tests serve their own latest.yml and installer.
  if (process.env.PRISM_E2E === '1' && process.env.PRISM_E2E_UPDATE_FEED) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.PRISM_E2E_UPDATE_FEED })
  }
  return autoUpdater
}

function createWindow(): BrowserWindow {
  // Opens the size and place it was last left at (the default size the first time).
  const stateFile = join(app.getPath('userData'), 'window-state.json')
  const placement = windowPlacement(
    readWindowState(stateFile),
    screen.getAllDisplays().map((display) => display.workArea),
    { width: 1320, height: 820 },
    { width: 1040, height: 680 }
  )
  const window = new BrowserWindow({
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: '指纹浏览器',
    backgroundColor: '#f3f5f9',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => {
    if (placement.maximized) window.maximize()
    window.show()
  })
  // The size it goes back to from maximized, kept here: not every platform reports it once maximized.
  let normalBounds = window.getBounds()
  let saveTimer: NodeJS.Timeout | undefined
  const saveState = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
    const maximized = window.isMaximized()
    if (!maximized) normalBounds = window.getBounds()
    writeWindowState(stateFile, { ...normalBounds, maximized })
  }
  const saveSoon = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveState, 500)
  }
  window.on('resize', saveSoon)
  window.on('move', saveSoon)
  window.on('maximize', saveSoon)
  window.on('unmaximize', saveSoon)
  window.on('close', () => {
    clearTimeout(saveTimer)
    saveState()
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') logger?.error('Renderer console error', event.message)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    logger?.error('Renderer load failed', { code, description, url })
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return window
}

// The launcher's own Chromium data stays in userData: its "Local State" holds the key safeStorage
// encrypts saved passwords with, so it cannot move with the data folder. 0.5.5 and 0.5.6 kept it
// in <data folder>/app-cache; a first install on those versions has its key only there.
adoptAppCacheKey(app.getPath('userData'), join(vaultPathSync(app.getPath('userData')), APP_CACHE_FOLDER))

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.whenReady().then(async () => {
  await initializeUiLanguage()
  const vaultLocation = await resolveVaultLocation(app.getPath('userData'))
  const vaultPath = vaultLocation.path
  logger = new AppLogger(vaultPath)
  appSession = new AppSessionTracker(vaultPath)
  const profiles = new ProfileStore(vaultPath, new ElectronSecretCodec())
  const settings = new SettingsStore(vaultPath)
  const extensions = new ExtensionStore(vaultPath, logger)
  await logger.initialize()
  // [计时] slow actions and main-process stalls go to the log (finding what makes the app feel slow).
  instrumentIpc(ipcMain, logger)
  watchMainStalls(logger)
  if (vaultLocation.missing) logger.error('设置的数据目录不存在，已改用默认位置', { missing: vaultLocation.missing })
  const appSessionSnapshot = await appSession.begin(app.getVersion())
  if (appSessionSnapshot.previousUnclean) {
    logger.error('检测到上次指纹浏览器未正常退出', appSessionSnapshot.previousUnclean)
  }
  await Promise.all([profiles.initialize(), settings.initialize(), extensions.initialize()])
  const kernelMigration = await migrateMacLegacyKernelSelection(settings, vaultPath)
  if (kernelMigration.migrated) {
    logger.info('已将 macOS 旧版托管内核切换为应用内置新版内核', {
      previousVersion: kernelMigration.previousVersion,
      bundledVersion: kernelMigration.bundledVersion
    })
  }
  // The time zones decided for exit IPs before: the same IP keeps its zone (proxy-tester sameIpZone).
  for (const check of [...profiles.list().map((profile) => profile.proxyCheck), ...profiles.listProxies().map((proxy) => proxy.check)]) {
    if (check) rememberIpZone(check)
  }
  const purgedTrash = await profiles.purgeTrashOlderThan(settings.get().recycleRetentionDays)
  if (purgedTrash.length) logger.info('已按保留策略自动清理环境回收站', { count: purgedTrash.length })
  const profileStorageHealth = profiles.storageHealth()
  if (profileStorageHealth.recoveredFromBackup) logger.error('环境元数据已从备份恢复', profileStorageHealth)
  if (!profileStorageHealth.backupHealthy) logger.error('环境元数据备份不可用', profileStorageHealth.backupError)
  logger.info('指纹浏览器已启动', { version: app.getVersion(), platform: process.platform, arch: process.arch })

  const tunnelBinary = process.env.TUNNEL_CORE_BIN
    || (app.isPackaged
      ? join(process.resourcesPath, 'tunnel-core', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo')
      : join(app.getAppPath(), 'build', 'tunnel-core', 'current', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'))
  const activeTunnel = new TunnelManager(vaultPath, new ElectronSecretCodec(), tunnelBinary, logger,
    (status) => mainWindow?.webContents.send('tunnel:changed', status))
  tunnel = activeTunnel
  registerTunnelIpc(activeTunnel)

  // 订阅: the account's subscriptions run in their own copy of the core (nodes as window exits). A
  // window with 网络加速 on reaches its node through its own route on the acceleration core (自动, or
  // the acceleration node it is fixed to), over SOCKS5 with UDP so Hysteria / TUIC nodes go too; with
  // the tunnel unable to start that fails rather than going out from this computer's own IP.
  const chainRoute = async (route: TunnelRoute) => {
    await activeTunnel.ensureRunning(route)
    return (await activeTunnel.routeProxy(route)).port
  }
  const subscriptionNodes = new TunnelManager(join(vaultPath, 'subscriptions'), new ElectronSecretCodec(), tunnelBinary, logger,
    (status) => mainWindow?.webContents.send('subscriptions:changed', status), undefined, undefined, { slotCount: 64, alwaysOn: true, chainRoute, serverDns: NODE_SERVER_DNS })
  subscriptions = subscriptionNodes
  registerTunnelIpc(subscriptionNodes, 'subscriptions', {
    // Windows name their subscription: renamed, they follow (here and, through their configs, elsewhere).
    renamed: async (from, to) => {
      const windows = await profiles.renameSubscription(from, to)
      await team?.pushConfigs(windows)
      mainWindow?.webContents.send('proxy:changed')
    }
  })
  void subscriptionNodes.initialize()
  setSubscriptionResolver((node, route) => subscriptionNodes.nodeProxy(node, route))
  registerVaultIpc(app.getPath('userData'), vaultPath, profiles, activeTunnel, logger)
  void activeTunnel.initialize()

  // A window set to 网络加速 reaches its proxy through the built-in tunnel, on its own node choice.
  // Windows from before that setting existed keep the old rule: a proxy abroad through the tunnel
  // when it runs, otherwise through the computer's own system proxy (Clash, v2rayN…) when that is
  // on; domestic proxies direct. A window with 网络加速 off connects like the latter.
  // Every browser connection asks: each route is logged once (not a line per connection).
  const loggedRoutes = new Set<string>()
  const logRoute = (message: string, details: Record<string, unknown>) => {
    const key = `${message}|${JSON.stringify(details)}`
    if (loggedRoutes.has(key)) return
    if (loggedRoutes.size > 500) loggedRoutes.clear()
    loggedRoutes.add(key)
    logger?.info(message, details)
  }
  setLocalProxyResolver(async (host, port, route) => {
    if (route?.enabled) {
      const via = await activeTunnel.routeProxy(route)
      logRoute('代理经网络加速连接', { proxy: `${host}:${port}`, node: route.mode === 'manual' ? route.node : '自动' })
      return via
    }
    const tunnelVia = route ? undefined : activeTunnel.localProxy()
    if (tunnelVia) {
      const record = profiles.listProxies().find((item) => item.host.toLowerCase() === host.toLowerCase() && item.port === port)
      if (record?.check?.countryCode === 'CN') return undefined
      logRoute('代理经加速通道连接', { proxy: `${host}:${port}` })
      return tunnelVia
    }
    const target = `https://${host.includes(':') ? `[${host}]` : host}:${port}/`
    const via = parseProxyRule(await session.defaultSession.resolveProxy(target))
    if (via) logRoute('代理经本机代理连接', { via: `${via.type} ${via.host}:${via.port}` })
    return via
  })

  launcher = new BrowserLauncher(profiles, settings, (profile) => {
    mainWindow?.webContents.send('profiles:changed', publicProfile(profile))
  }, extensions, logger)
  // A proxy or group edited in its library changes how other windows look.
  profiles.onProfilesChanged((changed) => {
    for (const profile of changed) mainWindow?.webContents.send('profiles:changed', publicProfile(profile))
  })
  // A library proxy's check or IP 评分 (from any window or the proxy page): the pages showing it reload it.
  profiles.onLibraryChecksChanged(() => mainWindow?.webContents.send('proxy:changed'))
  launcher.setHostScreenProvider(() => {
    const { size, workArea, scaleFactor } = screen.getPrimaryDisplay()
    // Only a taskbar along the bottom (or top) shortens the screen's available height.
    const taskbarHeight = workArea.width === size.width ? size.height - workArea.height : 0
    return { width: size.width, height: size.height, taskbarHeight, scaleFactor }
  })
  await launcher.initialize()
  const kernels = new KernelManager(
    vaultPath,
    settings,
    (progress) => mainWindow?.webContents.send('engine:progress', progress),
    logger,
    (version) => profiles.kernelUsers(version),
    (input, init) => net.fetch(input as string, init)
  )
  // A window from another computer opens here as it is: its kernel, 网络加速 and font pack are fetched.
  // Windows needing the same missing kernel wait for one download.
  const kernelInstalls = new Map<string, Promise<void>>()
  // Fonts go into the kernels one download at a time.
  let fontInstall: Promise<void> = Promise.resolve()
  launcher.setPrerequisites({
    installKernel: (version) => {
      const pending = kernelInstalls.get(version) ?? kernels.install(version).then(() => undefined).finally(() => kernelInstalls.delete(version))
      kernelInstalls.set(version, pending)
      return pending
    },
    ensureTunnel: (route) => activeTunnel.ensureRunning(route),
    ensureKernelFontStore: (kernelExecutable) => {
      const run = fontInstall.then(() => ensureKernelFonts(kernelExecutable, vaultPath, (input, init) => net.fetch(input as string, init),
        (progress) => mainWindow?.webContents.send('fonts:progress', { script: KERNEL_FONT_PROGRESS, ...progress }), undefined, logger ?? undefined))
      fontInstall = run.catch(() => undefined)
      return run
    },
    ensureKernelFonts: (script, kernelExecutable, windows) => {
      const run = fontInstall.then(() => installKernelFontPack(script, kernelExecutable, windows, (input, init) => net.fetch(input as string, init),
        (progress) => mainWindow?.webContents.send('fonts:progress', progress), logger ?? undefined))
      fontInstall = run.catch(() => undefined)
      return run
    }
  })
  // Windows keep the kernel they were created with; changing the default only affects new ones.
  profiles.setDefaultKernelResolver(() => defaultKernelId(settings, vaultPath))
  try {
    const pinning = await pinWindowsToCurrentKernel(profiles, settings, vaultPath)
    if (pinning) logger.info('已把跟随默认内核的窗口固定到当前内核', pinning)
  } catch (error) {
    logger.error('固定窗口内核失败', error)
  }
  const cookies = new CookieManager(profiles, settings, logger)
  // A browser still running long after it was asked to close, with nothing written for a while:
  // the user decides whether to keep waiting (safer) or end it.
  const stuckPrompt: StuckPrompt = async (name, seconds, doing) => {
    logger?.error('[登录态] 浏览器好像卡住了，问用户', { name, seconds, doing })
    const options = {
      type: 'warning' as const,
      buttons: [t("继续等"), t("强制结束")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: t("浏览器好像卡住了"),
      message: doing === 'close'
        ? t("窗口「{0}」关闭了 {1} 秒还没退出", name, seconds)
        : t("窗口「{0}」写入登录状态 {1} 秒还没完成", name, seconds),
      detail: t("最近 10 秒窗口数据没有任何写入，可能卡住了。继续等最安全；强制结束可能丢掉最后几秒的改动（比如刚续期的登录）。")
    }
    const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
    const choice = response === 1 ? 'force' : 'wait'
    logger?.info('[登录态] 用户选择', { name, choice: choice === 'force' ? '强制结束' : '继续等' })
    return choice
  }
  cookies.setStuckPrompt(stuckPrompt)
  launcher.setStuckPrompt(stuckPrompt)
  const backups = new ProfileBackupManager(profiles, app.getVersion(), logger)
  const workspaceMigration = new WorkspaceMigrationManager(profiles, extensions, app.getVersion(), logger)
  const activeTeam = new TeamManager(vaultPath, profiles, cookies, new ElectronSecretCodec(), (event) => {
    mainWindow?.webContents.send('team:sync', event)
  }, logger)
  team = activeTeam
  // Team off (TEAM_FEATURE_ENABLED): no sign-in and no server, windows stay plain local windows.
  activeTeam.enabled = TEAM_FEATURE_ENABLED
  // A window's 网络加速 nodes go to the cloud with it, and come along to other computers.
  activeTeam.tunnelSources = (route) => activeTunnel.sourcesFor(route)
  activeTeam.adoptTunnelSources = (sources) => activeTunnel.adoptSources(sources)
  // One set of libraries for the account on every computer (team_workspaces): the proxy library, the
  // groups, the 网络加速 node sources and the settings that are the account's (check sites, batch gap,
  // recycle-bin days). Whether 网络加速 is on, the theme and folders stay this computer's own.
  const accountSettings = () => {
    const current = settings.get()
    return {
      deepCheckSites: current.deepCheckSites ?? null,
      ipCheckSites: current.ipCheckSites ?? null,
      ipCheckBaseline: current.ipCheckBaseline ?? null,
      batchLaunchGapSeconds: current.batchLaunchGapSeconds,
      recycleRetentionDays: current.recycleRetentionDays
    }
  }
  activeTeam.workspaceExport = async () => ({
    proxies: profiles.listProxies().map(({ protocol, host, port, username, password, note, apiUrl, subscription, tunnel }) => ({ protocol, host, port, username, password, note, apiUrl, subscription, tunnel })),
    tunnelSources: activeTunnel.sourcesFor({ enabled: true, mode: 'auto' }),
    subscriptions: subscriptionNodes.sourcesFor({ enabled: true, mode: 'auto' }),
    groups: profiles.listGroups().map(({ name, color, note }) => ({ name, color, note })),
    settings: accountSettings()
  })
  activeTeam.workspaceImport = async (data, mode) => {
    const value = (data && typeof data === 'object' ? data : {}) as { proxies?: unknown; tunnelSources?: unknown; subscriptions?: unknown; groups?: unknown; settings?: unknown }
    if (mode === 'mirror') {
      // Each part only when the account's copy has it (an older version sent proxies and nodes only).
      if (Array.isArray(value.proxies)) await profiles.mirrorProxies(value.proxies)
      if (Array.isArray(value.groups)) await profiles.mirrorGroups(value.groups)
      if (Array.isArray(value.tunnelSources)) await activeTunnel.mirrorSources(value.tunnelSources)
      if (Array.isArray(value.subscriptions)) await subscriptionNodes.mirrorSources(value.subscriptions)
      if (value.settings && typeof value.settings === 'object') {
        const wanted = value.settings as Partial<Record<keyof ReturnType<typeof accountSettings>, unknown>>
        const next = validPreferences({
          ...settings.get(),
          deepCheckSites: (wanted.deepCheckSites ?? undefined) as AppPreferences['deepCheckSites'],
          ipCheckSites: (wanted.ipCheckSites ?? undefined) as AppPreferences['ipCheckSites'],
          ipCheckBaseline: (wanted.ipCheckBaseline ?? undefined) as AppPreferences['ipCheckBaseline'],
          batchLaunchGapSeconds: Number(wanted.batchLaunchGapSeconds ?? settings.get().batchLaunchGapSeconds)
        })
        const days = Number(wanted.recycleRetentionDays)
        await settings.update({
          deepCheckSites: next.deepCheckSites,
          ipCheckSites: next.ipCheckSites,
          ipCheckBaseline: next.ipCheckBaseline,
          batchLaunchGapSeconds: next.batchLaunchGapSeconds,
          ...(days === 0 || days === 7 || days === 30 || days === 90 ? { recycleRetentionDays: days as 0 | 7 | 30 | 90 } : {})
        })
      }
    } else {
      // First time on this computer: add what it lacks, keep what it has.
      if (Array.isArray(value.proxies) && value.proxies.length) {
        const result = await profiles.createProxies(value.proxies as ProxyDraft[])
        if (result.created.length) logger?.info('从团队服务器补回代理', { added: result.created.length })
      }
      if (Array.isArray(value.groups)) {
        const known = new Set(profiles.listGroups().map((group) => group.name))
        for (const group of value.groups as Array<{ name?: unknown; color?: unknown; note?: unknown }>) {
          if (typeof group?.name !== 'string' || known.has(group.name.trim())) continue
          await profiles.createGroup({ name: group.name, color: typeof group.color === 'string' ? group.color : undefined, note: typeof group.note === 'string' ? group.note : '' }).catch(() => undefined)
        }
      }
      await activeTunnel.adoptSources(value.tunnelSources)
      await subscriptionNodes.adoptSources(value.subscriptions)
    }
    mainWindow?.webContents.send('proxy:changed')
    mainWindow?.webContents.send('profiles:reload')
  }
  // A window's extensions go to other computers with its login state.
  activeTeam.extensions = extensions
  activeTeam.onProfileAdded = (id) => mainWindow?.webContents.send('profiles:changed', publicProfile(profiles.get(id)))
  // Windows changed, deleted or restored on another computer of the account: the list reloads.
  activeTeam.onProfilesChanged = () => mainWindow?.webContents.send('profiles:reload')
  // A new window's seed is none the team's cloud windows use (the seed decides Canvas and AudioContext).
  profiles.setSeedsInUse(() => activeTeam.seedsInUse())
  await activeTeam.initialize()
  // Windows past the recycle-bin retention: deleted here only (the cloud keeps them), noted once signed in.
  if (purgedTrash.length) void activeTeam.whenOnline().then(() => activeTeam.purged(purgedTrash)).catch((error: unknown) => {
    logger?.error('回收站自动清理的团队窗口没能记下', { error: error instanceof Error ? error.message : String(error) })
  })
  launcher.setLaunchHooks(activeTeam)
  registerTeamIpc(activeTeam)
  registerIpc({ profiles, settings, launcher, kernels, extensions, cookies, logger, backups, workspaceMigration, appSession, team: activeTeam })
  registerAppUpdateIpc(new AppUpdater(
    app.getVersion(),
    (progress) => mainWindow?.webContents.send('app:update-progress', progress),
    installedUpdater(logger),
    logger,
    (input, init) => net.fetch(input as string, init)
  ), profiles, async () => { await team?.flush() })
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}).catch(async (error) => {
  logger?.error('指纹浏览器启动失败', error)
  await logger?.flush()
  dialog.showErrorBox(
    '指纹浏览器无法启动',
    '应用启动失败，但现有环境数据没有被修改。请重新启动；如仍然失败，请查看日志文件。'
  )
  app.quit()
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('before-quit', (event) => {
  void tunnel?.stop()
  void subscriptions?.stop()
  if (!launcher) return
  event.preventDefault()
  const current = launcher
  launcher = null
  void current.closeAll().catch((error) => logger?.error('关闭浏览器环境失败', error)).finally(async () => {
    // Team windows upload their login state after closing; quitting must not cut that off.
    await team?.flush()
    logger?.info('指纹浏览器已退出')
    await appSession?.complete().catch((error) => logger?.error('清理应用会话标记失败', error))
    await logger?.flush()
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtExceptionMonitor', (error) => {
  logger?.error('主进程未捕获异常', error)
})

process.on('unhandledRejection', (reason) => {
  logger?.error('主进程未处理 Promise 拒绝', reason)
  console.error(reason)
})
