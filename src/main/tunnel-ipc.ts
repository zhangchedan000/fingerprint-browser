import { ipcMain } from 'electron'
import type { TunnelManager } from './tunnel-manager'

/** 网络加速 ('tunnel') and the subscriptions (订阅, 'subscriptions') answer the same calls. */
export function registerTunnelIpc(tunnel: TunnelManager, channel: 'tunnel' | 'subscriptions' = 'tunnel', hooks: { renamed?: (from: string, to: string) => Promise<void> } = {}): void {
  ipcMain.handle(`${channel}:status`, () => tunnel.status())
  ipcMain.handle(`${channel}:set-enabled`, (_event, enabled: boolean) => tunnel.setEnabled(enabled === true))
  ipcMain.handle(`${channel}:add-source`, (_event, input: { name?: string; kind?: string; content?: string }) => tunnel.addSource(input ?? {}))
  ipcMain.handle(`${channel}:source`, (_event, id: string) => tunnel.source(String(id)))
  ipcMain.handle(`${channel}:update-source`, async (_event, id: string, input: { name?: string; kind?: string; content?: string }) => {
    const before = tunnel.source(String(id)).name
    const status = await tunnel.updateSource(String(id), input ?? {})
    const after = tunnel.source(String(id)).name
    if (after !== before) await hooks.renamed?.(before, after)
    return status
  })
  ipcMain.handle(`${channel}:remove-source`, (_event, id: string) => tunnel.removeSource(String(id)))
  ipcMain.handle(`${channel}:select`, (_event, name: string) => tunnel.select(name))
  ipcMain.handle(`${channel}:auto-select`, () => tunnel.autoSelect())
  ipcMain.handle(`${channel}:test`, () => tunnel.testDelays())
  ipcMain.handle(`${channel}:refresh`, () => tunnel.refreshSubscriptions())
  ipcMain.handle(`${channel}:preview-source`, (_event, input: { name?: string; kind?: string; content?: string }) => tunnel.previewSource(input ?? {}))
}
