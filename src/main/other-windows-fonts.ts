import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { OtherWindows } from '../shared/hardware-profiles'
import type { AppLogger } from './app-logger'
import { fontRegistryName } from './language-fonts'

const execFileAsync = promisify(execFile)

/**
 * Fonts of the other Windows, shipped in the kernel package (`prism-fonts` next to chrome.exe; the
 * originals are in the private prism-kernel repo, private-assets/). A Windows 10 window on a
 * Windows 11 computer gets Windows 10's emoji; a Windows 11 window on a Windows 10 computer gets
 * Windows 11's emoji, Nirmala, MingLiU-ExtB, variable Sitka, Segoe Fluent Icons, Segoe UI Variable,
 * Sans Serif Collection and Cascadia. Fonts Windows itself has under the same names are installed
 * renamed ("PrismW10 …" / "PrismW11 …", which the kernel asks for first, patch 007); fonts it does
 * not have keep their names (their names are only shown to windows of the other Windows). A Windows 10
 * window on a Windows 10 computer gets Sans Serif Collection from the Windows 11 fonts ("win10host",
 * windows10HostFonts in hardware-profiles.ts).
 */
export const PRISM_FONTS_FOLDER = 'prism-fonts'

/** A set of fonts from the kernel package: the other Windows' or, on Windows 10, Windows 10's extras. */
export type PrismFontSet = OtherWindows | 'win10host'

interface FontFile { file: string; sha256: string; renamed: boolean }
const SANS_SERIF_COLLECTION: FontFile = { file: 'SansSerifCollection.ttf', sha256: 'eb78c210d380fce7d3822b3a5ccfa808f1eb0390de6237f5460970679f393ce0', renamed: false }
/** folder: the kernel package's folder under prism-fonts (the set's name when not given). */
const FONT_SETS: Record<PrismFontSet, { prefix: string; folder?: OtherWindows; files: FontFile[] }> = {
  // Segoe UI Emoji 1.29 of Windows 10 LTSC 21H2.
  win10: { prefix: 'PrismW10', files: [
    { file: 'seguiemj.ttf', sha256: '7c0244dd8eeb7c6bdecdfc3f9e59833527fc18a66d0295ce47339069692a2b4f', renamed: true }
  ] },
  // Windows 11 25H2 (private-assets/win11-fonts/SHA256-list.txt).
  win11: { prefix: 'PrismW11', files: [
    { file: 'seguiemj.ttf', sha256: '451df9bb5546055af625ff86aa72695df43e8e170b4c6c1316fe44e9c7a22f7c', renamed: true },
    { file: 'Nirmala.ttc', sha256: 'ad02cdfc06e144ac45f318e8e5a64cbe04c7479d4beb91d25f5a319a466b1767', renamed: true },
    { file: 'mingliub.ttc', sha256: '8f8afdb3ec7047118f6dc51b29d395e697ee6770d0afd0cd407457e2ad6e93cb', renamed: true },
    { file: 'SitkaVF.ttf', sha256: '9f71aabf76ccc757d25e18801d6a37e45cacc8b74c8b42a19e9f36ca99eef594', renamed: true },
    { file: 'SitkaVF-Italic.ttf', sha256: '74d4b98aabe85e16cb2fa6583c93f9f17642234d030a38462c36d1bcdde65928', renamed: true },
    { file: 'SegoeIcons.ttf', sha256: 'af496bd8ed18e8b45ea9c914bb3319204ab4fac450e0f4d3aab62bac6c02e5e9', renamed: false },
    { file: 'SegUIVar.ttf', sha256: '27ca1ab4bd5ad3b0404ee6a9a03b143408dbd7e5a4c9e4b2054639c03fc0f682', renamed: false },
    SANS_SERIF_COLLECTION,
    { file: 'CascadiaCode.ttf', sha256: 'cfb6a8d474018fe46d53a427e5fbee44b998822d0d3d8772914bd712cfc55ac4', renamed: false },
    { file: 'CascadiaMono.ttf', sha256: '0e141cb99609f6f10ad05313fd1807d5cc9e28658dcbb35ab162e52ff67dc718', renamed: false }
  ] },
  // Windows 10 computer, Windows 10 window: Sans Serif Collection, under its own name.
  win10host: { prefix: '', folder: 'win11', files: [SANS_SERIF_COLLECTION] }
}

const windowsFolder = () => process.env.WINDIR ?? 'C:\\Windows'
const userFonts = () => join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')
const USER_FONTS_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
const exists = (path: string) => access(path).then(() => true, () => false)
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const installedName = (set: PrismFontSet, font: FontFile) => font.renamed ? `${FONT_SETS[set].prefix}-${font.file}` : font.file

