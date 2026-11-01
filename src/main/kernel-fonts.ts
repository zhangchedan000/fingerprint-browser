import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, lstat, mkdir, readdir, readlink, rename, rm, rmdir, stat, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { kernelFontPackage, type KernelFontPackage } from '../shared/kernel-capabilities'
import type { Logger } from './app-logger'
import { PRISM_SYSTEM_FONTS_FOLDER } from './other-windows-fonts'

const execFileAsync = promisify(execFile)
type Fetch = typeof fetch

/**
 * prism16+ kernels read their Windows fonts from `prism-system-fonts` next to chrome.exe. The fonts
 * (about 550 MB) change far less often than the kernel, so they live once per font package version
 * in the data folder (`kernel-fonts\v<n>`), shared by every kernel and kept across kernel updates,
 * and each kernel gets a directory junction to them. The language packages the launcher downloads
 * later (installKernelFontPack) land in the store through the junction, so they stay too.
 */
export const KERNEL_FONTS_FOLDER = 'kernel-fonts'
/** `script` of the font progress events (fonts:progress) while the shared font package downloads. */
export const KERNEL_FONT_PROGRESS = 'kernel-fonts'

export const kernelFontStore = (vaultPath: string, pkg: KernelFontPackage) => join(vaultPath, KERNEL_FONTS_FOLDER, `v${pkg.version}`)

const exists = (path: string) => access(path).then(() => true, () => false)
const samePath = (a: string, b: string) => resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase()

/** The store holds both Windows' base fonts and fallback rules. */
export async function kernelFontStoreReady(store: string): Promise<boolean> {
  for (const windows of ['win10', 'win11']) {
    if (!await exists(join(store, windows, 'base')) || !await exists(join(store, windows, 'fallback.txt'))) return false
  }
  return true
}

/**
 * Removes the junction a kernel folder has to the shared fonts, before the folder is deleted or moved
 * away, so nothing removing the folder can reach the shared fonts through it.
 */
export async function detachKernelFonts(browserFolder: string): Promise<void> {
  const link = join(browserFolder, PRISM_SYSTEM_FONTS_FOLDER)
  const info = await lstat(link).catch(() => undefined)
  if (info?.isSymbolicLink()) await rmdir(link).catch(() => rm(link, { force: true }))
}

/** detachKernelFonts for every browser folder in a kernel folder (`browser`, or older layouts). */
export async function detachKernelFolderFonts(kernelFolder: string): Promise<void> {
  const entries = await readdir(kernelFolder, { withFileTypes: true }).catch(() => [])
  await detachKernelFonts(kernelFolder)
  for (const entry of entries) if (entry.isDirectory()) await detachKernelFonts(join(kernelFolder, entry.name))
}

/**
 * Points a kernel at the shared fonts. A kernel package that still carries its own fonts (prism16) gives
 * them to the store when the store has none, else its language packages the store lacks; its own copy is
 * then removed. Returns false when the store is not there yet (it has to be downloaded).
 */
export async function linkKernelFonts(browserFolder: string, store: string, logger?: Logger): Promise<boolean> {
  const link = join(browserFolder, PRISM_SYSTEM_FONTS_FOLDER)
  const info = await lstat(link).catch(() => undefined)
  if (info?.isSymbolicLink()) {
    const target = await readlink(link).catch(() => '')
    if (samePath(target, store) && await kernelFontStoreReady(store)) return true
    await rmdir(link).catch(() => rm(link, { force: true }))
  } else if (info?.isDirectory()) {
    try {
      if (!await kernelFontStoreReady(store)) {
        if (await kernelFontStoreReady(link)) {
          await mkdir(dirname(store), { recursive: true })
          await rm(store, { recursive: true, force: true })
          await rename(link, store)
          logger?.info('内核自带的字体移到共用位置，以后更新内核不用再下载', { store })
        }
      } else {
        // Language packages downloaded into this kernel before: keep them in the store.
        for (const windows of ['win10', 'win11']) {
          for (const entry of await readdir(join(link, windows), { withFileTypes: true }).catch(() => [])) {
            if (entry.isDirectory() && !await exists(join(store, windows, entry.name))) {
              await rename(join(link, windows, entry.name), join(store, windows, entry.name))
            }
          }
        }
        await rm(link, { recursive: true, force: true })
      }
    } catch (error) {
      // A window of this kernel holds the fonts open: keep its own copy for now, link next time.
      logger?.info('内核字体正在使用，暂时不移动', { error: error instanceof Error ? error.message : String(error) })
      return kernelFontStoreReady(link)
    }
  }
  if (!await kernelFontStoreReady(store)) return false
  if (await lstat(link).catch(() => undefined)) return true
  await symlink(store, link, 'junction')
  return true
}

