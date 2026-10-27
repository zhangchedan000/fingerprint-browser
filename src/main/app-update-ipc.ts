import { app, ipcMain, shell } from 'electron'
import { t } from '../shared/i18n'
import type { AppUpdater } from './app-updater'
import type { ProfileStore } from './profile-store'

const RELEASES_PAGE = 'https://github.com/zhangchedan000/fingerprint-browser/releases/latest'

export function registerAppUpdateIpc(updater: AppUpdater, profiles: ProfileStore): void {
  ipcMain.handle('app:update-check', () => updater.check())
  ipcMain.handle('app:update-download', () => updater.download())
  ipcMain.handle('app:update-page', () => shell.openExternal(RELEASES_PAGE))
  ipcMain.handle('app:update-install', async () => {
    const running = profiles.list().filter((profile) => profile.status !== 'closed' && profile.status !== 'error')
    if (running.length) throw new Error(t("请先关闭全部窗口（还有 {0} 个在运行）", running.length))
    const target = await updater.prepareInstall()
    // Electron starts the new exe once this process has exited (and released the single-instance lock).
    app.relaunch({ execPath: target, args: [] })
    setTimeout(() => app.quit(), 300)
  })
}
