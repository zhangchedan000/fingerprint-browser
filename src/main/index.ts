import { initializeUiLanguage } from './ui-language'
import { app, BrowserWindow, dialog, net, screen, session, shell } from 'electron'
import { parseProxyRule, setLocalProxyResolver } from './proxy-bridge'
import { TunnelManager } from './tunnel-manager'
import { registerTunnelIpc } from './tunnel-ipc'
import { resolveVaultLocation } from './vault-location'
import { registerVaultIpc } from './vault-ipc'
import { isAbsolute, join } from 'node:path'
import { BrowserLauncher } from './browser-launcher'
import { registerIpc } from './ipc'
import { ProfileStore } from './profile-store'
import { ElectronSecretCodec } from './secret-codec'
import { SettingsStore } from './settings-store'
import { KernelManager } from './kernel-manager'
import { AppLogger } from './app-logger'
import { ExtensionStore } from './extension-store'
import { CookieManager } from './cookie-manager'
import { publicProfile } from './profile-secrets'
import { ProfileBackupManager } from './profile-backup'
import { AppSessionTracker } from './app-session'
import { migrateMacLegacyKernelSelection } from './browser-locator'
import { WorkspaceMigrationManager } from './workspace-migration'
import { defaultKernelId, pinWindowsToCurrentKernel } from './kernel-pinning'
import { AppUpdater } from './app-updater'
import { registerAppUpdateIpc } from './app-update-ipc'
import { TeamManager } from './team/team-manager'
import { registerTeamIpc } from './team/team-ipc'

let mainWindow: BrowserWindow | null = null
let launcher: BrowserLauncher | null = null
let logger: AppLogger | null = null
let appSession: AppSessionTracker | null = null
let tunnel: TunnelManager | null = null
let team: TeamManager | null = null

if (process.platform === 'win32') app.setAppUserModelId('com.fingerprintbrowser.desktop')

if (process.env.PRISM_E2E === '1' && process.env.PRISM_E2E_USER_DATA && isAbsolute(process.env.PRISM_E2E_USER_DATA)) {
  app.setPath('userData', process.env.PRISM_E2E_USER_DATA)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 820,
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

  window.once('ready-to-show', () => window.show())
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
  const purgedTrashCount = await profiles.purgeTrashOlderThan(settings.get().recycleRetentionDays)
  if (purgedTrashCount) logger.info('已按保留策略自动清理环境回收站', { count: purgedTrashCount })
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
  registerVaultIpc(app.getPath('userData'), vaultPath, profiles, activeTunnel, logger)
  void activeTunnel.initialize()

  // A window proxy abroad is reached through the built-in tunnel when it runs, otherwise through
  // the computer's own system proxy (Clash, v2rayN…) when that is on. Domestic proxies stay direct.
  setLocalProxyResolver(async (host, port) => {
    const tunnelVia = activeTunnel.localProxy()
    if (tunnelVia) {
      const record = profiles.listProxies().find((item) => item.host.toLowerCase() === host.toLowerCase() && item.port === port)
      if (record?.check?.countryCode === 'CN') return undefined
      logger?.info('代理经加速通道连接', { proxy: `${host}:${port}` })
      return tunnelVia
    }
    const target = `https://${host.includes(':') ? `[${host}]` : host}:${port}/`
    const via = parseProxyRule(await session.defaultSession.resolveProxy(target))
    if (via) logger?.info('代理经本机代理连接', { via: `${via.type} ${via.host}:${via.port}` })
    return via
  })

  launcher = new BrowserLauncher(profiles, settings, (profile) => {
    mainWindow?.webContents.send('profiles:changed', publicProfile(profile))
  }, extensions, logger)
  // A proxy or group edited in its library changes how other windows look.
  profiles.onProfilesChanged((changed) => {
    for (const profile of changed) mainWindow?.webContents.send('profiles:changed', publicProfile(profile))
  })
  launcher.setHostScreenProvider(() => {
    const { width, height } = screen.getPrimaryDisplay().size
    return { width, height }
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
  // Windows keep the kernel they were created with; changing the default only affects new ones.
  profiles.setDefaultKernelResolver(() => defaultKernelId(settings, vaultPath))
  try {
    const pinning = await pinWindowsToCurrentKernel(profiles, settings, vaultPath)
    if (pinning) logger.info('已把跟随默认内核的窗口固定到当前内核', pinning)
  } catch (error) {
    logger.error('固定窗口内核失败', error)
  }
  const cookies = new CookieManager(profiles, settings, logger)
  const backups = new ProfileBackupManager(profiles, app.getVersion(), logger)
  const workspaceMigration = new WorkspaceMigrationManager(profiles, extensions, app.getVersion(), logger)
  const activeTeam = new TeamManager(vaultPath, profiles, cookies, new ElectronSecretCodec(), (event) => {
    mainWindow?.webContents.send('team:sync', event)
  }, logger)
  team = activeTeam
  await activeTeam.initialize()
  launcher.setLaunchHooks(activeTeam)
  registerTeamIpc(activeTeam)
  registerIpc({ profiles, settings, launcher, kernels, extensions, cookies, logger, backups, workspaceMigration, appSession, team: activeTeam })
  registerAppUpdateIpc(new AppUpdater(
    app.getVersion(),
    app.getPath('userData'),
    (progress) => mainWindow?.webContents.send('app:update-progress', progress),
    logger,
    (input, init) => net.fetch(input as string, init)
  ), profiles)
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
