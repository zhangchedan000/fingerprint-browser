import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fontRegistryName } from './language-fonts'
import { otherWindowsFontsInstalled, prefixedFont } from './other-windows-fonts'

/** A two-table font (head, name) with Windows (UTF-16BE) and Mac (Roman) name records. */
function tinyFont(names: Array<[platform: number, nameId: number, text: string]>): Buffer {
  const strings = names.map(([platform, , text]) => platform === 1 ? Buffer.from(text, 'latin1') : Buffer.from(text, 'utf16le').swap16())
  const name = Buffer.alloc(6 + names.length * 12)
  name.writeUInt16BE(names.length, 2)
  name.writeUInt16BE(name.length, 4)
  let offset = 0
  names.forEach(([platform, nameId], index) => {
    const at = 6 + index * 12
    name.writeUInt16BE(platform, at)
    name.writeUInt16BE(platform === 1 ? 0 : 1, at + 2)
    name.writeUInt16BE(platform === 1 ? 0 : 0x409, at + 4)
    name.writeUInt16BE(nameId, at + 6)
    name.writeUInt16BE(strings[index].length, at + 8)
    name.writeUInt16BE(offset, at + 10)
    offset += strings[index].length
  })
  const nameTable = Buffer.concat([name, ...strings])
  const head = Buffer.alloc(54)
  head.writeUInt32BE(0x00010000, 0)
  head.writeUInt32BE(0x5f0f3cf5, 12)
  head.writeUInt16BE(2048, 18)
  const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc(((data.length + 3) & ~3) - data.length)])
  const directory = Buffer.alloc(12 + 2 * 16)
  directory.writeUInt32BE(0x00010000, 0)
  directory.writeUInt16BE(2, 4)
  let at = directory.length
  ;[['head', head], ['name', nameTable]].forEach(([tag, data], index) => {
    directory.write(tag as string, 12 + index * 16, 'latin1')
    directory.writeUInt32BE(at, 12 + index * 16 + 8)
    directory.writeUInt32BE((data as Buffer).length, 12 + index * 16 + 12)
    at += pad(data as Buffer).length
  })
  return Buffer.concat([directory, pad(head), pad(nameTable)])
}

function readNames(font: Buffer, face = 0): string[] {
  const record = face + 12 + 16
  const table = font.readUInt32BE(record + 8)
  const count = font.readUInt16BE(table + 2)
  const storage = table + font.readUInt16BE(table + 4)
  return Array.from({ length: count }, (_, index) => {
    const at = table + 6 + index * 12
    const raw = font.subarray(storage + font.readUInt16BE(at + 10), storage + font.readUInt16BE(at + 10) + font.readUInt16BE(at + 8))
    const text = font.readUInt16BE(at) === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le')
    return `${font.readUInt16BE(at + 6)}:${text}`
  })
}

function wholeChecksum(font: Buffer): number {
  let sum = 0
  for (let at = 0; at < font.length; at += 4) sum = (sum + font.readUInt32BE(at)) >>> 0
  return sum
}


/** A .ttc of the given fonts (each copied whole, so no tables are shared). */
function collection(fonts: Buffer[]): Buffer {
  const header = Buffer.alloc(12 + fonts.length * 4)
  header.write('ttcf', 0, 'latin1')
  header.writeUInt32BE(0x00010000, 4)
  header.writeUInt32BE(fonts.length, 8)
  let at = header.length
  const parts = fonts.map((font, index) => {
    header.writeUInt32BE(at, 12 + index * 4)
    const copy = Buffer.from(font)
    for (let table = 0; table < copy.readUInt16BE(4); table++) copy.writeUInt32BE(copy.readUInt32BE(12 + table * 16 + 8) + at, 12 + table * 16 + 8)
    at += copy.length
    return copy
  })
  return Buffer.concat([header, ...parts])
}

describe('fonts of the other Windows', () => {
  it('puts the prefix before family, full, unique and PostScript names, and nothing else', () => {
    const font = prefixedFont(tinyFont([
      [3, 1, 'Segoe UI Emoji'], [3, 2, 'Regular'], [3, 3, 'Segoe UI Emoji'], [3, 4, 'Segoe UI Emoji'], [3, 5, 'Version 1.29'],
      [3, 6, 'SegoeUIEmoji'], [1, 4, 'Segoe UI Emoji'], [3, 16, 'Segoe UI Emoji']
    ]), 'PrismW10')
    expect(readNames(font)).toEqual([
      '1:PrismW10 Segoe UI Emoji', '2:Regular', '3:PrismW10 Segoe UI Emoji', '4:PrismW10 Segoe UI Emoji', '5:Version 1.29',
      '6:PrismW10SegoeUIEmoji', '4:PrismW10 Segoe UI Emoji', '16:PrismW10 Segoe UI Emoji'
    ])
    // head's checkSumAdjustment makes the whole file add up as the format wants.
    expect(wholeChecksum(font)).toBe(0xb1b0afba)
    // Windows files it under its new full name.
    expect(fontRegistryName(font, 'x')).toBe('PrismW10 Segoe UI Emoji (TrueType)')
  })

  it('renames every face of a collection', () => {
    const ttc = prefixedFont(collection([
      tinyFont([[3, 1, 'Nirmala UI'], [3, 4, 'Nirmala UI'], [3, 6, 'NirmalaUI']]),
      tinyFont([[3, 1, 'Nirmala Text'], [3, 4, 'Nirmala Text Bold'], [3, 6, 'NirmalaText-Bold']])
    ]), 'PrismW11')
    expect(ttc.toString('latin1', 0, 4)).toBe('ttcf')
    const faces = [ttc.readUInt32BE(12), ttc.readUInt32BE(16)]
    expect(readNames(ttc, faces[0])).toEqual(['1:PrismW11 Nirmala UI', '4:PrismW11 Nirmala UI', '6:PrismW11NirmalaUI'])
    expect(readNames(ttc, faces[1])).toEqual(['1:PrismW11 Nirmala Text', '4:PrismW11 Nirmala Text Bold', '6:PrismW11NirmalaText-Bold'])
    expect(fontRegistryName(ttc, 'x')).toBe('PrismW11 Nirmala UI & PrismW11 Nirmala Text Bold (TrueType)')
  })

  it('counts a set as installed when every font is there, renamed ones in the user folder', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'other-fonts-'))
    const system = await mkdtemp(join(tmpdir(), 'other-fonts-system-'))
    try {
      expect(await otherWindowsFontsInstalled('win10', folder, system)).toBe(false)
      await writeFile(join(folder, 'PrismW10-seguiemj.ttf'), '')
      expect(await otherWindowsFontsInstalled('win10', folder, system)).toBe(true)
      for (const file of ['seguiemj.ttf', 'Nirmala.ttc', 'mingliub.ttc', 'SitkaVF.ttf', 'SitkaVF-Italic.ttf']) await writeFile(join(folder, `PrismW11-${file}`), '')
      for (const file of ['SegoeIcons.ttf', 'SegUIVar.ttf', 'SansSerifCollection.ttf', 'CascadiaCode.ttf']) await writeFile(join(folder, file), '')
      expect(await otherWindowsFontsInstalled('win11', folder, system)).toBe(false)
      // A font kept under its own name may be Windows' own (or installed by another program).
      await writeFile(join(system, 'CascadiaMono.ttf'), '')
      expect(await otherWindowsFontsInstalled('win11', folder, system)).toBe(true)
    } finally {
      await rm(folder, { recursive: true, force: true })
      await rm(system, { recursive: true, force: true })
    }
  })
})
