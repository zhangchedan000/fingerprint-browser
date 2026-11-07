import { isKernelId, kernelBuildId, kernelChromiumVersion } from '../shared/kernel-id'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, cp, link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { promisify } from 'node:util'
import type { EngineStatus, KernelHealth, KernelImportResult, KernelInstallProgress, KernelRelease } from '../shared/types'
import { locateBrowser, locateBrowserSelection, normalizeBrowserSelection } from './browser-locator'
import {
  collectKernelIntegrity,
  kernelPayloadIdentity,
  validateKernelIntegrityFields,
  verifyKernelIntegrity,
  type KernelIntegrityFields
} from './kernel-integrity'
import type { SettingsStore } from './settings-store'
import { checksumFor, githubFailure, isSourceDownloadUrl, olderBuilds, planKernelRows, releaseCandidates, type GithubRelease, type ReleaseCandidate } from './kernel-release-list'
import { validKernelSources } from '../shared/kernel-sources'
import type { Logger } from './app-logger'
import { detachKernelFolderFonts, ensureKernelFonts } from './kernel-fonts'
import { executableSupported, kernelSupported, supportedReleases, UNSUPPORTED_KERNEL } from './kernel-features'
import type { AppSettings } from '../shared/types'

const execFileAsync = promisify(execFile)
/**
 * Windows kernels are listed from the GitHub projects in settings.kernelSources (this app's own
 * repository by default, where each Prism build is published as "kernel-<chromium>-prismN").
 */
const releasesUrl = (source: string) => `https://api.github.com/repos/${source}/releases?per_page=30`

interface InstalledKernelManifest extends KernelIntegrityFields {
  schemaVersion?: 1 | 2
  version: string
  assetName: string
  sha256: string
  installedAt: string
  executableRelative: string
  executableSha256?: string
  executableSize?: number
  source?: 'release' | 'local-build'
  target?: string
  /** Downloads: the GitHub project and release the build came from, and when it was published. */
  sourceRepo?: string
  releaseTag?: string
  publishedAt?: string
  /** Local builds: built from Google's source (prism21+, kernel-features.ts); downloads tell by their release tag. */
  supported?: boolean
}

interface KernelActivationBackup {
  schemaVersion: 1
  recordedAt: string
  settings: AppSettings
}

/** A program holds the folder (Windows: EPERM / EBUSY / EACCES on rename); worth waiting a little. */
function folderInUse(error: unknown): boolean {
  return ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '')
}

/** "a\\b/c" → "a/b/c". */
function portableRelativePath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join('/')
}