/** Whether this user (or Windows, for fonts kept under their own names) has the set's fonts. */
export async function otherWindowsFontsInstalled(set: PrismFontSet, folder = userFonts(), systemFolder = join(windowsFolder(), 'Fonts')): Promise<boolean> {
  for (const font of FONT_SETS[set].files) {
    const name = installedName(set, font)
    if (!await exists(join(folder, name)) && (font.renamed || !await exists(join(systemFolder, name)))) return false
  }
  return true
}

// name IDs: 1 family, 3 unique ID, 4 full name, 16 typographic family, 18 compatible full (Mac),
// 21 WWS family; 6 PostScript name, 20 PostScript CID findfont name, 25 variations PostScript prefix.
const SPACED_NAME_IDS = new Set([1, 3, 4, 16, 18, 21])
const POSTSCRIPT_NAME_IDS = new Set([6, 20, 25])

function checksum(data: Buffer): number {
  let sum = 0
  for (let at = 0; at < data.length; at += 4) {
    const word = Buffer.alloc(4)
    data.copy(word, 0, at, Math.min(at + 4, data.length))
    sum = (sum + word.readUInt32BE(0)) >>> 0
  }
  return sum
}

/** PostScript names of a variable font's named instances (fvar), which get the prefix too. */
function instancePostScriptIds(fvar: Buffer | undefined): Set<number> {
  const ids = new Set<number>()
  if (!fvar) return ids
  const axesOffset = fvar.readUInt16BE(4)
  const axisCount = fvar.readUInt16BE(8)
  const axisSize = fvar.readUInt16BE(10)
  const instanceCount = fvar.readUInt16BE(12)
  const instanceSize = fvar.readUInt16BE(14)
  if (instanceSize < axisCount * 4 + 6) return ids
  for (let index = 0; index < instanceCount; index++) {
    const id = fvar.readUInt16BE(axesOffset + axisCount * axisSize + index * instanceSize + 4 + axisCount * 4)
    if (id !== 0xffff && id !== 6) ids.add(id)
  }
  return ids
}

function renameNameTable(old: Buffer, prefix: string, extraPostScriptIds: Set<number>): Buffer {
  const format = old.readUInt16BE(0)
  const count = old.readUInt16BE(2)
  const storage = old.readUInt16BE(4)
  const strings: Buffer[] = []
  const records: number[][] = []
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 12
    const [platform, encoding, language, nameId, length, offset] = [0, 2, 4, 6, 8, 10].map((field) => old.readUInt16BE(at + field))
    let text = old.subarray(storage + offset, storage + offset + length)
    const add = SPACED_NAME_IDS.has(nameId) ? `${prefix} ` : POSTSCRIPT_NAME_IDS.has(nameId) || extraPostScriptIds.has(nameId) ? prefix : ''
    if (add) text = Buffer.concat([platform === 1 ? Buffer.from(add, 'latin1') : Buffer.from(add, 'utf16le').swap16(), text])
    records.push([platform, encoding, language, nameId, text.length])
    strings.push(Buffer.from(text))
  }
  const langTags: Buffer[] = []
  if (format === 1) {
    const tagCount = old.readUInt16BE(6 + count * 12)
    for (let index = 0; index < tagCount; index++) {
      const at = 6 + count * 12 + 2 + index * 4
      langTags.push(Buffer.from(old.subarray(storage + old.readUInt16BE(at + 2), storage + old.readUInt16BE(at + 2) + old.readUInt16BE(at))))
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
    langTags.forEach((tag, index) => {
      const at = 6 + count * 12 + 2 + index * 4
      header.writeUInt16BE(tag.length, at)
      header.writeUInt16BE(offset, at + 2)
      offset += tag.length
    })
  }
  if (offset > 0xffff) throw new Error('字体名称太长')
  return Buffer.concat([header, ...strings, ...langTags])
}

/**
 * The font (or every face of a .ttc collection) with `prefix` before its family, full, unique and
 * PostScript names, named instances' PostScript names included; glyphs and layout untouched.
 */
