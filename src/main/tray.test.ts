import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AppTray, hidesOnClose, quitConfirmation } from './tray'

function setup(options: { action?: 'tray' | 'quit'; running?: number; confirm?: boolean } = {}) {
  const handlers: Record<string, () => void> = {}
  const tray = { setToolTip: vi.fn(), on: vi.fn((name: string, fn: () => void) => { handlers[name] = fn }), displayBalloon: vi.fn() }
  const window = { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), hide: vi.fn() }
  let menu: Array<{ label: string; click: () => void }> = []
  const quit = vi.fn()
  const confirm = vi.fn(async () => options.confirm ?? true)
  const hintFile = join(mkdtempSync(join(tmpdir(), 'tray-')), 'hint')
  const appTray = new AppTray({
    tray: tray as never,
    setMenu: (items) => { menu = items },
    window: () => window as never,
    closeAction: () => options.action,
    running: () => options.running ?? 0,
    confirm,
    quit,
    hintFile
  })
  return { appTray, tray, window, menu: () => menu, quit, confirm, handlers, hintFile }
}

describe('tray', () => {
  it('X hides the window by default and the app keeps running', () => {
    const { appTray, window, quit } = setup()
    const event = { preventDefault: vi.fn() }
    appTray.onClose(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('remembers that the tip was shown once', () => {
    const { appTray, hintFile } = setup()
    appTray.onClose({ preventDefault: () => undefined })
    expect(existsSync(hintFile)).toBe(true)
  })

  it('X quits when the setting says so, asking first while windows run', async () => {
    const asked = setup({ action: 'quit', running: 2, confirm: false })
    asked.appTray.onClose({ preventDefault: () => undefined })
    await vi.waitFor(() => expect(asked.confirm).toHaveBeenCalled())
    expect(asked.quit).not.toHaveBeenCalled()
    expect(asked.window.hide).not.toHaveBeenCalled()

    const idle = setup({ action: 'quit', running: 0 })
    idle.appTray.onClose({ preventDefault: () => undefined })
    await vi.waitFor(() => expect(idle.quit).toHaveBeenCalled())
    expect(idle.confirm).not.toHaveBeenCalled()
  })

  it('tray menu: 打开主界面 shows the window, 退出 asks while windows run, then quits', async () => {
    const { menu, window, quit, confirm, handlers } = setup({ running: 3, confirm: true })
    expect(menu().map((item) => item.label)).toEqual(['打开主界面', '退出'])
    menu()[0]!.click()
    expect(window.show).toHaveBeenCalled()
    handlers.click!()
    expect(window.show).toHaveBeenCalledTimes(2)
    menu()[1]!.click()
    await vi.waitFor(() => expect(quit).toHaveBeenCalled())
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('3') }))
  })

  it('once quitting, closes are real', () => {
    const { appTray, window } = setup()
    appTray.markQuitting()
    const event = { preventDefault: vi.fn() }
    appTray.onClose(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('helpers', () => {
    expect(hidesOnClose(undefined, false, true)).toBe(true)
    expect(hidesOnClose('quit', false, true)).toBe(false)
    expect(hidesOnClose('tray', true, true)).toBe(false)
    expect(quitConfirmation(0)).toBeUndefined()
    expect(quitConfirmation(1)?.defaultId).toBe(1)
  })
})
