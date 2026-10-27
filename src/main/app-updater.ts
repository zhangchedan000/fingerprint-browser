import { t } from '../shared/i18n'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AppUpdateInfo, AppUpdateProgress } from '../shared/types'
import type { Logger } from './app-logger'

/** Releases tagged vX.Y.Z on this repository carry the portable Windows exe and the notes. */
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

/** Where the running exe is moved while the new one takes its place; removed on the next start. */
export function previousExePath(target: string): string {
  return `${target}.old`
}

/**
 * Puts the new exe where the user's one is (same path, so shortcuts still work). Windows lets a
 * running exe be renamed but not overwritten, so the running one steps aside first. Done by the
 * app itself: a hidden script replacing an exe is what antivirus software (e.g. Huorong) blocks.
 */
export async function replaceExecutable(downloaded: string, target: string): Promise<void> {
  const previous = previousExePath(target)
  await rm(previous, { force: true })
  try {
    await rename(target, previous)
  } catch (error) {
    throw new Error(`无法替换程序文件（${error instanceof Error ? error.message : String(error)}），请到发布页手动下载`)
  }
  try {
    await copyFile(downloaded, target)
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined)
    await rename(previous, target).catch(() => undefined)
    throw new Error(`无法替换程序文件（${error instanceof Error ? error.message : String(error)}），请到发布页手动下载`)
  }
  await rm(downloaded, { force: true }).catch(() => undefined)
}

export class AppUpdater {
  private downloaded: { version: string; path: string } | null = null
  private downloading = false

  constructor(
    private readonly currentVersion: string,
    private readonly workPath: string,
    private readonly onProgress: (progress: AppUpdateProgress) => void,
    private readonly logger?: Logger,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  /** The portable exe the user started; updates replace it. Unset for installed or dev builds. */
  private get target(): string | undefined {
    return process.platform === 'win32' ? process.env.PORTABLE_EXECUTABLE_FILE || undefined : undefined
  }

  async check(): Promise<AppUpdateInfo> {
    const response = await this.fetchImpl(LATEST_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Fingerprint-Browser' },
      signal: AbortSignal.timeout(15_000)
    })
    if (response.status === 404) {
      return { current: this.currentVersion, available: false, canInstall: Boolean(this.target) }
    }
    if (!response.ok) throw new Error(t("检查更新失败（GitHub HTTP {0}）", response.status))
    const latest = await response.json() as GithubLatest
    const version = latest.tag_name.replace(/^v/, '')
    const asset = windowsExeAsset(latest.assets)
    const sha256 = asset?.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : undefined
    return {
      current: this.currentVersion,
      latest: version,
      available: isNewerVersion(version, this.currentVersion) && Boolean(asset && sha256),
      notes: latest.body ?? '',
      publishedAt: latest.published_at,
      pageUrl: latest.html_url,
      size: asset?.size,
      downloaded: this.downloaded?.version === version,
      canInstall: Boolean(this.target)
    }
  }

  /** Downloads the newest exe and checks it against the release's SHA-256. */
  async download(): Promise<AppUpdateInfo> {
    if (this.downloading) throw new Error(t("正在下载更新，请稍候"))
    const info = await this.check()
    if (!info.available || !info.latest) throw new Error(t("当前已是最新版本"))
    if (this.downloaded?.version === info.latest) return info
    const response = await this.fetchImpl(LATEST_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Fingerprint-Browser' } })
    const asset = windowsExeAsset(((await response.json()) as GithubLatest).assets)
    const expected = asset?.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : ''
    if (!asset || !expected) throw new Error(t("新版本缺少可校验的安装文件"))
    this.downloading = true
    const dir = join(this.workPath, 'updates')
    const path = join(dir, `Fingerprint-Browser-${info.latest}.exe`)
    try {
      await mkdir(dir, { recursive: true })
      const download = await this.fetchImpl(asset.browser_download_url, { headers: { 'user-agent': 'Fingerprint-Browser' } })
      if (!download.ok || !download.body) throw new Error(t("下载更新失败（HTTP {0}）", download.status))
      const hash = createHash('sha256')
      let received = 0
      let lastReport = 0
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length
          hash.update(chunk)
          if (received - lastReport > 512 * 1024 || received === asset.size) {
            lastReport = received
            this.onProgress({ version: info.latest!, receivedBytes: received, totalBytes: asset.size })
          }
          callback(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(download.body as import('node:stream/web').ReadableStream), meter, createWriteStream(path))
      if (hash.digest('hex') !== expected) throw new Error(t("更新文件校验失败（SHA-256 不一致），已放弃"))
      this.downloaded = { version: info.latest, path }
      this.onProgress({ version: info.latest, receivedBytes: asset.size, totalBytes: asset.size, done: true })
      this.logger?.info('新版本已下载', { version: info.latest })
      return { ...info, downloaded: true }
    } catch (error) {
      await rm(path, { force: true })
      throw error
    } finally {
      this.downloading = false
    }
  }

  /** Puts the new exe in place and returns its path; the caller restarts into it. */
  async prepareInstall(): Promise<string> {
    const target = this.target
    if (!target) throw new Error(t("只有 Windows 免安装版支持一键更新，请到发布页手动下载"))
    if (!this.downloaded) throw new Error(t("请先下载更新"))
    // The downloaded file must still be the one that passed the checksum.
    if ((await stat(this.downloaded.path)).size < 10_000_000) throw new Error(t("更新文件不完整，请重新下载"))
    await replaceExecutable(this.downloaded.path, target)
    this.logger?.info('即将重启并安装新版本', { version: this.downloaded.version, target })
    this.downloaded = null
    return target
  }

  /** Removes the exe the last update replaced, and downloads it left behind. */
  async cleanup(): Promise<void> {
    const target = this.target
    if (target) await rm(previousExePath(target), { force: true }).catch(() => undefined)
    await rm(join(this.workPath, 'updates'), { recursive: true, force: true }).catch(() => undefined)
  }
}