export function prefixedFont(data: Buffer, prefix: string): Buffer {
  const collection = data.toString('latin1', 0, 4) === 'ttcf'
  const faceOffsets = collection ? Array.from({ length: data.readUInt32BE(8) }, (_, index) => data.readUInt32BE(12 + index * 4)) : [0]
  // Tables by their place in the file: faces of a collection may share them.
  const tables = new Map<string, Buffer>()
  const faces = faceOffsets.map((face) => {
    const entries = Array.from({ length: data.readUInt16BE(face + 4) }, (_, index) => {
      const record = face + 12 + index * 16
      const tag = data.toString('latin1', record, record + 4)
      const offset = data.readUInt32BE(record + 8)
      const length = data.readUInt32BE(record + 12)
      const key = `${offset}:${length}`
      if (!tables.has(key)) tables.set(key, Buffer.from(data.subarray(offset, offset + length)))
      return { tag, key }
    })
    return { sfntVersion: data.readUInt32BE(face), header: Buffer.from(data.subarray(face + 4, face + 12)), entries }
  })
  for (const face of faces) {
    const name = face.entries.find((entry) => entry.tag === 'name')
    const head = face.entries.find((entry) => entry.tag === 'head')
    if (!name || !head) throw new Error('不是字体文件')
    const fvar = face.entries.find((entry) => entry.tag === 'fvar')
    const renamedKey = `${name.key}:renamed`
    if (!tables.has(renamedKey)) tables.set(renamedKey, renameNameTable(tables.get(name.key)!, prefix, instancePostScriptIds(fvar && tables.get(fvar.key))))
    name.key = renamedKey
    tables.get(head.key)!.writeUInt32BE(0, 8)
  }
  // Collection header, each face's table directory, then every table once, 4-byte aligned.
  const headerLength = collection ? 12 + faces.length * 4 : 0
  const directoryLengths = faces.map((face) => 12 + face.entries.length * 16)
  let at = headerLength + directoryLengths.reduce((sum, length) => sum + length, 0)
  const placed = new Map<string, number>()
  const bodies: Buffer[] = []
  for (const face of faces) {
    for (const entry of face.entries) {
      if (placed.has(entry.key)) continue
      const table = tables.get(entry.key)!
      placed.set(entry.key, at)
      const padded = Buffer.alloc((table.length + 3) & ~3)
      table.copy(padded)
      bodies.push(padded)
      at += padded.length
    }
  }
  const header = Buffer.alloc(headerLength)
  if (collection) {
    header.write('ttcf', 0, 'latin1')
    header.writeUInt32BE(0x00010000, 4)
    header.writeUInt32BE(faces.length, 8)
  }
  let directoryAt = headerLength
  const directories = faces.map((face, index) => {
    if (collection) header.writeUInt32BE(directoryAt, 12 + index * 4)
    directoryAt += directoryLengths[index]
    const directory = Buffer.alloc(directoryLengths[index])
    directory.writeUInt32BE(face.sfntVersion, 0)
    face.header.copy(directory, 4)
    face.entries.forEach((entry, entryIndex) => {
      const record = 12 + entryIndex * 16
      const table = tables.get(entry.key)!
      directory.write(entry.tag, record, 'latin1')
      directory.writeUInt32BE(checksum(table), record + 4)
      directory.writeUInt32BE(placed.get(entry.key)!, record + 8)
      directory.writeUInt32BE(table.length, record + 12)
    })
    return directory
  })
  const font = Buffer.concat([header, ...directories, ...bodies])
  if (!collection) {
    // head's checkSumAdjustment makes a single font add up to 0xB1B0AFBA (ignored in collections).
    const headAt = placed.get(faces[0].entries.find((entry) => entry.tag === 'head')!.key)!
    font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8)
  }
  return font
}

/** The kernel package's font folder for this set, next to chrome.exe. */
export function kernelFontsFolder(executable: string, set: PrismFontSet): string {
  return join(dirname(executable), PRISM_FONTS_FOLDER, FONT_SETS[set].folder ?? set)
}

/**
 * Installs the set's fonts from the kernel package for the current user (the user's Fonts folder
 * and HKCU's Fonts key, as for language font packs). Each file is checked against its SHA-256;
 * fonts already there are left alone.
 */
export async function installOtherWindowsFonts(set: PrismFontSet, kernelExecutable: string, logger?: AppLogger): Promise<void> {
  if (await otherWindowsFontsInstalled(set)) return
  const source = kernelFontsFolder(kernelExecutable, set)
  if (!await exists(source)) throw new Error('这个内核没有附带 Windows 字体（prism13 起附带）')
  await mkdir(userFonts(), { recursive: true })
  let installed = 0
  for (const font of FONT_SETS[set].files) {
    const name = installedName(set, font)
    const target = join(userFonts(), name)
    if (await exists(target) || (!font.renamed && await exists(join(windowsFolder(), 'Fonts', name)))) continue
    const data = await readFile(join(source, font.file))
    if (sha256(data) !== font.sha256) throw new Error(`内核附带的字体 ${font.file} 校验不对`)
    const output = font.renamed ? prefixedFont(data, FONT_SETS[set].prefix) : data
    await writeFile(target, output)
    await execFileAsync('reg.exe', ['add', USER_FONTS_KEY, '/v', fontRegistryName(output, name), '/t', 'REG_SZ', '/d', target, '/f'], { windowsHide: true })
    installed++
  }
  logger?.info('已安装另一版 Windows 的字体', { set, files: installed })
}
