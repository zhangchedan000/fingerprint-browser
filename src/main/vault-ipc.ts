import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { t } from '../shared/i18n'
import type { ProfileStore } from './profile-store'
import type { TunnelManager } from './tunnel-manager'
import { deletePreviousVault, relocateVault, resolveVaultLocation, revertVault } from './vault-location'

interface Logger {
  info(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/** Restarts the app; a portable build restarts its own .exe, not the copy unpacked to temp. */
function relaunch(): void {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  app.relaunch(portable ? { execPath: portable } : undefined)
  app.quit()
}

export function registerVaultIpc(userData: string, vaultPath: string, profiles: ProfileStore, tunnel: TunnelManager, logger: Logger): void {
  let moving = false

  ipcMain.handle('app:vault-location', () => resolveVaultLocation(userData))

  ipcMain.handle('app:relocate-vault', async (event) => {
    if (moving) throw new Error('正在迁移数据目录，请稍候')
    const running = profiles.list().filter((profile) => profile.status !== 'closed' && profile.status !== 'error')
    if (running.length) throw new Error(`请先关闭全部窗口（还有 ${running.length} 个在运行）`)
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: Electron.OpenDialogOptions = { title: t('选择新的数据目录（空文件夹）'), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return null
    const target = picked.filePaths[0]
    moving = true
    try {
      await tunnel.stop()
      logger.info('开始迁移数据目录', { from: vaultPath, to: target })
      await relocateVault(userData, vaultPath, target, (progress) => event.sender.send('app:relocate-progress', progress))
      logger.info('数据目录迁移完成，即将重启', { to: target })
      setTimeout(relaunch, 800)
      return target
    } catch (error) {
      logger.error('数据目录迁移失败', error)
      throw error
    } finally {
      moving = false
    }
  })

  ipcMain.handle('app:delete-previous-vault', async () => {
    await deletePreviousVault(userData)
    logger.info('已删除旧位置的数据目录')
    return resolveVaultLocation(userData)
  })

  ipcMain.handle('app:revert-vault', async () => {
    const running = profiles.list().filter((profile) => profile.status !== 'closed' && profile.status !== 'error')
    if (running.length) throw new Error(`请先关闭全部窗口（还有 ${running.length} 个在运行）`)
    await revertVault(userData)
    logger.info('数据目录已改回旧位置，即将重启')
    setTimeout(relaunch, 300)
  })
}
