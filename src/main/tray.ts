import { existsSync, writeFileSync } from 'node:fs'
import type { BrowserWindow, MessageBoxOptions, Tray as ElectronTray } from 'electron'
import { t } from '../shared/i18n'
import type { AppPreferences } from '../shared/types'

/** What the main window's X does: hide to the tray icon (default) or quit the app. */
export type CloseAction = NonNullable<AppPreferences['closeAction']>

/**
 * Whether the main window's close (X, Alt+F4) only hides it. The app quitting (tray 退出, the updater,
 * Windows signing out) always closes it for real.
 */
export function hidesOnClose(action: CloseAction | undefined, quitting: boolean, hasTray: boolean): boolean {
  return !quitting && hasTray && action !== 'quit'
}

/** The question before quitting while windows run; none when nothing runs. */
export function quitConfirmation(running: number): MessageBoxOptions | undefined {
  if (running <= 0) return undefined
  return {
    type: 'question',
    buttons: [t('退出'), t('取消')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: t('退出指纹浏览器'),
    message: t('还有 {0} 个窗口在运行，退出会把它们全部关闭', running),
    detail: t('团队窗口会先上传登录状态再退出。')
  }
}

export interface TrayDeps {
  tray: ElectronTray
  /** Builds the tray's right-click menu from its two items. */
  setMenu: (items: Array<{ label: string; click: () => void }>) => void
  window: () => BrowserWindow | null
  closeAction: () => CloseAction | undefined
  running: () => number
  confirm: (options: MessageBoxOptions) => Promise<boolean>
  quit: () => void
  /** A file whose presence means the "still running in the tray" tip was shown once. */
  hintFile: string
}

/**
 * The tray icon and the main window's close: X hides the window to the tray (the windows keep running),
 * a click on the icon brings it back, right-click offers 打开主界面 / 退出. 退出 asks first while windows run.
 */
export class AppTray {
  private quitting = false

  constructor(private readonly deps: TrayDeps) {
    deps.tray.setToolTip(t('指纹浏览器'))
    deps.setMenu([
      { label: t('打开主界面'), click: () => this.show() },
      { label: t('退出'), click: () => void this.requestQuit() }
    ])
    deps.tray.on('click', () => this.show())
    deps.tray.on('double-click', () => this.show())
  }

  /** The app is going away (any reason): closes are real from now on. */
  markQuitting(): void {
    this.quitting = true
  }

  show(): void {
    const window = this.deps.window()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** The main window's 'close': hides it (and tells the first time) or quits after the question. */
  onClose(event: { preventDefault: () => void }): void {
    if (this.quitting) return
    event.preventDefault()
    if (hidesOnClose(this.deps.closeAction(), this.quitting, true)) {
      this.deps.window()?.hide()
      this.hintOnce()
      return
    }
    void this.requestQuit()
  }

  async requestQuit(): Promise<void> {
    if (this.quitting) return
    const question = quitConfirmation(this.deps.running())
    if (question) {
      this.show()
      if (!await this.deps.confirm(question)) return
    }
    this.quitting = true
    this.deps.quit()
  }

  private hintOnce(): void {
    if (existsSync(this.deps.hintFile)) return
    try { writeFileSync(this.deps.hintFile, new Date().toISOString()) } catch { /* shown again next time */ }
    if (process.platform !== 'win32') return
    this.deps.tray.displayBalloon({
      iconType: 'info',
      title: t('指纹浏览器还在运行'),
      content: t('主界面缩小到了托盘图标，打开的窗口照常运行。点图标打开主界面，右键可以退出；在「设置 → 常规 → 关闭主界面时」可以改成直接退出。')
    })
  }
}
