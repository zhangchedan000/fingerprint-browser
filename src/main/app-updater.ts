import { t } from '../shared/i18n'
import type { AppUpdateInfo, AppUpdateProgress } from '../shared/types'
import type { Logger } from './app-logger'

/** Releases tagged vX.Y.Z on this repository carry the Windows installer and the notes. */
const LATEST_URL = 'https://api.github.com/repos/zhangchedan000/fingerprint-browser/releases/latest'
const TRUSTED_PREFIX = 'https://github.com/zhangchedan000/fingerprint-browser/releases/download/'

interface GithubAsset { name: string; size: number; browser_download_url: string; digest: string | null }
interface GithubLatest { tag_name: string; name: string | null; body: string | null; published_at: string; html_url: string; assets: GithubAsset[] }

/** "v0.2.10" → [0, 2, 10]; undefined for tags that are not a release version. */
export function parseAppVersion(tag: string): number[] | undefined {
  const match = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  return match ? match.slice(1).map(Number) : undefined
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseAppVersion(candidate)
  const b = parseAppVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export function windowsExeAsset(assets: readonly GithubAsset[]): GithubAsset | undefined {
  return assets.find((asset) => /\.exe$/i.test(asset.name) && asset.browser_download_url.startsWith(TRUSTED_PREFIX))
}

/** The part of electron-updater's autoUpdater this module uses (tests pass a fake). */
export interface UpdaterEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<{ updateInfo: { version: string; releaseDate?: string; files?: Array<{ size?: number }> } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (progress: { transferred: number; total: number }) => void): unknown
}

/**
 * The installed Windows app updates itself with electron-updater: it downloads the installer
 * named in the release's latest.yml, checks its SHA-512 and runs it silently on restart. The
 * notes shown come from the GitHub release. Other builds (development, the old portable exe)
 * only point to the release page.
 */
export class AppUpdater {
  private downloadedVersion?: string
  private downloading = false

  constructor(
    private readonly currentVersion: string,
    private readonly onProgress: (progress: AppUpdateProgress) => void,
    private readonly engine: UpdaterEngine | undefined,
    private readonly logger?: Logger,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
  ) {
    if (engine) {
      engine.autoDownload = false
      engine.autoInstallOnAppQuit = false
    }
  }

  /** Notes and page of the newest GitHub release; undefined when GitHub cannot be reached. */
  private async githubLatest(): Promise<GithubLatest | undefined> {
    try {
      const response = await this.fetchImpl(LATEST_URL, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Fingerprint-Browser' },
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) return undefined
      return await response.json() as GithubLatest
    } catch {
      return undefined
    }
  }

  async check(): Promise<AppUpdateInfo> {
    if (!this.engine) {
      const latest = await this.githubLatest()
      if (!latest) throw new Error('检查更新失败：连不上 GitHub')
      const version = latest.tag_name.replace(/^v/, '')
      return {
        current: this.currentVersion,
        latest: version,
        available: isNewerVersion(version, this.currentVersion) && Boolean(windowsExeAsset(latest.assets)),
        notes: latest.body ?? '',
        publishedAt: latest.published_at,
        pageUrl: latest.html_url,
        canInstall: false
      }
    }
    const [result, release] = await Promise.all([this.engine.checkForUpdates(), this.githubLatest()])
    const info = result?.updateInfo
    if (!info) return { current: this.currentVersion, available: false, canInstall: true }
    const sameRelease = release && release.tag_name.replace(/^v/, '') === info.version
    return {
      current: this.currentVersion,
      latest: info.version,
      available: isNewerVersion(info.version, this.currentVersion),
      notes: sameRelease ? release.body ?? '' : '',
      publishedAt: sameRelease ? release.published_at : info.releaseDate,
      pageUrl: sameRelease ? release.html_url : undefined,
      size: info.files?.[0]?.size,
      downloaded: this.downloadedVersion === info.version,
      canInstall: true
    }
  }

  /** Downloads the newest installer; electron-updater checks it against latest.yml. */
  async download(): Promise<AppUpdateInfo> {
    if (!this.engine) throw new Error('只有安装版支持一键更新，请到发布页下载安装包')
    if (this.downloading) throw new Error(t("正在下载更新，请稍候"))
    const info = await this.check()
    if (!info.available || !info.latest) throw new Error(t("当前已是最新版本"))
    if (info.downloaded) return info
    const version = info.latest
    this.downloading = true
    const onProgress = (progress: { transferred: number; total: number }) => {
      this.onProgress({ version, receivedBytes: progress.transferred, totalBytes: progress.total })
    }
    this.engine.on('download-progress', onProgress)
    try {
      await this.engine.downloadUpdate()
      this.downloadedVersion = version
      this.onProgress({ version, receivedBytes: info.size ?? 0, totalBytes: info.size ?? 0, done: true })
      this.logger?.info('新版本已下载', { version })
      return { ...info, downloaded: true }
    } finally {
      this.downloading = false
      ;(this.engine as unknown as { off?: (event: string, listener: unknown) => void }).off?.('download-progress', onProgress)
    }
  }

  /** Quits and runs the downloaded installer silently; it starts the new version when done. */
  install(): void {
    if (!this.engine) throw new Error('只有安装版支持一键更新，请到发布页下载安装包')
    if (!this.downloadedVersion) throw new Error(t("请先下载更新"))
    this.logger?.info('即将重启并安装新版本', { version: this.downloadedVersion })
    this.engine.quitAndInstall(true, true)
  }
}
