import { ipcMain, shell } from 'electron'
import { t } from '../shared/i18n'
import type { AppUpdater } from './app-updater'
import type { ProfileStore } from './profile-store'

const RELEASES_PAGE = 'https://github.com/zhangchedan000/fingerprint-browser/releases/latest'

export function registerAppUpdateIpc(updater: AppUpdater, profiles: ProfileStore, beforeInstall: () => Promise<void>): void {
  ipcMain.handle('app:update-check', () => updater.check())
  ipcMain.handle('app:update-download', () => updater.download())
  ipcMain.handle('app:update-page', () => shell.openExternal(RELEASES_PAGE))
  ipcMain.handle('app:update-install', async () => {
    const running = profiles.list().filter((profile) => profile.status !== 'closed' && profile.status !== 'error')
    if (running.length) throw new Error(t("请先关闭全部窗口（还有 {0} 个在运行）", running.length))
    // The installer closes this app; anything still being written must be done first.
    await beforeInstall()
    updater.install()
  })
}
