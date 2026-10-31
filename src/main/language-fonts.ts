import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'
import {
  LANGUAGES_AND_OPTIONAL_FEATURES_ISO,
  WINDOWS_FONT_PACKS,
  windowsFontPack,
  type FontPackProgress,
  type FontPackStatus,
  type WindowsFontPack
} from '../shared/windows-font-packs'
import type { AppLogger } from './app-logger'
import { hostHardwareSnapshot } from './host-hardware'
import { otherWindowsFontsInstalled, PRISM_SYSTEM_FONTS_FOLDER } from './other-windows-fonts'

const execFileAsync = promisify(execFile)

const windowsFolder = () => process.env.WINDIR ?? 'C:\\Windows'
const systemFonts = () => join(windowsFolder(), 'Fonts')
/** Where Windows keeps the fonts installed for the current user only. */
const userFonts = () => join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')
const USER_FONTS_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'

const exists = (path: string) => access(path).then(() => true, () => false)
const hasFont = async (file: string) => await exists(join(systemFonts(), file)) || await exists(join(userFonts(), file))

async function packInstalled(pack: WindowsFontPack): Promise<boolean> {
  for (const file of pack.fonts) if (!await hasFont(file)) return false
  return true
}

/** Which language font packages this computer has, for all users or the current one. */
export async function fontPackStatus(): Promise<FontPackStatus> {
  if (process.platform !== 'win32') return { installed: [], missing: [], supported: false }
  const installed: string[] = []
  const missing: string[] = []
  for (const pack of WINDOWS_FONT_PACKS) (await packInstalled(pack) ? installed : missing).push(pack.script)
  const otherWindowsFonts = {
    hostPlatformVersion: hostHardwareSnapshot().platformVersion,
    win10: await otherWindowsFontsInstalled('win10'),
    win11: await otherWindowsFontsInstalled('win11')
  }
  return { installed, missing, supported: true, otherWindowsFonts }
}

/**
 * The name Windows files a font under in the Fonts registry key: the full names of the faces in
 * the file joined by " & ", e.g. "Batang & BatangChe & Gungsuh & GungsuhChe (TrueType)".
 */
export function fontRegistryName(data: Buffer, fallback: string): string {
  const faceOffsets = data.toString('latin1', 0, 4) === 'ttcf'
    ? Array.from({ length: data.readUInt32BE(8) }, (_, index) => data.readUInt32BE(12 + index * 4))
    : [0]
  const names: string[] = []
  for (const face of faceOffsets) {
    const tables = data.readUInt16BE(face + 4)
    let name: string | undefined
    for (let index = 0; index < tables && !name; index++) {
      const record = face + 12 + index * 16
      if (data.toString('latin1', record, record + 4) !== 'name') continue
      const table = data.readUInt32BE(record + 8)
      const count = data.readUInt16BE(table + 2)
      const strings = table + data.readUInt16BE(table + 4)
      let best: { score: number; text: string } | undefined
      for (let entry = 0; entry < count; entry++) {
        const at = table + 6 + entry * 12
        const [platform, , language, nameId, length, offset] = [0, 2, 4, 6, 8, 10].map((field) => data.readUInt16BE(at + field))
        if (nameId !== 4 || (platform !== 3 && platform !== 1)) continue
        const raw = data.subarray(strings + offset, strings + offset + length)
        const text = platform === 3 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1')
        const score = (platform === 3 ? 2 : 0) + (language === 0x409 || (platform === 1 && language === 0) ? 1 : 0)
        if (!best || score > best.score) best = { score, text }
      }
      name = best?.text
    }
    if (name && !names.includes(name)) names.push(name)
  }
  return `${names.length ? names.join(' & ') : fallback} (TrueType)`
}

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
 * Downloads a language font package from Microsoft and installs its fonts for the current user,
 * the way "Install" in a font's context menu does: the file goes to the user's Fonts folder and
 * gets a value under HKCU's Fonts key. Windows and Chrome pick per-user fonts up like system ones.
 */
export async function installFontPack(script: string, fetchImpl: Fetch, onProgress: (progress: FontPackProgress) => void, logger?: AppLogger): Promise<void> {
  const pack = windowsFontPack(script)
  if (!pack) throw new Error(`没有 ${script} 字体包`)
  if (await packInstalled(pack)) return
  const work = await mkdtemp(join(tmpdir(), `prism-fonts-${script}-`))
  try {
    logger?.info('下载语言字体包', { script, bytes: pack.size })
    const cab = join(work, 'pack.cab')
    await downloadPack(pack, cab, fetchImpl, onProgress)
    onProgress({ script, receivedBytes: pack.size, totalBytes: pack.size, stage: 'installing' })
    const extracted = join(work, 'files')
    await mkdir(extracted)
    await execFileAsync(join(windowsFolder(), 'System32', 'expand.exe'), ['-F:*', cab, extracted], { windowsHide: true })
    const files = await findFiles(extracted)
    await mkdir(userFonts(), { recursive: true })
    for (const font of pack.fonts) {
      if (await hasFont(font)) continue
      const source = files.get(font)
      if (!source) throw new Error(`字体包里缺少 ${font}`)
      const target = join(userFonts(), font)
      await copyFile(source, target)
      const name = fontRegistryName(await readFile(target), font)
      await execFileAsync('reg.exe', ['add', USER_FONTS_KEY, '/v', name, '/t', 'REG_SZ', '/d', target, '/f'], { windowsHide: true })
    }
    onProgress({ script, receivedBytes: pack.size, totalBytes: pack.size, stage: 'done' })
    logger?.info('语言字体包已安装', { script })
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * prism16+: puts a language font package into the kernel's own fonts
 * (prism-system-fonts\\<win10|win11>\\<script> next to chrome.exe), where the kernel looks for the
 * package of the window's display language; nothing is installed into Windows. Downloaded from
 * Microsoft like installFontPack. Packages the kernel already ships (Simplified Chinese and Arabic,
 * in the versions Windows Update brings) are left alone.
 */
export async function installKernelFontPack(script: string, kernelExecutable: string, windows: 'win10' | 'win11', fetchImpl: Fetch, onProgress: (progress: FontPackProgress) => void, logger?: AppLogger): Promise<void> {
  const pack = windowsFontPack(script)
  if (!pack) throw new Error(`没有 ${script} 字体包`)
  const folder = join(dirname(kernelExecutable), PRISM_SYSTEM_FONTS_FOLDER, windows, script)
  const present = async () => {
    for (const font of pack.fonts) if (!await exists(join(folder, font))) return false
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
    for (const font of pack.fonts) {
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

export function registerLanguageFontsIpc(fetchImpl: Fetch, send: (progress: FontPackProgress) => void, logger?: AppLogger): void {
  // One package at a time: a second click waits for the first instead of downloading twice.
  let queue: Promise<unknown> = Promise.resolve()
  ipcMain.handle('fonts:packs', () => fontPackStatus())
  ipcMain.handle('fonts:install-packs', (_event, scripts?: string[]) => {
    const run = queue.then(async () => {
      const wanted = scripts?.length ? scripts : (await fontPackStatus()).missing
      for (const script of wanted) await installFontPack(script, fetchImpl, send, logger)
      return fontPackStatus()
    })
    queue = run.catch(() => undefined)
    return run
  })
}
