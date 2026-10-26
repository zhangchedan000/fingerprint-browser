import { describe, expect, it } from 'vitest'
import { isNewerVersion, parseAppVersion, swapScript, windowsExeAsset } from './app-updater'

describe('app updates', () => {
  it('compares release versions', () => {
    expect(parseAppVersion('v0.2.10')).toEqual([0, 2, 10])
    expect(parseAppVersion('kernel-156.0.8078.47-prism4')).toBeUndefined()
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('v0.10.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false)
  })

  it('takes the exe only from this repository', () => {
    const asset = (url: string) => ({ name: 'Fingerprint-Browser-0.2.0.exe', size: 1, browser_download_url: url, digest: null })
    expect(windowsExeAsset([asset('https://github.com/zhangchedan000/fingerprint-browser/releases/download/v0.2.0/x.exe')])).toBeDefined()
    expect(windowsExeAsset([asset('https://github.com/other/repo/releases/download/v0.2.0/x.exe')])).toBeUndefined()
  })

  it('waits for the app, replaces the exe in place and restarts it', () => {
    const script = swapScript(1234, 'C:\\tmp\\new.exe', "D:\\IDM下载\\Bob's Fingerprint Browser 0.1.0.exe")
    expect(script).toContain('Get-Process -Id 1234')
    expect(script).toContain("Copy-Item -LiteralPath 'C:\\tmp\\new.exe' -Destination 'D:\\IDM下载\\Bob''s Fingerprint Browser 0.1.0.exe'")
    expect(script).toContain("Start-Process -FilePath 'D:\\IDM下载\\Bob''s Fingerprint Browser 0.1.0.exe'")
  })
})
