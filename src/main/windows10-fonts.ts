import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AppLogger } from './app-logger'
import { fontRegistryName } from './language-fonts'

const execFileAsync = promisify(execFile)

/**
 * Windows 10's own Segoe UI Emoji (1.29), for Windows 10 windows on a Windows 11 computer: Windows
 * 11's emoji are newer and a page sees their sizes (CreepJS). The file comes from a real Windows 10
 * (LTSC 21H2) and may not be published: it is a private file of the team server
 * (server/team/README.md, 私有文件), with a copy kept in the vault's private-fonts folder, where it
 * can also be put by hand. (Windows 10's Segoe UI 5.62 shapes text exactly as Windows 11's 5.72, so
 * segoeui-win10.zip on the server is not used.)
 */
export const WINDOWS10_FONT_ASSETS = [
  { name: 'seguiemj-win10.ttf', bytes: 2_072_388, sha256: '7c0244dd8eeb7c6bdecdfc3f9e59833527fc18a66d0295ce47339069692a2b4f' }
] as const
export type Windows10FontAsset = (typeof WINDOWS10_FONT_ASSETS)[number]['name']

/**
 * Installed under another name so it sits beside Windows 11's own: "PrismW10 " before every family
 * and full name, "PrismW10" before the PostScript name. The kernel (patch 007, prism13) asks a
 * Windows 10 window's Segoe UI Emoji for it first; nothing else sees it.
 */
export const PRISM_W10_PREFIX = 'PrismW10'
const installedFile = (file: string) => `${PRISM_W10_PREFIX}-${file}`
const ALL_FILES = ['seguiemj.ttf']

const userFonts = () => join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')
const USER_FONTS_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
const exists = (path: string) => access(path).then(() => true, () => false)
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** Whether this user has the renamed Windows 10 emoji font. */
export async function windows10FontsInstalled(folder = userFonts()): Promise<boolean> {
  for (const file of ALL_FILES) if (!await exists(join(folder, installedFile(file)))) return false
  return true
}

// name IDs: 1 family, 3 unique ID, 4 full name, 16 typographic family, 18 compatible full (Mac),
// 21 WWS family; 6 PostScript name, 20 PostScript CID findfont name.
const SPACED_NAME_IDS = new Set([1, 3, 4, 16, 18, 21])
const POSTSCRIPT_NAME_IDS = new Set([6, 20])

function checksum(data: Buffer): number {
  let sum = 0
  for (let at = 0; at < data.length; at += 4) {
    const word = Buffer.alloc(4)
    data.copy(word, 0, at, Math.min(at + 4, data.length))
    sum = (sum + word.readUInt32BE(0)) >>> 0
  }
  return sum
}

