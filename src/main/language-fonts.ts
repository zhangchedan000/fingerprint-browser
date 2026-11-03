import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import {
  LANGUAGES_AND_OPTIONAL_FEATURES_ISO,
  windowsFontPack,
  type FontPackProgress,
  type WindowsFontPack
} from '../shared/windows-font-packs'
import type { AppLogger } from './app-logger'
import { PRISM_SYSTEM_FONTS_FOLDER } from './kernel-fonts'

const execFileAsync = promisify(execFile)

const windowsFolder = () => process.env.WINDIR ?? 'C:\\Windows'

const exists = (path: string) => access(path).then(() => true, () => false)

type Fetch = typeof fetch

/** Reads one package's .cab out of Microsoft's ISO into `destination`, checking its SHA-256. */
async function downloadPack(pack: WindowsFontPack, destination: string, fetchImpl: Fetch, onProgress: (progress: FontPackProgress) => void): Promise<void> {
  const response = await fetchImpl(LANGUAGES_AND_OPTIONAL_FEATURES_ISO, {
    headers: { range: `bytes=${pack.offset}-${pack.offset + pack.size - 1}` },
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60_000)
  })
  if (response.status !== 206 || !response.body) throw new Error(`字体包下载失败（HTTP ${response.status}）`)
  const hash = createHash('sha256')
  let received = 0
  let lastReport = 0
  const report = (stage: FontPackProgress['stage']) => onProgress({ script: pack.script, receivedBytes: received, totalBytes: pack.size, stage })
  const counter = new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      received += chunk.length
      hash.update(chunk)
      if (Date.now() - lastReport > 200) {
        lastReport = Date.now()
        report('downloading')
      }
      callback(null, chunk)
    }
  })
  report('downloading')
  await pipeline(Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), counter, createWriteStream(destination))
  report('downloading')
  if (received !== pack.size || hash.digest('hex') !== pack.sha256) throw new Error('字体包下载不完整，请重试')
}

async function findFiles(folder: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.set(entry.name.toLowerCase(), join(entry.parentPath, entry.name))
  }
  return found
}

/**
 * Puts a language font package into the kernel's own fonts
 * (prism-system-fonts\\<win10|win11>\\<script> next to chrome.exe), where the kernel looks for the
 * package of the window's display language; nothing is installed into Windows. Downloaded from
 * Microsoft's ISO by an HTTP range (windows-font-packs.ts). Packages the kernel already ships (Simplified Chinese and Arabic,
 * in the versions Windows Update brings) are left alone.
 */
export async function installKernelFontPack(script: string, kernelExecutable: string, windows: 'win10' | 'win11', fetchImpl: Fetch, onProgress: (progress: FontPackProgress) => void, logger?: AppLogger): Promise<void> {
  const pack = windowsFontPack(script)
  if (!pack) throw new Error(`没有 ${script} 字体包`)
  const folder = join(dirname(kernelExecutable), PRISM_SYSTEM_FONTS_FOLDER, windows, script)
  // A file the base fonts already have (MS Gothic of the Japanese package) is left out: one copy only, as
  // the kernel package does (build-system-fonts.py).
  const base = join(dirname(folder), 'base')
  const fonts: string[] = []
  for (const font of pack.fonts) if (!await exists(join(base, font))) fonts.push(font)
  const present = async () => {
    for (const font of fonts) if (!await exists(join(folder, font))) return false
    return true
  }
  if (await present()) return
  const work = await mkdtemp(join(tmpdir(), `prism-fonts-${script}-`))
  try {
    logger?.info('下载语言字体包到内核', { script, windows, bytes: pack.size })
    const cab = join(work, 'pack.cab')
    await downloadPack(pack, cab, fetchImpl, onProgress)
    onProgress({ script, receivedBytes: pack.size, totalBytes: pack.size, stage: 'installing' })
    const extracted = join(work, 'files')
    await mkdir(extracted)
    await execFileAsync(join(windowsFolder(), 'System32', 'expand.exe'), ['-F:*', cab, extracted], { windowsHide: true })
    const files = await findFiles(extracted)
    // Into a temporary folder first: a window that starts meanwhile sees the package whole or not at all.
    const staging = `${folder}.part`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    for (const font of fonts) {
      const source = files.get(font)
      if (!source) throw new Error(`字体包里缺少 ${font}`)
      await copyFile(source, join(staging, font))
    }
    await rm(folder, { recursive: true, force: true })
    await rename(staging, folder)
    onProgress({ script, receivedBytes: pack.size, totalBytes: pack.size, stage: 'done' })
    logger?.info('语言字体包已放进内核', { script, windows })
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}
