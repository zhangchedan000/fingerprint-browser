import { t } from '../shared/i18n'
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AppPreferences, BrowserProfile, FingerprintCheckReport, ProfileDraft, ProxyConfig, ProxyDraft } from '../shared/types'
import type { KernelManager } from './kernel-manager'
import { listBundledBrowsers, locateBrowser, locateBrowserForProfile, locateBundledBrowser, normalizeBrowserSelection } from './browser-locator'
import { DEFAULT_DEEP_CHECK_SITES, type DeepCheckRecord } from '../shared/deep-check'
import { deepCheck, evaluateFingerprint, expectedIdentity, FingerprintCheckStore, observeFingerprint } from './fingerprint-check'
import type { DeepSiteResult } from '../shared/deep-check'
import { checkedSettingsKey, checkProxyKey } from '../shared/fingerprint-check-key'
import { hostHardwareSnapshot } from './host-hardware'
import { mergeKernelCatalog } from './kernel-catalog'
import type { BrowserLauncher } from './browser-launcher'
import type { AssignPatch, ProfileStore } from './profile-store'
import { validPreferences, type SettingsStore } from './settings-store'
import { testProxy } from './proxy-tester'
import { localProxyFor } from './proxy-bridge'
import { proxySupportsUdp } from './webrtc-relay'
import { validateProfileDraft, validateProxyConfig, validProxyApiUrl } from '../shared/validation'
import { resolveApiProxy } from './api-proxy'
import type { AppLogger } from './app-logger'
import { parseProfileConfig, safeProfileFileName, serializeProfileConfig } from './profile-transfer'
import { clearProfileCache, profileStorageInfo, storageOverview } from './profile-data'
import type { ExtensionStore } from './extension-store'
import type { CookieManager } from './cookie-manager'
import { parseCookieFile, serializeCookieFile } from './cookie-file'
import { randomUUID } from 'node:crypto'
import { analyzeBatchTable, batchTemplateRows, errorRows, importFormat, readImportTable, serializeCsv, serializeXlsx, type AnalyzedTable, type ImportFileFormat } from './profile-batch-import'
import { proxyForTest, publicGroupRecord, publicProfile, publicProxyRecord, sameProxyIdentity } from './profile-secrets'
import type { ProfileBackupManager } from './profile-backup'
import type { AppSessionTracker } from './app-session'
import type { WorkspaceMigrationManager } from './workspace-migration'
import type { TeamManager } from './team/team-manager'

interface IpcDependencies {
  profiles: ProfileStore
  settings: SettingsStore
  launcher: BrowserLauncher
  kernels: KernelManager
  extensions: ExtensionStore
  cookies: CookieManager
  logger: AppLogger
  backups: ProfileBackupManager
  workspaceMigration: WorkspaceMigrationManager
  appSession: AppSessionTracker
  team: TeamManager
}

