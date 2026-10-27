import { describe, expect, it } from 'vitest'
import type { AppUpdateProgress } from '../shared/types'
import { AppUpdater, isNewerVersion, parseAppVersion, windowsExeAsset, type UpdaterEngine } from './app-updater'

function fakeEngine(version: string) {
  const listeners: Array<(progress: { transferred: number; total: number }) => void> = []
  const calls: string[] = []
  const engine: UpdaterEngine & { calls: string[] } = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    calls,
    checkForUpdates: async () => ({ updateInfo: { version, releaseDate: '2026-10-27T00:00:00Z', files: [{ size: 1000 }] } }),
    downloadUpdate: async () => {
      calls.push('download')
      for (const listener of listeners) listener({ transferred: 500, total: 1000 })
    },
    quitAndInstall: (isSilent, isForceRunAfter) => { calls.push(`install silent=${isSilent} run=${isForceRunAfter}`) },
    on: (_event, listener) => { listeners.push(listener) }
  }
  return engine
}

const githubRelease = (tag: string) => async () => new Response(JSON.stringify({
  tag_name: tag, name: tag, body: '## 更新内容', published_at: '2026-10-27T01:00:00Z', html_url: `https://github.com/x/releases/${tag}`,
  assets: [{ name: 'Fingerprint-Browser-Setup.exe', size: 1000, browser_download_url: 'https://github.com/zhangchedan000/fingerprint-browser/releases/download/v/x.exe', digest: null }]
}))

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
    const asset = (url: string) => ({ name: 'Fingerprint-Browser-Setup-0.4.0.exe', size: 1, browser_download_url: url, digest: null })
    expect(windowsExeAsset([asset('https://github.com/zhangchedan000/fingerprint-browser/releases/download/v0.4.0/x.exe')])).toBeDefined()
    expect(windowsExeAsset([asset('https://github.com/other/repo/releases/download/v0.4.0/x.exe')])).toBeUndefined()
  })

  it('downloads with electron-updater and installs silently, restarting into the new version', async () => {
    const engine = fakeEngine('0.4.1')
    const progress: AppUpdateProgress[] = []
    const updater = new AppUpdater('0.4.0', (item) => progress.push(item), engine, undefined, githubRelease('v0.4.1'))
    expect(engine.autoDownload).toBe(false)
    expect(engine.autoInstallOnAppQuit).toBe(false)

    expect(await updater.check()).toMatchObject({ latest: '0.4.1', available: true, canInstall: true, notes: '## 更新内容', size: 1000, downloaded: false })
    expect(() => updater.install()).toThrow('请先下载更新')
    expect(await updater.download()).toMatchObject({ downloaded: true })
    expect(progress[0]).toMatchObject({ version: '0.4.1', receivedBytes: 500, totalBytes: 1000 })
    updater.install()
    expect(engine.calls).toEqual(['download', 'install silent=true run=true'])
  })

  it('reports no update for the same version, and only the page outside the installed app', async () => {
    expect(await new AppUpdater('0.4.1', () => undefined, fakeEngine('0.4.1'), undefined, githubRelease('v0.4.1')).check())
      .toMatchObject({ available: false, canInstall: true })
    const portable = new AppUpdater('0.3.1', () => undefined, undefined, undefined, githubRelease('v0.4.0'))
    expect(await portable.check()).toMatchObject({ latest: '0.4.0', available: true, canInstall: false })
    await expect(portable.download()).rejects.toThrow('只有安装版支持一键更新')
  })
})