export interface KernelFontDownloadProgress { receivedBytes: number; totalBytes: number; stage: 'downloading' | 'installing' }

/** Downloads a font package (SHA-256 checked) and unpacks it as the store; whole or not at all. */
export async function installKernelFontStore(store: string, pkg: KernelFontPackage, fetchImpl: Fetch, onProgress: (progress: KernelFontDownloadProgress) => void, signal?: AbortSignal, logger?: Logger): Promise<void> {
  if (await kernelFontStoreReady(store)) return
  const root = dirname(store)
  await mkdir(root, { recursive: true })
  const archive = `${store}.zip.download`
  let have = await stat(archive).then((info) => info.size, () => 0)
  if (have > pkg.size) { await rm(archive, { force: true }); have = 0 }
  if (have < pkg.size) {
    logger?.info('下载内核字体包', { version: pkg.version, bytes: pkg.size, resume: have })
    const response = await fetchImpl(pkg.url, {
      headers: { accept: 'application/octet-stream', 'user-agent': 'Fingerprint-Browser/0.1', ...(have ? { range: `bytes=${have}-` } : {}) },
      redirect: 'follow',
      signal: AbortSignal.any([AbortSignal.timeout(60 * 60_000), signal ?? new AbortController().signal])
    })
    if (!response.ok || !response.body) throw new Error(`内核字体包下载失败（HTTP ${response.status}）`)
    if (have && response.status !== 206) have = 0
    let received = have
    let last = 0
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length
        if (Date.now() - last > 300) { last = Date.now(); onProgress({ receivedBytes: received, totalBytes: pkg.size, stage: 'downloading' }) }
        callback(null, chunk)
      }
    })
    await pipeline(Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), counter, createWriteStream(archive, { flags: have ? 'a' : 'w' }))
  }
  onProgress({ receivedBytes: pkg.size, totalBytes: pkg.size, stage: 'installing' })
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk as Buffer)
  if (hash.digest('hex') !== pkg.sha256) {
    await rm(archive, { force: true })
    throw new Error('内核字体包下载不完整，请重试')
  }
  const staging = `${store}.part`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const command = [
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::ExtractToDirectory('${archive.replaceAll("'", "''")}', '${staging.replaceAll("'", "''")}')`
  ].join('; ')
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { maxBuffer: 16 * 1024 * 1024 })
  if (!await kernelFontStoreReady(staging)) throw new Error('内核字体包内容不完整')
  await rm(store, { recursive: true, force: true })
  await rename(staging, store)
  await rm(archive, { force: true })
  logger?.info('内核字体包已就绪', { version: pkg.version, store })
}

/**
 * Makes a prism16+ kernel's fonts ready: links it to the shared store, downloading the store first when
 * neither the store nor the kernel package has the fonts. Kernels without built-in fonts: nothing to do.
 */
export async function ensureKernelFonts(builtInFonts: boolean | undefined, kernelExecutable: string, vaultPath: string, fetchImpl: Fetch, onProgress: (progress: KernelFontDownloadProgress) => void, signal?: AbortSignal, logger?: Logger): Promise<void> {
  const pkg = kernelFontPackage(builtInFonts)
  if (!pkg) return
  const store = kernelFontStore(vaultPath, pkg)
  const browserFolder = dirname(kernelExecutable)
  if (await linkKernelFonts(browserFolder, store, logger)) return
  await installKernelFontStore(store, pkg, fetchImpl, onProgress, signal, logger)
  await linkKernelFonts(browserFolder, store, logger)
}