export function registerIpc({ profiles, settings, launcher, kernels, extensions, cookies, logger, backups, workspaceMigration, appSession, team }: IpcDependencies): void {
  ipcMain.handle('profiles:list', () => profiles.list().map(publicProfile))
  ipcMain.handle('profiles:storage-health', () => profiles.storageHealth())
  // Every window is a cloud window: new ones here go up shortly after (team.sync).
  ipcMain.handle('profiles:create', async (_event, draft: ProfileDraft) => {
    const profile = publicProfile(await profiles.create(draft))
    team.scheduleSync()
    return profile
  })
  ipcMain.handle('profiles:update', async (_event, id: string, draft: ProfileDraft) => {
    team.assertEditable(id)
    const profile = publicProfile(await profiles.update(id, draft))
    await team.afterLocalEdit(id)
    return profile
  })
  ipcMain.handle('profiles:duplicate', async (_event, id: string) => {
    team.assertEditable(id)
    const profile = publicProfile(await profiles.duplicate(id))
    team.scheduleSync()
    return profile
  })
  ipcMain.handle('profiles:export-config', async (_event, id: string) => {
    team.assertEditable(id)
    const profile = profiles.get(id)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭环境再导出配置')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: t('导出环境配置'),
      defaultPath: safeProfileFileName(profile.name),
      filters: [{ name: '指纹浏览器环境配置', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, serializeProfileConfig(profile), { encoding: 'utf8', mode: 0o600 })
    logger.info('环境配置已导出', { profileId: id })
    return result.filePath
  })
  ipcMain.handle('profiles:import-config', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: t('导入环境配置'),
      properties: ['openFile'],
      filters: [{ name: '指纹浏览器环境配置', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if ((await stat(path)).size > 1024 * 1024) throw new Error('环境配置文件不能超过 1 MB')
    const profile = await profiles.create(parseProfileConfig(await readFile(path, 'utf8')))
    logger.info('环境配置已导入', { profileId: profile.id })
    team.scheduleSync()
    return publicProfile(profile)
  })
  // One pending import at a time: the preview keeps the checked rows here until commit.
  let pendingImport: { token: string; fileName: string; format: ImportFileFormat; table: AnalyzedTable; committed: boolean } | undefined
  const pendingFor = (token: string) => {
    if (!pendingImport || pendingImport.token !== token) throw new Error('导入预览已失效，请重新选择文件')
    return pendingImport
  }
  ipcMain.handle('profiles:batch-import-preview', async (_event, requestedPath?: string) => {
    let path = typeof requestedPath === 'string' && requestedPath ? requestedPath : undefined
    if (!path) {
      const owner = BrowserWindow.getFocusedWindow()
      const options: Electron.OpenDialogOptions = {
        title: t('批量导入窗口'),
        properties: ['openFile'],
        filters: [{ name: t('表格文件'), extensions: ['xlsx', 'csv', 'txt'] }]
      }
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }
    const format = importFormat(path)
    const info = await stat(path)
    if (!info.isFile()) throw new Error('只支持 .xlsx、.csv 或 .txt 文件')
    if (info.size > 5 * 1024 * 1024) throw new Error('导入文件不能超过 5 MB')
    const table = analyzeBatchTable(await readImportTable(path, await readFile(path)), profiles.list().length + 1)
    const token = randomUUID()
    pendingImport = { token, fileName: basename(path), format, table, committed: false }
    const valid = table.rows.filter((row) => row.draft).length
    return { token, fileName: basename(path), valid, invalid: table.rows.length - valid, rows: table.rows.map((row) => row.view) }
  })
  ipcMain.handle('profiles:batch-import-commit', async (_event, token: string, options: { defaultGroup?: unknown }) => {
    const pending = pendingFor(token)
    if (pending.committed) throw new Error('这批窗口已经导入')
    const defaultGroup = typeof options?.defaultGroup === 'string' ? options.defaultGroup.trim() : ''
    const rows = pending.table.rows.filter((row) => row.draft)
    if (!rows.length) throw new Error('没有可导入的有效行')
    pending.committed = true
    let created
    try {
      created = await profiles.createMany(rows.map((row) => ({ ...row.draft!, group: row.draft!.group || defaultGroup })))
    } catch (error) {
      pending.committed = false
      throw error
    }
    let cookiesImported = 0
    const cookieErrors: Array<{ name: string; message: string }> = []
    for (const [index, row] of rows.entries()) {
      if (!row.cookieText) continue
      const profile = created[index]
      try {
        cookiesImported += await cookies.importCookies(profile.id, parseCookieFile(row.cookieText))
      } catch (error) {
        cookieErrors.push({ name: profile.name, message: error instanceof Error ? error.message : String(error) })
      }
    }
    logger.info('已批量导入窗口', { count: created.length, skipped: pending.table.rows.length - rows.length, cookieErrors: cookieErrors.length })
    team.scheduleSync()
    return { created: created.map(publicProfile), skipped: pending.table.rows.length - rows.length, cookiesImported, cookieErrors }
  })
  ipcMain.handle('profiles:batch-import-save-errors', async (_event, token: string) => {
    const pending = pendingFor(token)
    if (pending.table.rows.every((row) => row.draft)) throw new Error('没有错误行')
    const extension = pending.format === 'xlsx' ? 'xlsx' : 'csv'
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: t('保存错误行'),
      defaultPath: `${pending.fileName.replace(/\.[^.]+$/, '')}-${t('错误行')}.${extension}`,
      filters: [{ name: t('表格文件'), extensions: [extension] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const rows = errorRows(pending.table)
    await writeFile(result.filePath, extension === 'xlsx' ? await serializeXlsx(rows) : serializeCsv(rows), { mode: 0o600 })
    return result.filePath
  })
  ipcMain.handle('profiles:export-batch-template', async (_event, format: unknown) => {
    const extension = format === 'csv' ? 'csv' : 'xlsx'
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: t('保存导入模板'),
      defaultPath: `${t('批量导入模板')}.${extension}`,
      filters: [{ name: t('表格文件'), extensions: [extension] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const rows = batchTemplateRows()
    await writeFile(result.filePath, extension === 'xlsx' ? await serializeXlsx(rows) : serializeCsv(rows), { mode: 0o600 })
    return result.filePath
  })
  ipcMain.handle('profiles:storage-info', async (_event, id: string) => {
    profiles.get(id)
    await profiles.assertProfileDataIdentity(id)
    return profileStorageInfo(profiles.profileDataPath(id))
  })
  ipcMain.handle('profiles:storage-overview', () => storageOverview(profiles.vaultPath))
  // Fingerprint check: the draft's exact launch setup in a throwaway profile, so the window's own
  // data is never touched and an unsaved draft can be checked too.
  const fingerprintChecks = new FingerprintCheckStore(join(profiles.vaultPath, 'fingerprint-checks.json'))
  ipcMain.handle('profiles:last-fingerprint-check', (_event, id: string) => fingerprintChecks.get(id))
  /** The check browser's settings for an editor draft: same kernel, proxy and hardware as a real launch. */
  async function checkRunOptions(draft: ProfileDraft, profileId?: string) {
    const validated = validateProfileDraft(draft)
    const existing = profileId ? profiles.get(profileId) : undefined
    let proxy: ProxyConfig
    if (draft.proxyId) {
      const { protocol, host, port, username, password, apiUrl } = profiles.getProxy(draft.proxyId)
      // An API proxy is checked with a fresh one, as a launch would get.
      proxy = apiUrl ? { ...await resolveApiProxy(apiUrl) } : { protocol, host, port, username, password }
    } else {
      proxy = proxyForTest(validateProxyConfig(draft.proxy), existing?.proxy)
    }
    const engine = await locateBrowserForProfile(settings, profiles.vaultPath, validated.kernelVersion)
    if (!engine.executable) {
      throw new Error(validated.kernelVersion ? `内核 ${validated.kernelVersion} 不可用，请先安装` : '没有找到浏览器内核，请先在内核管理里下载或导入')
    }
    const proxyResult = proxy.protocol === 'direct' ? undefined : await testProxy(proxy)
    if (proxyResult && !proxyResult.ok) throw new Error(`代理不通，无法检测：${proxyResult.error ?? '连接失败'}`)
    const profile = {
      ...validated,
      id: profileId ?? 'fingerprint-check',
      serialNumber: existing?.serialNumber ?? 0,
      groupId: '',
      proxyId: draft.proxyId ?? '',
      proxy,
      favorite: false,
      status: 'closed',
      createdAt: '',
      updatedAt: ''
    } as unknown as BrowserProfile
    const host = hostHardwareSnapshot()
    const { width, height } = screen.getPrimaryDisplay().size
    const runOptions = {
      profile,
      engine,
      proxy: proxyResult,
      hostHardwareConcurrency: host.hardwareConcurrency,
      hostPlatformVersion: host.platformVersion,
      hostScreen: { width, height },
      // Same switch the launcher honours for automated runs.
      headless: process.env.PRISM_E2E === '1' && process.env.PRISM_E2E_BROWSER_HEADLESS === '1',
      logger
    }
    return { validated, proxy, engine, proxyResult, runOptions }
  }

  /** A window's last deep check, screenshots included, lives in its runtime folder. */
  const deepCheckFile = (id: string) => join(profiles.profileRuntimePath(id), 'deep-check.json')
  ipcMain.handle('profiles:deep-check', async (event, draft: ProfileDraft, profileId?: string, settingsKey?: string): Promise<DeepSiteResult[]> => {
    const { runOptions } = await checkRunOptions(draft, profileId)
    const sites = (settings.get().deepCheckSites ?? DEFAULT_DEEP_CHECK_SITES).filter((site) => site.enabled)
    if (!sites.length) throw new Error('检测网站都关掉了，请点「检测网站」打开至少一个')
    const results = await deepCheck(runOptions, sites, (result) => event.sender.send('profiles:deep-check-progress', result))
    if (profileId) {
      const record: DeepCheckRecord = { checkedAt: new Date().toISOString(), ...(typeof settingsKey === 'string' ? { checkedSettings: settingsKey } : {}), results }
      await mkdir(profiles.profileRuntimePath(profileId), { recursive: true })
      await writeFile(deepCheckFile(profileId), JSON.stringify(record), { mode: 0o600 }).catch((error) => {
        logger.error('保存深度检测结果失败', { profileId, error: error instanceof Error ? error.message : String(error) })
      })
    }
    return results
  })
  ipcMain.handle('profiles:last-deep-check', async (_event, id: string): Promise<DeepCheckRecord | null> => {
    profiles.get(id)
    return readFile(deepCheckFile(id), 'utf8').then((text) => JSON.parse(text) as DeepCheckRecord).catch(() => null)
  })
  ipcMain.handle('profiles:check-fingerprint', async (_event, draft: ProfileDraft, profileId?: string, settingsKey?: string): Promise<FingerprintCheckReport> => {
    const { validated, proxy, engine, proxyResult, runOptions } = await checkRunOptions(draft, profileId)
    const observed = await observeFingerprint(runOptions)
    const windows = profiles.list()
    const others = Object.entries(await fingerprintChecks.all())
      .filter(([id]) => id !== profileId)
      .flatMap(([id, report]) => {
        const window = windows.find((item) => item.id === id)
        return window ? [{ label: `#${window.serialNumber} ${window.name}`, observed: report.observed, disabledSpoofing: window.fingerprint.disabledSpoofing }] : []
      })
    const report: FingerprintCheckReport = {
      checkedAt: new Date().toISOString(),
      kernelVersion: engine.version,
      // The editor's own key for what it sent, so a fresh result never reads as out of date there.
      checkedSettings: typeof settingsKey === 'string' ? settingsKey : checkedSettingsKey(validated.fingerprint, validated.kernelVersion || engine.version, checkProxyKey(draft.proxyId, proxy)),
      exitIp: proxyResult?.ip,
      observed,
      items: evaluateFingerprint({
        fingerprint: validated.fingerprint,
        engine,
        observed,
        expected: expectedIdentity(runOptions.profile, runOptions),
        proxy: proxyResult,
        usesProxy: proxy.protocol !== 'direct',
        others
      })
    }
    if (profileId) await fingerprintChecks.set(profileId, report)
    logger.info('指纹检测完成', { profileId, problems: report.items.filter((item) => item.status === 'bad').length })
    return report
  })
  ipcMain.handle('profiles:open-data-folder', async (_event, id: string) => {
    profiles.get(id)
    await profiles.assertProfileDataIdentity(id)
    const error = await shell.openPath(profiles.profileDataPath(id))
    if (error) throw new Error(`无法打开环境数据目录：${error}`)
  })
  ipcMain.handle('profiles:clear-cache', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id) || (profile.status !== 'closed' && profile.status !== 'error')) {
      throw new Error('请先关闭浏览器环境再清理缓存')
    }
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    await profiles.assertProfileDataIdentity(id)
    const result = await clearProfileCache(profiles.profileDataPath(id))
    logger.info('浏览器环境缓存已清理', { profileId: id })
    return result
  })
  ipcMain.handle('profiles:export-backup', async (_event, id: string) => {
    team.assertEditable(id)
    const profile = profiles.get(id)
    if (launcher.isRunning(id) || (profile.status !== 'closed' && profile.status !== 'error')) throw new Error('请先关闭环境再备份完整数据')
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    const processCheck = (await launcher.diagnose(id)).checks.find((check) => check.key === 'process')
    if (processCheck?.status === 'error') throw new Error(`无法安全备份：${processCheck.message}`)
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: t('选择环境数据备份保存位置'), properties: ['openDirectory', 'createDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return backups.export(id, result.filePaths[0])
  })
  ipcMain.handle('profiles:import-backup', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: t('选择指纹浏览器环境数据备份目录'), properties: ['openDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const imported = await backups.import(result.filePaths[0])
    team.scheduleSync()
    return { profile: publicProfile(imported.profile), result: imported.result }
  })
  ipcMain.handle('profiles:export-workspace', async (_event, password: string) => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导出迁移包')
    if (profiles.list().some((profile) => cookies.isBusy(profile.id))) throw new Error('Cookie 操作尚未结束，请稍后再试')
    const owner = BrowserWindow.getFocusedWindow()
    const stamp = new Date().toISOString().slice(0, 10)
    const options: Electron.SaveDialogOptions = {
      title: t('导出全部环境加密迁移包'),
      defaultPath: `指纹浏览器全部环境 ${stamp}.prism-migration`,
      filters: [{ name: '指纹浏览器加密迁移包', extensions: ['prism-migration'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    return workspaceMigration.exportAll(result.filePath, password)
  })
  ipcMain.handle('profiles:import-workspace', async (_event, password: string, conflictPolicy: 'rename' | 'skip') => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导入迁移包')
    if (profiles.list().some((profile) => cookies.isBusy(profile.id))) throw new Error('Cookie 操作尚未结束，请稍后再试')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: t('导入全部环境加密迁移包'),
      properties: ['openFile'],
      filters: [{ name: '指纹浏览器加密迁移包', extensions: ['prism-migration'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const imported = await workspaceMigration.importAll(result.filePaths[0], password, conflictPolicy)
    team.scheduleSync()
    return imported
  })
  ipcMain.handle('profiles:trash', () => profiles.listTrash())
  ipcMain.handle('profiles:restore', async (_event, trashId: string) => {
    const profile = await profiles.restore(trashId)
    logger.info('浏览器环境已从回收站恢复', { profileId: profile.id })
    // Linked to its cloud window again (team.sync).
    team.scheduleSync()
    return publicProfile(profile)
  })
  ipcMain.handle('profiles:purge-trash', async (_event, trashId: string) => {
    await profiles.purgeTrash(trashId)
    logger.info('回收站环境已永久删除', { trashId })
  })
  ipcMain.handle('profiles:empty-trash', async () => {
    const count = await profiles.emptyTrash()
    logger.info('环境回收站已清空', { count })
    return count
  })
  ipcMain.handle('app:preferences', () => validPreferences(settings.get()))
  ipcMain.handle('app:set-preferences', async (_event, patch: Partial<AppPreferences>) => {
    const next = validPreferences({ ...settings.get(), ...(patch && typeof patch === 'object' ? patch : {}) })
    // deepCheckSites always goes in, so going back to the default list clears the stored one.
    await settings.update({ ...next, deepCheckSites: next.deepCheckSites })
    return next
  })
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), vaultPath: profiles.vaultPath, logsPath: logger.directory }))
  ipcMain.handle('app:open-folder', async (_event, folder: unknown) => {
    if (folder !== 'vault' && folder !== 'logs') throw new Error('目录参数无效')
    const error = await shell.openPath(folder === 'vault' ? profiles.vaultPath : logger.directory)
    if (error) throw new Error(error)
  })
  ipcMain.handle('app:open-project-page', () => shell.openExternal('https://github.com/zhangchedan000/fingerprint-browser'))
  ipcMain.handle('profiles:recycle-retention', () => settings.get().recycleRetentionDays)
  ipcMain.handle('profiles:set-recycle-retention', async (_event, days: number) => {
    if (days !== 0 && days !== 7 && days !== 30 && days !== 90) throw new Error('回收站保留天数无效')
    await settings.update({ recycleRetentionDays: days })
    logger.info('环境回收站自动清理策略已更新', { days })
    return days
  })
  ipcMain.handle('profiles:export-cookies', async (_event, id: string) => {
    team.assertEditable(id)
    const profile = profiles.get(id)
    if (launcher.isRunning(id)) throw new Error('请先关闭浏览器环境再导出 Cookie')
    const owner = BrowserWindow.getFocusedWindow()
    const defaultPath = safeProfileFileName(profile.name).replace(/\.prism-profile\.json$/, '.cookies.json')
    const options: Electron.SaveDialogOptions = {
      title: t('导出环境 Cookie'),
      defaultPath,
      filters: [{ name: 'Cookie JSON', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const exported = await cookies.exportCookies(id)
    await writeFile(result.filePath, serializeCookieFile(profile.name, exported), { encoding: 'utf8', mode: 0o600 })
    return { count: exported.length, filePath: result.filePath }
  })
  ipcMain.handle('profiles:import-cookies-text', async (_event, id: string, text: string) => {
    profiles.get(id)
    if (typeof text !== 'string' || !text.trim()) throw new Error('请粘贴 Cookie 内容')
    if (Buffer.byteLength(text, 'utf8') > 10 * 1024 * 1024) throw new Error('Cookie 文件不能超过 10 MB')
    if (launcher.isRunning(id)) throw new Error('请先关闭浏览器环境再导入 Cookie')
    const imported = parseCookieFile(text)
    return { count: await cookies.importCookies(id, imported) }
  })
  ipcMain.handle('profiles:import-cookies', async (_event, id: string) => {
    profiles.get(id)
    if (launcher.isRunning(id)) throw new Error('请先关闭浏览器环境再导入 Cookie')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: t('导入环境 Cookie'),
      properties: ['openFile'],
      filters: [{ name: 'Cookie', extensions: ['json', 'txt'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('Cookie 文件不能超过 10 MB')
    const imported = parseCookieFile(await readFile(path, 'utf8'))
    const count = await cookies.importCookies(id, imported)
    return { count, filePath: path }
  })
  ipcMain.handle('profiles:remove', async (_event, id: string) => {
    if (launcher.isRunning(id)) throw new Error('请先关闭运行中的环境')
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    await profiles.remove(id)
    await team.forget(id)
  })
  ipcMain.handle('profiles:launch', (_event, id: string, options?: { allowGeoConflict?: unknown }) => {
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    return launcher.launch(id, { allowGeoConflict: options?.allowGeoConflict === true }).then(publicProfile)
  })
  ipcMain.handle('profiles:open-url', (_event, id: string, url: string, options?: { allowGeoConflict?: unknown }) => {
    if (typeof url !== 'string') throw new Error('网址无效')
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    return launcher.openUrl(id, url, { allowGeoConflict: options?.allowGeoConflict === true }).then(publicProfile)
  })
  ipcMain.handle('profiles:close', (_event, id: string) => launcher.close(id).then(publicProfile))
  ipcMain.handle('profiles:close-all', () => launcher.closeAll())
  ipcMain.handle('profiles:test-proxy', async (_event, id: string) => {
    const testedProfile = profiles.get(id)
    const result = await testProxy(testedProfile.proxy)
    const current = profiles.get(id)
    if (!sameProxyIdentity(testedProfile.proxy, current.proxy) || testedProfile.proxy.password !== current.proxy.password) {
      throw new Error('检测期间代理配置已变更，本次结果未保存')
    }
    const profile = await profiles.setProxyCheck(id, { ...result, checkedAt: new Date().toISOString() })
    return publicProfile(profile)
  })
  ipcMain.handle('profiles:diagnose', (_event, id: string) => launcher.diagnose(id))
  ipcMain.handle('profiles:crash-history', (_event, id: string) => launcher.crashHistory(id))
  ipcMain.handle('profiles:read-launch-log', (_event, id: string, logFile: string) => launcher.readLaunchLog(id, logFile))
  ipcMain.handle('profiles:open-launch-log-folder', async (_event, id: string, logFile?: string) => {
    const folder = launcher.launchLogFolder(id)
    await mkdir(folder, { recursive: true })
    if (typeof logFile === 'string' && join(folder, basename(logFile)) === logFile && existsSync(logFile)) {
      shell.showItemInFolder(logFile)
      return
    }
    const error = await shell.openPath(folder)
    if (error) throw new Error(`无法打开日志目录：${error}`)
  })
  ipcMain.handle('profiles:set-favorite', async (_event, id: string, favorite: boolean) => publicProfile(await profiles.setFavorite(id, favorite)))
  ipcMain.handle('profiles:classify-many', async (_event, ids: string[], patch) => {
    return (await profiles.classifyMany(ids, patch)).map(publicProfile)
  })
  ipcMain.handle('profiles:assign-many', async (_event, ids: string[], patch: AssignPatch) => {
    if (patch?.extensionId !== undefined && !(await extensions.list()).some((extension) => extension.id === patch.extensionId)) {
      throw new Error('扩展不存在或已被移除')
    }
    return (await profiles.assignMany(ids, patch)).map(publicProfile)
  })
  ipcMain.handle('profiles:set-kernel-many', async (_event, ids: string[], kernelVersion: string) => {
    const version = typeof kernelVersion === 'string' ? kernelVersion.trim() : kernelVersion
    if (version) {
      const [managed, bundled] = await Promise.all([kernels.installed(), listBundledBrowsers()])
      const available = mergeKernelCatalog(managed, bundled).some((kernel) => kernel.version === version && kernel.installed && kernel.executable)
      if (!available) throw new Error(`内核 ${version} 尚未安装，请先在内核管理中导入`)
    }
    return (await profiles.setKernelMany(ids, version)).map(publicProfile)
  })
  ipcMain.handle('profiles:remove-many', async (_event, ids: string[]) => {
    for (const id of ids) {
      if (launcher.isRunning(id)) throw new Error(`环境“${profiles.get(id).name}”正在运行，不能删除`)
      if (cookies.isBusy(id)) throw new Error(`环境“${profiles.get(id).name}”正在执行 Cookie 操作`)
    }
    await profiles.removeMany(ids)
    for (const id of ids) await team.forget(id)
  })

  ipcMain.handle('engine:status', () => locateBrowser(settings))
  ipcMain.handle('engine:bundled', () => locateBundledBrowser())
  ipcMain.handle('engine:activate-bundled', async () => {
    const bundled = await locateBundledBrowser()
    if (!bundled?.executable) throw new Error('当前安装包没有可用的内置指纹内核')
    return kernels.configure(
      { browserExecutable: '', fingerprintKernel: true, enginePreference: 'bundled' },
      bundled.executable
    )
  })
  ipcMain.handle('engine:select', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: t('选择 Prism 内核'),
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '浏览器', extensions: ['exe'] }] : undefined
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return locateBrowser(settings)
    const executable = await normalizeBrowserSelection(result.filePaths[0])
    return kernels.configure({ browserExecutable: executable, fingerprintKernel: true, enginePreference: 'auto' })
  })
  ipcMain.handle('engine:import-local', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: t('导入本地 Prism 内核'),
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Chromium', extensions: ['exe'] }] : undefined
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return kernels.importLocal(result.filePaths[0])
  })
  ipcMain.handle('engine:use-system', async () => {
    return kernels.configure({ browserExecutable: '', fingerprintKernel: false, enginePreference: 'system' })
  })
  ipcMain.handle('engine:installed', async () => {
    const [managed, bundled] = await Promise.all([kernels.installed(), listBundledBrowsers()])
    return mergeKernelCatalog(managed, bundled)
  })
  ipcMain.handle('engine:activate', async (_event, version: string) => {
    const bundled = await locateBundledBrowser(process.resourcesPath, version)
    if (!bundled?.executable) return kernels.activate(version)
    const primary = await locateBundledBrowser()
    return kernels.configure(
      primary?.version === version
        ? { browserExecutable: '', fingerprintKernel: true, enginePreference: 'bundled' }
        : { browserExecutable: bundled.executable, fingerprintKernel: true, enginePreference: 'auto' },
      bundled.executable
    )
  })
  ipcMain.handle('engine:releases', () => kernels.releases())
  ipcMain.handle('engine:sources', () => kernels.sources())
  ipcMain.handle('engine:set-sources', (_event, sources: unknown) => {
    if (!Array.isArray(sources)) throw new Error('内核来源格式无效')
    return kernels.setSources(sources.filter((item): item is string => typeof item === 'string'))
  })
  ipcMain.handle('engine:install', (_event, version: string, tag?: unknown) => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导入并切换内核')
    return kernels.install(version, typeof tag === 'string' ? tag : undefined)
  })
  ipcMain.handle('engine:cancel-install', (_event, version: string) => kernels.cancel(version))
  ipcMain.handle('engine:rollback-available', () => kernels.rollbackAvailable())
  ipcMain.handle('engine:rollback', () => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再回滚内核')
    return kernels.rollback()
  })
  ipcMain.handle('engine:remove', (_event, version: string) => kernels.remove(version))
  ipcMain.handle('engine:verify', async (_event, version: string) => {
    const bundled = await locateBundledBrowser(process.resourcesPath, version)
    if (bundled?.executable) {
      return {
        version,
        status: 'healthy',
        message: '随指纹浏览器发布的内核完整性正常',
        checkedAt: new Date().toISOString()
      }
    }
    return kernels.verify(version)
  })
  /** An API proxy draft with the proxy its API gives now filled in (others as they are). */
  const resolveDraft = async <T extends ProxyDraft | ProxyConfig>(draft: T): Promise<T> => {
    if (!draft || typeof draft !== 'object' || !draft.apiUrl) return draft
    const endpoint = await resolveApiProxy(validProxyApiUrl(draft.apiUrl))
    return { ...draft, ...endpoint, passwordStored: false }
  }
  ipcMain.handle('proxy:test', async (_event, input, profileId?: string, proxyId?: string) => {
    const config = await resolveDraft(input as ProxyConfig)
    const validated = validateProxyConfig(config)
    const saved = proxyId ? profiles.getProxy(proxyId) : profileId ? profiles.get(profileId).proxy : undefined
    const proxy = proxyForTest(validated, saved)
    const result = await testProxy(proxy)
    // WebRTC through the proxy needs UDP; only a proxy reached directly can carry it (webrtc-relay.ts).
    if (result.ok && proxy.protocol === 'socks5' && !await localProxyFor(proxy).catch(() => undefined)) {
      return { ...result, udp: await proxySupportsUdp(proxy) }
    }
    return result
  })
  // Proxy and group libraries: windows refer to these records by id.
  const proxyView = (id: string) => publicProxyRecord(profiles.getProxy(id), profiles.list())
  ipcMain.handle('proxy:list', () => {
    const windows = profiles.list()
    return profiles.listProxies().map((proxy) => publicProxyRecord(proxy, windows))
  })
  ipcMain.handle('proxy:create', async (_event, draft) => proxyView((await profiles.createProxy(await resolveDraft(draft as ProxyDraft))).id))
  ipcMain.handle('proxy:create-many', async (_event, drafts) => {
    const result = await profiles.createProxies(drafts)
    const windows = profiles.list()
    return { ...result, created: result.created.map((proxy) => publicProxyRecord(proxy, windows)) }
  })
  ipcMain.handle('proxy:update', async (_event, id: string, draft) => proxyView((await profiles.updateProxy(id, await resolveDraft(draft as ProxyDraft))).id))
  ipcMain.handle('proxy:remove', (_event, id: string, replaceWith?: unknown) => {
    if (replaceWith !== undefined && typeof replaceWith !== 'string') throw new Error('替换代理参数无效')
    return profiles.removeProxy(id, replaceWith)
  })
  ipcMain.handle('proxy:check', async (_event, id: string) => {
    const saved = profiles.getProxy(id)
    if (saved.apiUrl) await profiles.setApiProxyEndpoint(id, await resolveApiProxy(saved.apiUrl))
    const tested = profiles.getProxy(id)
    const result = await testProxy(tested)
    const current = profiles.getProxy(id)
    if (!sameProxyIdentity(tested, current) || tested.password !== current.password) {
      throw new Error('检测期间代理配置已变更，本次结果未保存')
    }
    await profiles.setLibraryProxyCheck(id, { ...result, checkedAt: new Date().toISOString() })
    return proxyView(id)
  })
  ipcMain.handle('groups:list', () => {
    const windows = profiles.list()
    return profiles.listGroups().map((group) => publicGroupRecord(group, windows))
  })
  ipcMain.handle('groups:create', async (_event, draft) => publicGroupRecord(await profiles.createGroup(draft), profiles.list()))
  ipcMain.handle('groups:update', async (_event, id: string, draft) => publicGroupRecord(await profiles.updateGroup(id, draft), profiles.list()))
  ipcMain.handle('groups:remove', (_event, id: string) => profiles.removeGroup(id))
  ipcMain.handle('diagnostics:session-health', () => appSession.recoveryStatus())
  if (process.env.PRISM_E2E === '1') {
    ipcMain.handle('diagnostics:e2e-quit', () => app.quit())
  }
  ipcMain.handle('extensions:list', () => extensions.list())
  ipcMain.handle('extensions:import-directory', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: t('选择未打包的浏览器扩展目录'), properties: ['openDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return extensions.importDirectory(result.filePaths[0])
  })
  ipcMain.handle('extensions:open-source-folder', async (_event, id: string) => {
    const path = extensions.sourcePath(id)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('扩展源码目录不存在或不安全')
    const manifestPath = join(path, 'manifest.json')
    const manifestInfo = await lstat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('扩展源码缺少有效的 manifest.json')
    shell.showItemInFolder(manifestPath)
    logger.info('已打开扩展源码目录', { extensionId: id })
    return path
  })
  ipcMain.handle('extensions:set-global-enabled', (_event, id: string, enabled: boolean) => {
    return extensions.setGlobalEnabled(id, enabled)
  })
  ipcMain.handle('extensions:remove', async (_event, id: string) => {
    if (await profiles.usesExtension(id)) throw new Error('该扩展仍被浏览器环境使用，请先从环境配置中移除')
    await extensions.remove(id)
  })
}
