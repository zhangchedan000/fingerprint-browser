import { describe, expect, it } from 'vitest'
import { WINDOWS_FONT_PACKS, windowsFontScript } from '../shared/windows-font-packs'
import { fontRegistryName } from './language-fonts'

/** An sfnt with only a name table holding these full names (name id 4) as Windows UTF-16BE records. */
function face(names: string[]): Buffer {
  const strings = names.map((name) => Buffer.from(name, 'utf16le').swap16())
  const records = Buffer.alloc(6 + names.length * 12)
  records.writeUInt16BE(names.length, 2)
  records.writeUInt16BE(records.length, 4)
  let offset = 0
  strings.forEach((text, index) => {
    const at = 6 + index * 12
    ;[3, 1, index === 0 ? 0x412 : 0x409, 4, text.length, offset].forEach((value, field) => records.writeUInt16BE(value, at + field * 2))
    offset += text.length
  })
  const table = Buffer.concat([records, ...strings])
  const header = Buffer.alloc(12 + 16)
  header.writeUInt32BE(0x00010000, 0)
  header.writeUInt16BE(1, 4)
  header.write('name', 12, 'latin1')
  header.writeUInt32BE(header.length, 20)
  header.writeUInt32BE(table.length, 24)
  return Buffer.concat([header, table])
}

function collection(faces: Buffer[]): Buffer {
  const header = Buffer.alloc(12 + faces.length * 4)
  header.write('ttcf', 0, 'latin1')
  header.writeUInt32BE(faces.length, 8)
  const parts: Buffer[] = [header]
  let at = header.length
  faces.forEach((data, index) => {
    // Table offsets in a collection count from the start of the file.
    const shifted = Buffer.from(data)
    shifted.writeUInt32BE(shifted.readUInt32BE(20) + at, 20)
    header.writeUInt32BE(at, 12 + index * 4)
    parts.push(shifted)
    at += shifted.length
  })
  return Buffer.concat(parts)
}

describe('language font packages', () => {
  it('names a font the way the Windows Fonts key does, in English', () => {
    expect(fontRegistryName(face(['바탕', 'Batang']), 'batang.ttf')).toBe('Batang (TrueType)')
    expect(fontRegistryName(collection([face(['바탕', 'Batang']), face(['바탕체', 'BatangChe'])]), 'batang.ttc'))
      .toBe('Batang & BatangChe (TrueType)')
    expect(fontRegistryName(face([]), 'nyala.ttf')).toBe('nyala.ttf (TrueType)')
  })

  it('has a package for every script a window language adds', () => {
    const scripts = new Set(WINDOWS_FONT_PACKS.map((pack) => pack.script))
    for (const language of ['zh-CN', 'zh-TW', 'ja', 'ko', 'th', 'ar', 'he', 'hi', 'bn', 'gu', 'pa', 'kn', 'ml', 'or', 'ta', 'te', 'si', 'km', 'lo', 'am', 'syr', 'chr', 'iu']) {
      expect(scripts.has(windowsFontScript(language)!)).toBe(true)
    }
    expect(windowsFontScript('es-419')).toBeUndefined()
  })
})
