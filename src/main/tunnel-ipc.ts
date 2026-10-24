import { ipcMain } from 'electron'
import type { TunnelManager } from './tunnel-manager'

export function registerTunnelIpc(tunnel: TunnelManager): void {
  ipcMain.handle('tunnel:status', () => tunnel.status())
  ipcMain.handle('tunnel:set-enabled', (_event, enabled: boolean) => tunnel.setEnabled(enabled === true))
  ipcMain.handle('tunnel:add-source', (_event, input: { name?: string; kind?: string; content?: string }) => tunnel.addSource(input ?? {}))
  ipcMain.handle('tunnel:remove-source', (_event, id: string) => tunnel.removeSource(String(id)))
  ipcMain.handle('tunnel:select', (_event, name: string) => tunnel.select(name))
  ipcMain.handle('tunnel:test', () => tunnel.testDelays())
  ipcMain.handle('tunnel:refresh', () => tunnel.refreshSubscriptions())
}
