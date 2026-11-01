import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WINDOWS_FONT_PACKS, windowsFontScript } from '../shared/windows-font-packs'
import { fontRegistryName, installKernelFontPack } from './language-fonts'

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

  it('leaves a package the prism16 kernel already has (in its own folder) and downloads nothing', async () => {
    const kernel = await mkdtemp(join(tmpdir(), 'kernel-fonts-'))
    try {
      const pack = WINDOWS_FONT_PACKS.find((p) => p.script === 'Hans')!
      const folder = join(kernel, 'prism-system-fonts', 'win11', 'Hans')
      await mkdir(folder, { recursive: true })
      for (const font of pack.fonts) await writeFile(join(folder, font), '')
      let fetched = 0
      await installKernelFontPack('Hans', join(kernel, 'chrome.exe'), 'win11', (async () => { fetched++; throw new Error('no network') }) as unknown as typeof fetch, () => undefined)
      expect(fetched).toBe(0)
      // A missing package is fetched (from Microsoft); here the fake network fails.
      await expect(installKernelFontPack('Thai', join(kernel, 'chrome.exe'), 'win11', (async () => { fetched++; throw new Error('no network') }) as unknown as typeof fetch, () => undefined)).rejects.toThrow('no network')
      expect(fetched).toBe(1)
      // A file the base fonts have (MS Gothic) is not wanted twice: the Japanese package is whole without it.
      const jpan = WINDOWS_FONT_PACKS.find((p) => p.script === 'Jpan')!
      await mkdir(join(kernel, 'prism-system-fonts', 'win11', 'base'), { recursive: true })
      await writeFile(join(kernel, 'prism-system-fonts', 'win11', 'base', 'msgothic.ttc'), '')
      await mkdir(join(kernel, 'prism-system-fonts', 'win11', 'Jpan'), { recursive: true })
      for (const font of jpan.fonts) if (font !== 'msgothic.ttc') await writeFile(join(kernel, 'prism-system-fonts', 'win11', 'Jpan', font), '')
      await installKernelFontPack('Jpan', join(kernel, 'chrome.exe'), 'win11', (async () => { fetched++; throw new Error('no network') }) as unknown as typeof fetch, () => undefined)
      expect(fetched).toBe(1)
    } finally {
      await rm(kernel, { recursive: true, force: true })
    }
  })
})