/** A new build folder's name: build-<local time>, with a suffix when one of that minute exists. */
export async function uniqueBuildFolder(kernelFolder: string, now = new Date()): Promise<string> {
  const pad = (value: number) => String(value).padStart(2, '0')
  const base = `build-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  for (let index = 0; ; index++) {
    const name = index ? `${base}-${index}` : base
    if (!await pathExists(join(kernelFolder, name))) return name
  }
}

export const KERNEL_FOLDER_IN_USE_REMOVE = '内核文件夹正被其他程序占用，暂时没法删除。常见的是输入法的后台程序（比如搜狗输入法的云服务）。请退出这个程序，或者重启电脑，再删除'

/** How long a project's release list from GitHub is used before asking again. */
export const RELEASE_LIST_TTL_MS = 10 * 60 * 1000
/** How old a list may be and still stand in while GitHub refuses or cannot be reached. */
export const RELEASE_LIST_STALE_MS = 6 * 60 * 60 * 1000

export const KERNEL_FOLDER_IN_USE = '内核文件夹正被其他程序占用，暂时没法更新。常见的是输入法的后台程序（比如搜狗输入法的云服务）：在浏览器里用过输入法后，它会在后台一直占着内核文件夹。请退出这个程序，或者重启电脑，再点更新'

/**
 * Moves an installed kernel aside. Chrome makes its own folder its working folder (chrome_exe_main_win.cc
 * SetCwdForBrowserProcess, main_dll_loader_win.cc), and programs it starts keep it, such as an input
 * method's background service; Windows does not rename a folder that is any process's working folder.
 * Tries a few times (such a program may be closing), then says what to do.
 */
export async function renameKernelFolder(
  from: string,
  to: string,
  logger?: Logger,
  tries = 5,
  delayMs = 1000,
  renameImpl: (from: string, to: string) => Promise<void> = rename
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await renameImpl(from, to)
      return
    } catch (error) {
      if (!folderInUse(error)) throw error
      logger?.info('内核文件夹被占用，稍后重试', { folder: from, attempt, error: error instanceof Error ? error.message : String(error) })
      if (attempt >= tries) throw new Error(KERNEL_FOLDER_IN_USE)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

function safeVersion(version: string): string {
  if (!isKernelId(version)) throw new Error('内核版本号无效')
  return version
}

const PRISM_MARKER = Buffer.from('fingerprint-gpu-description')

/** Whether a file contains `needle`, read in chunks (chrome.dll is a few hundred MB). */
async function fileContains(path: string, needle: Buffer): Promise<boolean> {
  let tail = Buffer.alloc(0)
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
      const window = Buffer.concat([tail, chunk as Buffer])
      if (window.includes(needle)) return true
      tail = window.subarray(Math.max(0, window.length - needle.length + 1))
    }
  } catch {
    return false
  }
  return false
}

/** chrome.dll sits next to chrome.exe in packaged builds and in a version folder in installed ones. */
async function isPrismBuild(browserRoot: string, chromiumVersion: string): Promise<boolean> {
  for (const dll of [join(browserRoot, 'chrome.dll'), join(browserRoot, chromiumVersion, 'chrome.dll')]) {
    if (await pathExists(dll)) return fileContains(dll, PRISM_MARKER)
  }
  return false
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findEntry(root: string, predicate: (name: string) => boolean, depth = 4): Promise<string | undefined> {
  if (depth < 0) return undefined
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (predicate(entry.name)) return path
    if (entry.isDirectory()) {
      const nested = await findEntry(path, predicate, depth - 1)
      if (nested) return nested
    }
  }
  return undefined
}

const UNSUPPORTED_IMPORT = '这个本地构建不是 prism21（谷歌原版源码编译），新版启动器只能导入 prism21 及以后的内核'

export class KernelManager {
  private installingVersion: string | null = null
  private tidied = false
  /** GitHub release lists per URL and when they were fetched (fetchReleases). */
  private readonly releaseLists = new Map<string, { at: number; releases: GithubRelease[] }>()
  private installAbort: AbortController | null = null

  constructor(
    private readonly vaultPath: string,
    private readonly settings: SettingsStore,
    private readonly onProgress: (progress: KernelInstallProgress) => void,
    private readonly logger?: Logger,
    private readonly kernelUsers: (version: string) => string[] | Promise<string[]> = () => [],
    /** Electron passes net.fetch so downloads follow the system proxy. */
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  async installed(): Promise<KernelRelease[]> {
    await this.tidyKernels().catch((error) => {
      this.logger?.error('清理旧的内核文件夹失败', { error: error instanceof Error ? error.message : String(error) })
    })
    const manifests = await this.installedManifests()
    const releases: KernelRelease[] = []
    for (const manifest of manifests.values()) {
      if (manifest.target && manifest.target !== `${process.platform}-${process.arch}`) continue
      const executable = join(this.kernelPath(manifest.version), manifest.executableRelative)
      if (!await pathExists(executable)) continue
      releases.push({
        version: manifest.version,
        publishedAt: manifest.installedAt,
        assetName: manifest.assetName,
        downloadUrl: '',
        size: 0,
        sha256: manifest.sha256,
        installed: true,
        remoteAvailable: false,
        origin: manifest.source ?? 'release',
        executable,
        ...(manifest.releaseTag ? { tag: manifest.releaseTag } : {}),
        supported: kernelSupported(manifest)
      })
    }
    return releases.sort((first, second) => second.version.localeCompare(first.version, undefined, { numeric: true }))
  }

  async releases(): Promise<KernelRelease[]> {
    if (process.platform !== 'win32') throw new Error('Prism 内核目前只有 Windows 版')
    const installed = await this.installedManifests()
    const sources = this.settings.get().kernelSources
    const listed = await Promise.all(sources.map(async (source) => {
      try {
        return { candidates: releaseCandidates(source, await this.fetchReleases(releasesUrl(source))) }
      } catch (error) {
        this.logger?.error('获取内核版本失败', { source, error: error instanceof Error ? error.message : String(error) })
        // The reason alone (the log has the project): the same reason from every project is said once.
        return { candidates: [], error: error instanceof Error ? error.message : String(error) }
      }
    }))
    const failures = listed.flatMap((item) => item.error ? [item.error] : [])
    // Every source failed: say why (installed kernels are listed on their own page), not an empty list.
    if (sources.length && failures.length === sources.length) throw new Error([...new Set(failures)].join('；'))

    const withSha: Array<ReleaseCandidate & { sha256: string }> = []
    // Only kernels this launcher runs (prism21+); older ones stay with the launchers released before it.
    for (const candidate of supportedReleases(listed.flatMap((item) => item.candidates))) {
      const sha256 = candidate.sha256 || await this.checksumFromFile(candidate)
      if (sha256) withSha.push({ ...candidate, sha256 })
    }
    const rows = planKernelRows([...installed.values()].map((manifest) => ({
      version: manifest.version,
      chromium: kernelChromiumVersion(manifest.version),
      sha256: manifest.sha256.toLowerCase(),
      sourceRepo: manifest.sourceRepo,
      builtAt: manifest.publishedAt ?? manifest.installedAt
    })), withSha)
    const used = new Set<string>()
    const remote: KernelRelease[] = []
    for (const row of rows) {
      const { release } = row
      let version = row.kind === 'new' ? `prism-${release.chromium}` : row.installed.version
      if (row.kind === 'new') {
        // Another build of a version that is installed from elsewhere gets its publish time as a suffix.
        const at = new Date(release.publishedAt)
        while (used.has(version) || installed.has(version)) {
          version = kernelBuildId(`prism-${release.chromium}`, at)
          at.setMinutes(at.getMinutes() + 1)
        }
      }
      if (!isKernelId(version) || used.has(version)) continue
      used.add(version)
      const manifest = installed.get(version)
      remote.push({
        version,
        publishedAt: release.publishedAt,
        assetName: release.asset.name,
        downloadUrl: release.asset.browser_download_url,
        size: release.asset.size,
        sha256: release.sha256,
        installed: Boolean(manifest),
        remoteAvailable: true,
        origin: manifest?.source ?? 'release',
        executable: manifest ? join(this.kernelPath(version), manifest.executableRelative) : undefined,
        source: release.source,
        tag: release.tag,
        // The installed build (an older kernel this one updates), else the listed one, which is supported.
        supported: manifest ? kernelSupported(manifest) : true,
        ...(row.kind === 'update' ? { update: true } : {})
      })
    }
    // Older builds, for rolling an installed kernel back (or installing one) — replaced in place.
    for (const release of olderBuilds(withSha, rows)) {
      const owner = [...installed.values()].find((manifest) => manifest.source !== 'local-build'
        && kernelChromiumVersion(manifest.version) === release.chromium
        && (!manifest.sourceRepo || manifest.sourceRepo.toLowerCase() === release.source.toLowerCase()))
      const version = owner?.version ?? `prism-${release.chromium}`
      if (!owner && installed.has(version)) continue
      remote.push({
        version,
        publishedAt: release.publishedAt,
        assetName: release.asset.name,
        downloadUrl: release.asset.browser_download_url,
        size: release.asset.size,
        sha256: release.sha256,
        installed: owner?.sha256.toLowerCase() === release.sha256,
        remoteAvailable: true,
        origin: 'release',
        executable: owner ? join(this.kernelPath(version), owner.executableRelative) : undefined,
        source: release.source,
        tag: release.tag,
        supported: true,
        history: true
      })
    }
    const localOnly = [...installed.values()]
      .filter((manifest) => !used.has(manifest.version))
      .map((manifest) => ({
        version: manifest.version,
        publishedAt: manifest.installedAt,
        assetName: manifest.assetName,
        downloadUrl: '',
        size: 0,
        sha256: manifest.sha256,
        installed: true,
        remoteAvailable: false,
        origin: manifest.source ?? 'release',
        executable: join(this.kernelPath(manifest.version), manifest.executableRelative),
        supported: kernelSupported(manifest)
      } satisfies KernelRelease))
    return [...remote, ...localOnly]
  }

  sources(): string[] {
    return this.settings.get().kernelSources
  }

  async setSources(input: string[]): Promise<string[]> {
    return (await this.settings.update({ kernelSources: validKernelSources(input) })).kernelSources
  }

  private async checksumFromFile(candidate: ReleaseCandidate): Promise<string> {
    if (!candidate.checksumAsset || candidate.checksumAsset.size > 64 * 1024) return ''
    try {
      const response = await this.fetchImpl(candidate.checksumAsset.browser_download_url, { signal: AbortSignal.timeout(15_000) })
      return response.ok ? checksumFor(await response.text(), candidate.asset.name) ?? '' : ''
    } catch {
      return ''
    }
  }

  /**
   * A project's releases, asked of GitHub at most once every RELEASE_LIST_TTL_MS (GitHub allows 60
   * queries an hour per IP without signing in; opening 「下载内核」 again and again used them up). When
   * GitHub refuses or cannot be reached, the last list (up to RELEASE_LIST_STALE_MS old) is used instead.
   */
  private async fetchReleases(url: string): Promise<GithubRelease[]> {
    const cached = this.releaseLists.get(url)
    if (cached && Date.now() - cached.at < RELEASE_LIST_TTL_MS) return cached.releases
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Fingerprint-Browser/0.1' },
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw new Error(githubFailure(response.status, response.headers, Date.now()))
      const releases = await response.json() as GithubRelease[]
      this.releaseLists.set(url, { at: Date.now(), releases })
      return releases
    } catch (error) {
      if (cached && Date.now() - cached.at < RELEASE_LIST_STALE_MS) {
        this.logger?.info('GitHub 暂时不可用，用上次取到的内核列表', { url, error: error instanceof Error ? error.message : String(error) })
        return cached.releases
      }
      throw error
    }
  }

  /** Installs a kernel; `tag` picks an older build (history), which replaces an installed one in place. */
  async install(versionInput: string, tag?: string): Promise<EngineStatus> {
    const version = safeVersion(versionInput)
    if (this.installingVersion) throw new Error(`内核 ${this.installingVersion} 正在安装，请稍候`)
    const existing = await this.readManifest(version)
    const release = (await this.releases()).find((item) => item.version === version && (tag ? item.tag === tag : !item.history))
    if (existing && (!release || !(release.update || (release.history && !release.installed)))) {
      await this.makeDefaultIfNone(version)
      return locateBrowser(this.settings)
    }
    if (!release) throw new Error('没有找到适用于当前系统的内核发行包')
    return this.installRelease(version, release, Boolean(existing))
  }

  /** Downloads and installs `release` as `version` (a new build next to the one in use, when replacing). */
  private async installRelease(version: string, release: KernelRelease, replacing: boolean): Promise<EngineStatus> {
    this.validateRelease(release)
    this.installingVersion = version
    this.installAbort = new AbortController()

    const downloadsPath = join(this.vaultPath, 'downloads')
    const kernelsPath = join(this.vaultPath, 'kernels')
    await Promise.all([mkdir(downloadsPath, { recursive: true }), mkdir(kernelsPath, { recursive: true })])
    // Builds of one version share a zip name; the tag keeps a partial download of one from resuming another.
    const archivePath = join(downloadsPath, `${version}-${(release.tag ?? '').replace(/[^\w.-]/g, '_')}-${basename(release.assetName)}.download`)

    try {
      await this.assertDownloadSpace(downloadsPath, archivePath, release.size)
      await this.download(release, archivePath)
      this.emit(release, 'installing', release.size, release.size, replacing ? '正在更新浏览器内核…' : '正在安装浏览器内核…')
      if (process.platform === 'darwin') await this.installMac(release, archivePath)
      else await this.installWindows(release, archivePath)
      await rm(archivePath, { force: true })
      await this.prepareKernelFonts(release)
      await this.makeDefaultIfNone(version)
      this.logger?.info('浏览器内核安装完成', { version })
      this.emit(release, 'ready', release.size, release.size, replacing ? '内核已更新，使用它的窗口下次启动即用新版' : '内核安装完成')
      return locateBrowser(this.settings)
    } catch (error) {
      const cancelled = this.installAbort.signal.aborted
      const message = cancelled ? '下载已取消，可稍后从断点继续' : error instanceof Error ? error.message : String(error)
      this.emit(release, cancelled ? 'cancelled' : 'error', 0, release.size, message)
      throw new Error(message)
    } finally {
      this.installingVersion = null
      this.installAbort = null
    }
  }

  /**
   * Adds a local build to the installed kernels. It never takes over the default kernel (windows
   * that follow the default would silently change kernel); it only becomes the default when there
   * is no fingerprint kernel to fall back to. A second, different build of an installed version is
   * kept side by side under an id with the import time.
   */
  async importLocal(selection: string): Promise<KernelImportResult> {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw new Error('当前只支持导入 macOS 和 Windows 本地内核')
    }
    if (this.installingVersion) throw new Error(`内核 ${this.installingVersion} 正在安装，请稍候`)
    const executable = await normalizeBrowserSelection(selection)
    const { version: baseVersion, sourceRoot, executableRelative } = await this.inspectLocalBuild(executable)
    if (!await executableSupported(executable)) throw new Error(UNSUPPORTED_IMPORT)
    const sourceIntegrityRoot = process.platform === 'darwin' ? dirname(sourceRoot) : sourceRoot
    const sourceExecutableRelative = process.platform === 'darwin'
      ? join(basename(sourceRoot), 'Contents', 'MacOS', basename(executable))
      : basename(executable)
    const sourceIdentity = kernelPayloadIdentity(
      await collectKernelIntegrity(sourceIntegrityRoot, sourceExecutableRelative),
      sourceExecutableRelative
    )

    // The same build imported again: keep the installed copy.
    for (const [id, existing] of await this.installedManifests()) {
      if (id !== baseVersion && !id.startsWith(`${baseVersion}-`)) continue
      if (existing.source !== 'local-build') continue
      const existingIntegrity = await collectKernelIntegrity(this.kernelPath(id), existing.executableRelative)
      if (kernelPayloadIdentity(existingIntegrity, existing.executableRelative) !== sourceIdentity) continue
      if (!existing.criticalFiles || !existing.criticalFilesSha256) {
        const upgraded: InstalledKernelManifest = { ...existing, schemaVersion: 2, ...existingIntegrity }
        await writeFile(join(this.kernelPath(id), 'manifest.json'), JSON.stringify(upgraded, null, 2), { mode: 0o600 })
        this.logger?.info('本地内核完整性清单已升级', { version: id, files: existingIntegrity.criticalFiles.length })
      }
      const madeDefault = await this.makeDefaultIfNone(id)
      return { version: id, alreadyInstalled: true, madeDefault, engine: await locateBrowser(this.settings) }
    }

    let version = baseVersion
    if (await pathExists(this.kernelPath(version))) {
      const at = new Date()
      version = safeVersion(kernelBuildId(baseVersion, at))
      while (await pathExists(this.kernelPath(version))) {
        at.setMinutes(at.getMinutes() + 1)
        version = safeVersion(kernelBuildId(baseVersion, at))
      }
    }
    const destination = this.kernelPath(version)

    const kernelsPath = join(this.vaultPath, 'kernels')
    await mkdir(kernelsPath, { recursive: true })
    const root = await mkdtemp(join(kernelsPath, `.import-${version}-`))
    const stagingPath = join(root, 'staging')
    await mkdir(stagingPath)
    try {
      if (process.platform === 'darwin') {
        await execFileAsync('ditto', [sourceRoot, join(stagingPath, 'Chromium.app')])
      } else {
        await cp(sourceRoot, join(stagingPath, 'browser'), { recursive: true })
      }
      const importedExecutable = join(stagingPath, executableRelative)
      const info = await stat(importedExecutable)
      if (!info.isFile() || info.size <= 0) throw new Error('导入后的浏览器可执行文件无效')
      const integrity = await collectKernelIntegrity(stagingPath, executableRelative)
      const normalizedExecutableRelative = executableRelative.split(sep).join('/')
      const executableRecord = integrity.criticalFiles.find((file) => file.path === normalizedExecutableRelative)
      if (!executableRecord) throw new Error('内核完整性清单缺少浏览器入口')
      const manifest: InstalledKernelManifest = {
        schemaVersion: 2,
        version,
        assetName: `local-build-${process.platform}-${process.arch}`,
        sha256: executableRecord.sha256,
        installedAt: new Date().toISOString(),
        executableRelative,
        executableSha256: executableRecord.sha256,
        executableSize: executableRecord.size,
        ...integrity,
        source: 'local-build',
        target: `${process.platform}-${process.arch}`,
        supported: true
      }
      await writeFile(join(stagingPath, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
      await rename(stagingPath, destination)
      const madeDefault = await this.makeDefaultIfNone(version)
      this.logger?.info('本地构建内核已导入', { version, target: manifest.target, madeDefault })
      return { version, alreadyInstalled: false, madeDefault, engine: await locateBrowser(this.settings) }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  /** Makes `version` the default only when no fingerprint kernel is usable as the default now. */
  private async makeDefaultIfNone(version: string): Promise<boolean> {
    const current = await locateBrowser(this.settings)
    if (current.executable && current.fingerprintKernel) return false
    await this.activate(version)
    return true
  }

  cancel(versionInput: string): void {
    const version = safeVersion(versionInput)
    if (this.installingVersion !== version || !this.installAbort) throw new Error('该内核当前没有正在进行的安装任务')
    this.installAbort.abort()
  }

  async activate(versionInput: string): Promise<EngineStatus> {
    const version = safeVersion(versionInput)
    const manifest = await this.readManifest(version)
    if (!manifest) throw new Error('该内核尚未安装')
    if (!kernelSupported(manifest)) throw new Error(UNSUPPORTED_KERNEL)
    const executable = join(this.kernelPath(version), manifest.executableRelative)
    if (!await pathExists(executable)) throw new Error('内核文件不完整，请重新安装')
    const integrity = await verifyKernelIntegrity(this.kernelPath(version), manifest.executableRelative, manifest)
    if (integrity.status === 'corrupt') throw new Error(`内核完整性校验失败：${integrity.reason}`)
    await this.rememberPreviousKernel(executable)
    await this.settings.update({ browserExecutable: executable, fingerprintKernel: true, enginePreference: 'auto' })
    this.logger?.info('浏览器内核已切换', { version })
    return locateBrowser(this.settings)
  }

  async configure(patch: Pick<AppSettings, 'browserExecutable' | 'fingerprintKernel' | 'enginePreference'>, resolvedExecutable = patch.browserExecutable): Promise<EngineStatus> {
    if (patch.fingerprintKernel && resolvedExecutable) {
      const { version } = await this.inspectLocalBuild(resolvedExecutable)
    }
    await this.rememberPreviousKernel(resolvedExecutable)
    await this.settings.update(patch)
    return locateBrowser(this.settings)
  }

  async rollbackAvailable(): Promise<boolean> {
    try {
      const backup = await this.readActivationBackup()
      if (!backup) return false
      await this.assertRollbackCandidate(backup.settings)
      return true
    } catch {
      return false
    }
  }

  async rollback(): Promise<EngineStatus> {
    const backup = await this.readActivationBackup()
    if (!backup) throw new Error('没有可回滚的上一个内核')
    const current = this.settings.get()
    const previous = backup.settings
    await this.assertRollbackCandidate(previous)
    try {
      await this.settings.update(previous)
      const engine = await locateBrowser(this.settings)
      if (!engine.executable) throw new Error('上一个内核当前不可用')
      await rm(this.activationBackupPath(), { force: true })
      this.logger?.info('已回滚到上一个浏览器内核', { engine: engine.label, version: engine.version })
      return engine
    } catch (error) {
      await this.settings.update(current)
      throw error
    }
  }

  async verify(versionInput: string): Promise<KernelHealth> {
    const version = safeVersion(versionInput)
    const checkedAt = new Date().toISOString()
    try {
      const manifest = await this.readManifest(version)
      if (!manifest) return { version, status: 'corrupt', message: '内核文件不完整，请重新导入或安装新版指纹浏览器', checkedAt }
      const executable = join(this.kernelPath(version), manifest.executableRelative)
      const info = await stat(executable)
      if (!info.isFile() || info.size <= 0) return { version, status: 'corrupt', message: '内核文件已损坏，请重新导入或安装新版指纹浏览器', checkedAt }
      const integrity = await verifyKernelIntegrity(this.kernelPath(version), manifest.executableRelative, manifest)
      if (integrity.status === 'corrupt') {
        this.logger?.error('浏览器内核完整性检查失败', { version, reason: integrity.reason })
        return { version, status: 'corrupt', message: '内核文件已损坏，请重新导入或安装新版指纹浏览器', checkedAt }
      }
      if (integrity.status === 'healthy') {
        return {
          version,
          status: 'healthy',
          message: '内核完整性正常',
          checkedAt
        }
      }
      if (!manifest.executableSha256 || !manifest.executableSize) {
        this.logger?.info('浏览器内核无法完成完整性检查', { version, reason: integrity.reason })
        return { version, status: 'unverified', message: '当前内核无法完成完整检查，建议重新导入或安装新版指纹浏览器', checkedAt }
      }
      if (info.size !== manifest.executableSize) {
        this.logger?.error('浏览器内核入口大小异常', { version, expected: manifest.executableSize, actual: info.size })
        return { version, status: 'corrupt', message: '内核文件已损坏，请重新导入或安装新版指纹浏览器', checkedAt }
      }
      const actual = await this.hashFile(executable)
      if (actual !== manifest.executableSha256) {
        this.logger?.error('浏览器内核入口摘要与安装记录不一致', { version })
        return { version, status: 'corrupt', message: '内核文件已损坏，请重新导入或安装新版指纹浏览器', checkedAt }
      }
      return { version, status: 'unverified', message: '当前内核无法完成完整检查，建议重新导入或安装新版指纹浏览器', checkedAt }
    } catch (error) {
      return { version, status: 'corrupt', message: error instanceof Error ? error.message : String(error), checkedAt }
    }
  }

  /**
   * Installs the very build that is installed again, as a new build folder next to it (nothing is
   * renamed, so a folder something still uses does not stop it); a failed repair leaves the kernel as it was.
   */
  async repair(versionInput: string): Promise<EngineStatus> {
    const version = safeVersion(versionInput)
    if (this.installingVersion) throw new Error(`内核 ${this.installingVersion} 正在安装，请稍候`)
    // Reinstall the very build that is installed; older/newer builds of the version are other rows.
    const installedSha = (await this.readManifest(version))?.sha256.toLowerCase()
    const rows = (await this.releases()).filter((item) => item.version === version && item.remoteAvailable)
    const release = rows.find((item) => item.sha256 === installedSha) ?? rows.find((item) => !item.history)
    if (!release) throw new Error('远程发行源中已找不到该版本，无法重新安装')
    try {
      const engine = await this.installRelease(version, release, true)
      this.logger?.info('浏览器内核已重新安装并通过发行包校验', { version })
      return engine
    } catch (error) {
      this.logger?.error('浏览器内核重新安装失败，原来的内核没动', { version, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async remove(versionInput: string): Promise<void> {
    const version = safeVersion(versionInput)
    if (this.installingVersion === version) throw new Error('正在安装的内核不能删除')
    const manifest = await this.readManifest(version)
    if (!manifest) throw new Error('该内核尚未安装')
    const users = await this.kernelUsers(version)
    if (users.length) {
      const preview = users.slice(0, 3).map((name) => `“${name}”`).join('、')
      throw new Error(`该内核仍被 ${users.length} 个环境固定使用（${preview}${users.length > 3 ? '等' : ''}），请先修改这些环境`)
    }
    const executable = join(this.kernelPath(version), manifest.executableRelative)
    const configured = this.settings.get().browserExecutable
    if (configured && resolve(configured) === resolve(executable)) {
      throw new Error('当前正在使用该内核，请先切换到其他版本')
    }
    const recycle = join(this.vaultPath, 'recycle-bin', 'kernels')
    await mkdir(recycle, { recursive: true })
    await detachKernelFolderFonts(this.kernelPath(version))
    try {
      await renameKernelFolder(this.kernelPath(version), join(recycle, `${version}-${Date.now()}`), this.logger)
    } catch (error) {
      if (error instanceof Error && error.message === KERNEL_FOLDER_IN_USE) throw new Error(KERNEL_FOLDER_IN_USE_REMOVE)
      throw error
    }
    this.logger?.info('浏览器内核已移入回收目录', { version })
  }

  private async download(release: KernelRelease, destination: string, allowRangeReset = true): Promise<void> {
    let existingBytes = await stat(destination).then((info) => info.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0
      throw error
    })
    if (existingBytes > release.size) {
      await rm(destination, { force: true })
      existingBytes = 0
    }
    if (existingBytes === release.size) {
      const existingHash = createHash('sha256')
      for await (const chunk of createReadStream(destination)) existingHash.update(chunk as Buffer)
      this.emit(release, 'verifying', existingBytes, release.size, '正在校验已下载的内核文件…')
      if (existingHash.digest('hex') === release.sha256.toLowerCase()) return
      await rm(destination, { force: true })
      existingBytes = 0
    }
    const headers: Record<string, string> = {
      accept: 'application/octet-stream',
      'user-agent': 'Fingerprint-Browser/0.1'
    }
    if (existingBytes > 0 && existingBytes < release.size) headers.range = `bytes=${existingBytes}-`
    const response = await this.fetchImpl(release.downloadUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.any([AbortSignal.timeout(15 * 60_000), this.installAbort?.signal ?? new AbortController().signal])
    })
    if (response.status === 416 && existingBytes > 0 && allowRangeReset) {
      await rm(destination, { force: true })
      return this.download(release, destination, false)
    }
    if (!response.ok || !response.body) throw new Error(`内核下载失败（HTTP ${response.status}）`)

    let resumedBytes = 0
    let writeFlags: 'a' | 'w' = 'w'
    if (existingBytes > 0 && response.status === 206) {
      const rangeStart = Number(response.headers.get('content-range')?.match(/^bytes (\d+)-/)?.[1])
      if (rangeStart !== existingBytes) throw new Error('内核下载服务器返回了无效的断点范围')
      resumedBytes = existingBytes
      writeFlags = 'a'
    }

    const hash = createHash('sha256')
    if (resumedBytes) {
      for await (const chunk of createReadStream(destination)) hash.update(chunk as Buffer)
    }
    let received = resumedBytes
    let lastReport = 0
    const progress = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length
        hash.update(chunk)
        const now = Date.now()
        if (now - lastReport > 200) {
          lastReport = now
          this.emit(release, 'downloading', received, release.size, resumedBytes ? '正在从断点继续下载…' : '正在下载浏览器内核…')
        }
        callback(null, chunk)
      }
    })
    const source = Readable.from(response.body as unknown as AsyncIterable<Uint8Array>)
    this.emit(release, 'downloading', received, release.size, resumedBytes ? '正在从断点继续下载…' : '正在下载浏览器内核…')
    await pipeline(source, progress, createWriteStream(destination, { flags: writeFlags, mode: 0o600 }))
    if (received !== release.size) throw new Error(`内核下载不完整：期望 ${release.size} 字节，实际 ${received} 字节`)
    this.emit(release, 'verifying', received, release.size, '正在校验 SHA-256…')
    const actual = hash.digest('hex')
    if (actual !== release.sha256.toLowerCase()) {
      await rm(destination, { force: true })
      throw new Error(`SHA-256 校验失败：期望 ${release.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
    }
  }

  private async assertDownloadSpace(downloadsPath: string, destination: string, totalBytes: number): Promise<void> {
    const existingBytes = await stat(destination).then((info) => Math.min(info.size, totalBytes)).catch(() => 0)
    const remainingBytes = Math.max(0, totalBytes - existingBytes)
    const fileSystem = await statfs(downloadsPath)
    const availableBytes = fileSystem.bavail * fileSystem.bsize
    const reserveBytes = 512 * 1024 * 1024
    if (availableBytes < remainingBytes + reserveBytes) {
      throw new Error(`磁盘空间不足：下载至少还需要 ${Math.ceil((remainingBytes + reserveBytes) / 1024 / 1024)} MB 可用空间`)
    }
  }

  private async installMac(release: KernelRelease, archivePath: string): Promise<InstalledKernelManifest> {
    const root = await mkdtemp(join(this.vaultPath, 'kernels', `.install-${release.version}-`))
    const mountPath = join(root, 'mount')
    const stagingPath = join(root, 'staging')
    await Promise.all([mkdir(mountPath), mkdir(stagingPath)])
    let mounted = false
    try {
      await execFileAsync('hdiutil', ['attach', archivePath, '-nobrowse', '-readonly', '-mountpoint', mountPath])
      mounted = true
      const appBundle = await findEntry(mountPath, (name) => name.endsWith('.app'), 2)
      if (!appBundle) throw new Error('DMG 中没有找到 Chromium.app')
      const targetApp = join(stagingPath, 'Chromium.app')
      await execFileAsync('ditto', [appBundle, targetApp])
      const executable = join(targetApp, 'Contents', 'MacOS', 'Chromium')
      if (!await pathExists(executable)) throw new Error('Chromium.app 内缺少可执行文件')
      const manifest = await this.createManifest(release, stagingPath, relative(stagingPath, executable))
      await writeFile(join(stagingPath, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
      await this.replaceKernelFolder(stagingPath, release.version)
      return manifest
    } finally {
      if (mounted) await execFileAsync('hdiutil', ['detach', mountPath, '-force']).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }

  private async installWindows(release: KernelRelease, archivePath: string): Promise<InstalledKernelManifest> {
    const root = await mkdtemp(join(this.vaultPath, 'kernels', `.install-${release.version}-`))
    const extracted = join(root, 'extracted')
    const stagingPath = join(root, 'staging')
    await Promise.all([mkdir(extracted), mkdir(stagingPath)])
    try {
      // Expand-Archive refuses any file not named *.zip, and the download keeps its .download suffix
      // so an interrupted install can still resume it: extract from a .zip-named link or copy instead.
      const zipPath = join(root, 'kernel.zip')
      await link(archivePath, zipPath).catch(() => copyFile(archivePath, zipPath))
      const command = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "$ProgressPreference = 'SilentlyContinue'",
        `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}' -Force -ErrorAction Stop`
      ].join('; ')
      try {
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { maxBuffer: 16 * 1024 * 1024 })
      } catch (error) {
        const detail = (error as { stderr?: string }).stderr?.trim().split(/\r?\n/)[0]
        throw new Error(`解压内核失败${detail ? `：${detail}` : ''}`)
      }
      const chrome = await findEntry(extracted, (name) => name.toLowerCase() === 'chrome.exe')
      if (!chrome) throw new Error('ZIP 中没有找到 chrome.exe')
      return await this.installBuild(release, dirname(chrome))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  /**
   * Puts a kernel build in its own folder inside the kernel's folder (kernels/<id>/build-<time>/browser)
   * and points the kernel's manifest at it. Nothing in place is renamed: Windows refuses to rename a folder
   * some process works in or has a file open in (an input method's background service, a window still
   * running), which made updates fail. Windows open after this use the new build; the builds before it are
   * removed now or, while something still uses them, later (tidyKernelFolder).
   */
  private async installBuild(release: KernelRelease, browserSource: string): Promise<InstalledKernelManifest> {
    const kernelFolder = this.kernelPath(release.version)
    await mkdir(kernelFolder, { recursive: true })
    const build = await uniqueBuildFolder(kernelFolder)
    const buildPath = join(kernelFolder, build)
    try {
      await cp(browserSource, join(buildPath, 'browser'), { recursive: true })
      const executable = join(buildPath, 'browser', 'chrome.exe')
      const manifest = await this.createManifest(release, kernelFolder, relative(kernelFolder, executable))
      const previous = await this.readManifest(release.version).catch(() => undefined)
      const manifestPath = join(kernelFolder, 'manifest.json')
      await writeFile(`${manifestPath}.next`, JSON.stringify(manifest, null, 2), { mode: 0o600 })
      await rename(`${manifestPath}.next`, manifestPath)
      // The default kernel is a path to its chrome.exe: it follows the new build.
      const configured = this.settings.get().browserExecutable
      if (previous && configured && resolve(configured) === resolve(join(kernelFolder, previous.executableRelative))) {
        await this.settings.update({ browserExecutable: executable })
      }
      this.logger?.info('内核装进新的子文件夹', { version: release.version, build })
      await this.tidyKernelFolder(release.version)
      return manifest
    } catch (error) {
      await rm(`${join(kernelFolder, 'manifest.json')}.next`, { force: true })
      await detachKernelFolderFonts(buildPath)
      await rm(buildPath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  /**
   * Removes what a kernel's folder holds besides its manifest and the build it uses: builds an update
   * replaced. One still in use (a window running from it, a program working in it) is moved away only
   * when nothing uses it; until then it stays and is tried again later.
   */
  private async tidyKernelFolder(version: string): Promise<void> {
    const manifest = await this.readManifest(version).catch(() => undefined)
    if (!manifest) return
    const kernelFolder = this.kernelPath(version)
    const inUse = portableRelativePath(manifest.executableRelative).split('/')[0]
    for (const entry of await readdir(kernelFolder, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name === inUse) continue
      await this.dropFolder(join(kernelFolder, entry.name))
    }
  }

  /**
   * Deletes a folder no kernel uses any more. It is first moved out of the way: that fails while any
   * process still uses something in it, and then it is left for later instead of being half deleted.
   */
  private async dropFolder(folder: string): Promise<void> {
    const trash = join(this.vaultPath, 'kernels', `.trash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      await rename(folder, trash)
    } catch (error) {
      if (folderInUse(error)) {
        this.logger?.info('旧的内核文件夹还在被使用，以后再清理', { folder })
        return
      }
      throw error
    }
    await detachKernelFolderFonts(trash)
    await rm(trash, { recursive: true, force: true }).catch((error) => {
      this.logger?.error('删除旧的内核文件夹失败', { folder: trash, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /**
   * Once per run: builds updates left behind, and what interrupted installs and older launchers left in the
   * kernels folder (.install-…, .trash-…, <id>.old-…), go when nothing uses them.
   */
  private async tidyKernels(): Promise<void> {
    if (this.tidied || this.installingVersion) return
    this.tidied = true
    const root = join(this.vaultPath, 'kernels')
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      if (isKernelId(entry.name)) await this.tidyKernelFolder(entry.name).catch(() => undefined)
      else if (/^\.(install|trash)-/.test(entry.name) || /\.old-\d+$/.test(entry.name)) {
        await this.dropFolder(join(root, entry.name)).catch(() => undefined)
      }
    }
  }

  /**
   * The kernel's Windows fonts go to the shared font package (kept across kernel updates) and
   * the kernel gets a link to it; the package is downloaded once when no kernel brought it along.
   */
  private async prepareKernelFonts(release: KernelRelease): Promise<void> {
    if (process.platform !== 'win32') return
    const manifest = await this.readManifest(release.version)
    if (!manifest) return
    // The kernel is in either way: a font package that did not come down is fetched again when a window opens.
    await ensureKernelFonts(join(this.kernelPath(release.version), manifest.executableRelative), this.vaultPath, this.fetchImpl,
      (progress) => this.emit(release, progress.stage === 'downloading' ? 'downloading' : 'installing', progress.receivedBytes, progress.totalBytes,
        progress.stage === 'downloading' ? '正在下载内核字体包（只需下载一次，以后更新内核不用再下）…' : '正在安装内核字体包…'),
      this.installAbort?.signal, this.logger).catch((error) => {
      this.logger?.error('内核字体包没有准备好，打开窗口时再试', { version: release.version, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** Moves a staged kernel into place; an installed one is kept aside until the new one is in. */
  private async replaceKernelFolder(staging: string, version: string): Promise<void> {
    const target = this.kernelPath(version)
    if (!await pathExists(target)) {
      await rename(staging, target)
      return
    }
    const previous = `${target}.old-${Date.now()}`
    await renameKernelFolder(target, previous, this.logger)
    try {
      await rename(staging, target)
    } catch (error) {
      await rename(previous, target).catch(() => undefined)
      throw error
    }
    await detachKernelFolderFonts(previous)
    await rm(previous, { recursive: true, force: true })
  }

  private async createManifest(release: KernelRelease, root: string, executableRelative: string): Promise<InstalledKernelManifest> {
    const executable = join(root, executableRelative)
    const executableInfo = await stat(executable)
    const integrity = await collectKernelIntegrity(root, executableRelative)
    return {
      schemaVersion: 2,
      version: release.version,
      assetName: release.assetName,
      sha256: release.sha256,
      installedAt: new Date().toISOString(),
      executableRelative,
      executableSha256: await this.hashFile(executable),
      executableSize: executableInfo.size,
      ...integrity,
      source: 'release',
      target: `${process.platform}-${process.arch}`,
      ...(release.source ? { sourceRepo: release.source } : {}),
      ...(release.tag ? { releaseTag: release.tag } : {}),
      publishedAt: release.publishedAt
    }
  }

  private async inspectLocalBuild(executable: string): Promise<{ version: string; sourceRoot: string; executableRelative: string }> {
    if (process.platform === 'darwin') {
      let sourceRoot = dirname(resolve(executable))
      while (!sourceRoot.endsWith('.app')) {
        const parent = dirname(sourceRoot)
        if (parent === sourceRoot) throw new Error('所选文件不在 macOS .app 浏览器包中')
        sourceRoot = parent
      }
      const plist = join(sourceRoot, 'Contents', 'Info.plist')
      const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])
      const version = safeVersion(stdout.trim())
      return { version, sourceRoot, executableRelative: join('Chromium.app', 'Contents', 'MacOS', basename(executable)) }
    }

    if (basename(executable).toLowerCase() !== 'chrome.exe') {
      throw new Error(`请选择 chrome.exe（你选的是 ${basename(executable)}）。chromedriver.exe 和安装程序都不能导入：先把 windows_x64.zip 解压，再选里面的 chrome.exe`)
    }
    if (!await pathExists(join(dirname(executable), 'chrome.dll'))
      && !(await readdir(dirname(executable))).some((name) => /^\d+(?:\.\d+){3}$/.test(name))) {
      throw new Error('chrome.exe 旁边缺少 chrome.dll，这不是完整的浏览器文件夹：请先把 windows_x64.zip 完整解压，再选里面的 chrome.exe')
    }
    const escaped = executable.replaceAll("'", "''")
    const command = `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
    const match = stdout.match(/\d+(?:\.\d+){3}/)
    if (!match) throw new Error('无法从 chrome.exe 读取四段式 Chromium 版本')
    // Every local Windows build is taken as a Prism-switch kernel. A build without our
    // switch name still imports; it is only logged, since it may ignore the fingerprint switches.
    const prism = process.platform !== 'win32' || await isPrismBuild(dirname(executable), match[0])
    if (!prism) this.logger?.info('导入的内核里没找到 Prism 开关标记，指纹参数可能不生效', { executable })
    return {
      version: safeVersion(process.platform === 'win32' ? `prism-${match[0]}` : match[0]),
      sourceRoot: dirname(executable),
      executableRelative: join('browser', 'chrome.exe')
    }
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    return hash.digest('hex')
  }

  private activationBackupPath(): string {
    return join(this.vaultPath, 'kernels', 'activation-backup.json')
  }

  private async rememberPreviousKernel(nextExecutable: string): Promise<void> {
    const previous = this.settings.get()
    if (previous.browserExecutable && resolve(previous.browserExecutable) === resolve(nextExecutable)) return
    await mkdir(join(this.vaultPath, 'kernels'), { recursive: true })
    const backup: KernelActivationBackup = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      settings: previous
    }
    await writeFile(this.activationBackupPath(), JSON.stringify(backup, null, 2), { mode: 0o600 })
  }

  private async readActivationBackup(): Promise<KernelActivationBackup | undefined> {
    try {
      const value = JSON.parse(await readFile(this.activationBackupPath(), 'utf8')) as Partial<KernelActivationBackup>
      if (value.schemaVersion !== 1 || typeof value.recordedAt !== 'string' || !value.settings
        || typeof value.settings.browserExecutable !== 'string'
        || typeof value.settings.fingerprintKernel !== 'boolean'
        || !['auto', 'bundled', 'system'].includes(value.settings.enginePreference)
        || ![0, 7, 30, 90].includes(value.settings.recycleRetentionDays)) {
        throw new Error('内核回滚记录无效')
      }
      return value as KernelActivationBackup
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async assertRollbackCandidate(previous: AppSettings): Promise<void> {
    if (!previous.browserExecutable) {
      const engine = await locateBrowserSelection(previous)
      if (!engine.executable) throw new Error('上一个内核选择当前不可用，无法回滚')
      return
    }
    if (!await pathExists(previous.browserExecutable)) throw new Error('上一个内核文件已经不存在，无法回滚')
    const kernelsRoot = resolve(this.vaultPath, 'kernels')
    const executable = resolve(previous.browserExecutable)
    if (!executable.startsWith(`${kernelsRoot}${sep}`)) return
    const version = relative(kernelsRoot, executable).split(sep)[0]
    const health = await this.verify(version)
    if (health.status === 'corrupt') throw new Error(`上一个内核健康检查失败：${health.message}`)
  }

  private validateRelease(release: KernelRelease): void {
    if (!isSourceDownloadUrl(release.downloadUrl, this.settings.get().kernelSources)) {
      throw new Error('内核下载地址不属于已添加的内核来源')
    }
    if (!/^[a-f\d]{64}$/i.test(release.sha256)) throw new Error('发行包缺少有效的 SHA-256')
    if (release.size < 10_000_000 || release.size > 800_000_000) throw new Error('发行包大小异常')
  }

  private kernelPath(version: string): string {
    return join(this.vaultPath, 'kernels', safeVersion(version))
  }

  private async readManifest(version: string): Promise<InstalledKernelManifest | undefined> {
    try {
      const manifest = JSON.parse(await readFile(join(this.kernelPath(version), 'manifest.json'), 'utf8')) as InstalledKernelManifest
      if (manifest.version !== version || typeof manifest.assetName !== 'string' || !/^[a-f\d]{64}$/i.test(manifest.sha256)
        || typeof manifest.installedAt !== 'string' || typeof manifest.executableRelative !== 'string') {
        throw new Error('内核清单字段无效')
      }
      const root = resolve(this.kernelPath(version))
      const executable = resolve(root, manifest.executableRelative)
      if (isAbsolute(manifest.executableRelative) || (executable !== root && !executable.startsWith(`${root}${sep}`))) {
        throw new Error('内核清单中的可执行文件路径越界')
      }
      if (manifest.executableSha256 !== undefined && !/^[a-f\d]{64}$/i.test(manifest.executableSha256)) {
        throw new Error('内核可执行文件摘要无效')
      }
      if (manifest.executableSize !== undefined && (!Number.isSafeInteger(manifest.executableSize) || manifest.executableSize <= 0)) {
        throw new Error('内核可执行文件大小无效')
      }
      if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
        throw new Error('内核清单版本无效')
      }
      if (manifest.schemaVersion === 2 && (!manifest.criticalFiles || !manifest.criticalFilesSha256)) {
        throw new Error('内核关键文件清单缺失')
      }
      const integrityError = validateKernelIntegrityFields(manifest, manifest.executableRelative)
      if (integrityError) throw new Error(integrityError)
      if (manifest.source !== undefined && manifest.source !== 'release' && manifest.source !== 'local-build') {
        throw new Error('内核来源字段无效')
      }
      if (manifest.target !== undefined && (typeof manifest.target !== 'string' || manifest.target.length > 64)) {
        throw new Error('内核目标平台字段无效')
      }
      return manifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async installedManifests(): Promise<Map<string, InstalledKernelManifest>> {
    const result = new Map<string, InstalledKernelManifest>()
    const root = join(this.vaultPath, 'kernels')
    await mkdir(root, { recursive: true })
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const manifest = await this.readManifest(entry.name).catch(() => undefined)
      if (manifest) result.set(entry.name, manifest)
    }
    return result
  }

  private emit(
    release: KernelRelease,
    stage: KernelInstallProgress['stage'],
    receivedBytes: number,
    totalBytes: number,
    message: string
  ): void {
    this.onProgress({
      version: release.version,
      stage,
      receivedBytes,
      totalBytes,
      percent: totalBytes ? Math.min(100, Math.round(receivedBytes / totalBytes * 100)) : 0,
      message
    })
  }
}