/** The font with "PrismW10" before its family, full, unique and PostScript names (one font, not a collection). */
export function prismW10Font(data: Buffer): Buffer {
  if (data.toString('latin1', 0, 4) === 'ttcf') throw new Error('字体集合文件不支持改名')
  const numTables = data.readUInt16BE(4)
  const tables = Array.from({ length: numTables }, (_, index) => {
    const record = 12 + index * 16
    const offset = data.readUInt32BE(record + 8)
    const length = data.readUInt32BE(record + 12)
    return { tag: data.toString('latin1', record, record + 4), data: Buffer.from(data.subarray(offset, offset + length)) }
  })
  const name = tables.find((table) => table.tag === 'name')
  const head = tables.find((table) => table.tag === 'head')
  if (!name || !head) throw new Error('不是字体文件')

  // The name table again, prefixed strings in place of the old ones.
  const old = name.data
  const format = old.readUInt16BE(0)
  const count = old.readUInt16BE(2)
  const storage = old.readUInt16BE(4)
  const strings: Buffer[] = []
  const records: number[][] = []
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 12
    const [platform, encoding, language, nameId, length, offset] = [0, 2, 4, 6, 8, 10].map((field) => old.readUInt16BE(at + field))
    let text = old.subarray(storage + offset, storage + offset + length)
    const prefix = SPACED_NAME_IDS.has(nameId) ? `${PRISM_W10_PREFIX} ` : POSTSCRIPT_NAME_IDS.has(nameId) ? PRISM_W10_PREFIX : ''
    if (prefix) {
      const bytes = platform === 1 ? Buffer.from(prefix, 'latin1') : Buffer.from(prefix, 'utf16le').swap16()
      text = Buffer.concat([bytes, text])
    }
    records.push([platform, encoding, language, nameId, text.length])
    strings.push(Buffer.from(text))
  }
  const langTags: Buffer[] = []
  const langTagLengths: number[] = []
  if (format === 1) {
    const tagCount = old.readUInt16BE(6 + count * 12)
    for (let index = 0; index < tagCount; index++) {
      const at = 6 + count * 12 + 2 + index * 4
      const length = old.readUInt16BE(at)
      const offset = old.readUInt16BE(at + 2)
      langTags.push(Buffer.from(old.subarray(storage + offset, storage + offset + length)))
      langTagLengths.push(length)
    }
  }
  const headerLength = 6 + count * 12 + (format === 1 ? 2 + langTags.length * 4 : 0)
  const header = Buffer.alloc(headerLength)
  header.writeUInt16BE(format, 0)
  header.writeUInt16BE(count, 2)
  header.writeUInt16BE(headerLength, 4)
  let offset = 0
  records.forEach(([platform, encoding, language, nameId, length], index) => {
    const at = 6 + index * 12
    for (const [field, value] of [[0, platform], [2, encoding], [4, language], [6, nameId], [8, length], [10, offset]]) header.writeUInt16BE(value, at + field)
    offset += length
  })
  if (format === 1) {
    header.writeUInt16BE(langTags.length, 6 + count * 12)
    langTagLengths.forEach((length, index) => {
      const at = 6 + count * 12 + 2 + index * 4
      header.writeUInt16BE(length, at)
      header.writeUInt16BE(offset, at + 2)
      offset += length
    })
  }
  if (offset > 0xffff) throw new Error('字体名称太长')
  name.data = Buffer.concat([header, ...strings, ...langTags])

  // Same tables in the same order, each 4-byte aligned, checksums and head's adjustment redone.
  head.data.writeUInt32BE(0, 8)
  const directory = Buffer.alloc(12 + numTables * 16)
  data.copy(directory, 0, 0, 12)
  const bodies: Buffer[] = []
  let at = directory.length
  tables.forEach((table, index) => {
    const record = 12 + index * 16
    directory.write(table.tag, record, 'latin1')
    directory.writeUInt32BE(checksum(table.data), record + 4)
    directory.writeUInt32BE(at, record + 8)
    directory.writeUInt32BE(table.data.length, record + 12)
    const padded = Buffer.alloc((table.data.length + 3) & ~3)
    table.data.copy(padded)
    bodies.push(padded)
    at += padded.length
  })
  const font = Buffer.concat([directory, ...bodies])
  const headAt = directory.readUInt32BE(12 + tables.indexOf(head) * 16 + 8)
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8)
  return font
}

export interface Windows10FontSources {
  /** The vault's private-fonts folder: a copy of each file, also where one can be put by hand. */
  folder: string
  /** Downloads a private file from the team server; undefined when not signed in. */
  download?: (name: Windows10FontAsset, target: string) => Promise<void>
}

async function asset(name: Windows10FontAsset, sources: Windows10FontSources, logger?: AppLogger): Promise<Buffer> {
  const expected = WINDOWS10_FONT_ASSETS.find((item) => item.name === name)!
  const kept = join(sources.folder, name)
  if (await exists(kept)) {
    const data = await readFile(kept)
    if (sha256(data) === expected.sha256) return data
    logger?.error('私有字体文件校验不对，重新下载', { name })
  }
  if (!sources.download) throw new Error(`没有 ${name}：请登录团队服务器，或把它放进 ${sources.folder}`)
  await mkdir(sources.folder, { recursive: true })
  const part = `${kept}.part`
  try {
    await sources.download(name, part)
    const data = await readFile(part)
    if (sha256(data) !== expected.sha256) throw new Error(`${name} 下载不完整，请重试`)
    await rename(part, kept)
    return data
  } finally {
    await rm(part, { force: true }).catch(() => undefined)
  }
}

/**
 * Installs Windows 10's Segoe UI Emoji, renamed, for the current user (the user's Fonts folder and
 * HKCU's Fonts key, as for language font packs). Does nothing when it is there already.
 */
export async function installWindows10Fonts(sources: Windows10FontSources, logger?: AppLogger): Promise<void> {
  if (await windows10FontsInstalled()) return
  const fonts = new Map<string, Buffer>([['seguiemj.ttf', await asset('seguiemj-win10.ttf', sources, logger)]])
  await mkdir(userFonts(), { recursive: true })
  for (const [file, data] of fonts) {
    const target = join(userFonts(), installedFile(file))
    const renamed = prismW10Font(data)
    await writeFile(target, renamed)
    await execFileAsync('reg.exe', ['add', USER_FONTS_KEY, '/v', fontRegistryName(renamed, installedFile(file)), '/t', 'REG_SZ', '/d', target, '/f'], { windowsHide: true })
  }
  logger?.info('Windows 10 字体已安装', { files: fonts.size })
}
