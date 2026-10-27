import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { WINDOWS_FONT_PACKS, type FontPackStatus } from '../shared/windows-font-packs'
import type { AppLogger } from './app-logger'

const fontsFolder = () => join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')

const exists = (path: string) => access(path).then(() => true, () => false)

/** Which language font packages this computer has, judged by a font file only each one installs. */
export async function fontPackStatus(): Promise<FontPackStatus> {
  if (process.platform !== 'win32') return { installed: [], missing: [], supported: false }
  const installed: string[] = []
  const missing: string[] = []
  for (const pack of WINDOWS_FONT_PACKS) {
    ;(await exists(join(fontsFolder(), pack.marker)) ? installed : missing).push(pack.script)
  }
  return { installed, missing, supported: true }
}

/**
 * Installs the missing packages from Microsoft (Windows Update) in one elevated PowerShell, so
 * Windows asks for administrator approval once. Resolves with the status afterwards.
 */
export async function installFontPacks(logger?: AppLogger): Promise<FontPackStatus> {
  const before = await fontPackStatus()
  if (!before.supported || before.missing.length === 0) return before
  const names = WINDOWS_FONT_PACKS.filter((pack) => before.missing.includes(pack.script)).map((pack) => pack.capability)
  const inner = names.map((name) => `Add-WindowsCapability -Online -Name '${name}' | Out-Null`).join('; ')
  // The elevated child runs -EncodedCommand (UTF-16LE base64) so nothing is re-quoted on the way.
  const encoded = Buffer.from(`$ErrorActionPreference = 'Continue'; ${inner}`, 'utf16le').toString('base64')
  const outer = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`
  logger?.info('安装语言字体包', { packages: before.missing })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      // Declining the administrator prompt ends Start-Process with an error.
      if (code === 0) resolve()
      else reject(new Error(stderr.includes('canceled') || stderr.includes('取消') ? '已取消管理员授权' : `安装语言字体包失败（${code}）`))
    })
  })
  const after = await fontPackStatus()
  logger?.info('语言字体包安装结束', { installed: after.installed, missing: after.missing })
  return after
}

export function registerLanguageFontsIpc(logger?: AppLogger): void {
  ipcMain.handle('fonts:packs', () => fontPackStatus())
  ipcMain.handle('fonts:install-packs', () => installFontPacks(logger))
}
