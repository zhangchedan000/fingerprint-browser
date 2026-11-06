import { describe, expect, it, vi } from 'vitest'
import { instrumentIpc } from './timing'

describe('instrumentIpc', () => {
  it('logs only slow actions, with the channel and time but never the arguments', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const ipcMain = { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, listener) } }
    const logger = { info: vi.fn() }
    instrumentIpc(ipcMain as never, logger, 30)
    ipcMain.handle('fast', async (_event, value) => value)
    ipcMain.handle('slow', async (_event, secret) => { await new Promise((resolve) => setTimeout(resolve, 50)); return secret })
    ipcMain.handle('fails', async () => { await new Promise((resolve) => setTimeout(resolve, 50)); throw new Error('no') })
    expect(await handlers.get('fast')!({}, 1)).toBe(1)
    expect(await handlers.get('slow')!({}, 'password')).toBe('password')
    await expect(handlers.get('fails')!({})).rejects.toThrow('no')
    expect(logger.info.mock.calls.map(([message, details]) => [message, details.channel])).toEqual([['[计时] 操作较慢', 'slow'], ['[计时] 操作较慢', 'fails']])
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('password')
  })
})
