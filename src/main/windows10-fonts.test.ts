import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fontRegistryName } from './language-fonts'
import { prismW10Font, windows10FontsInstalled } from './windows10-fonts'

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

function readNames(font: Buffer): string[] {
  const record = 12 + 16
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

describe('Windows 10 fonts', () => {
  it('puts PrismW10 before family, full, unique and PostScript names, and nothing else', () => {
    const font = prismW10Font(tinyFont([
      [3, 1, 'Segoe UI'], [3, 2, 'Bold'], [3, 3, 'Segoe UI Bold'], [3, 4, 'Segoe UI Bold'], [3, 5, 'Version 5.62'],
      [3, 6, 'SegoeUI-Bold'], [1, 4, 'Segoe UI Bold'], [3, 16, 'Segoe UI']
    ]))
    expect(readNames(font)).toEqual([
      '1:PrismW10 Segoe UI', '2:Bold', '3:PrismW10 Segoe UI Bold', '4:PrismW10 Segoe UI Bold', '5:Version 5.62',
      '6:PrismW10SegoeUI-Bold', '4:PrismW10 Segoe UI Bold', '16:PrismW10 Segoe UI'
    ])
    // head's checkSumAdjustment makes the whole file add up as the format wants.
    expect(wholeChecksum(font)).toBe(0xb1b0afba)
    // Windows files it under its new full name.
    expect(fontRegistryName(font, 'x')).toBe('PrismW10 Segoe UI Bold (TrueType)')
  })

  it('counts as installed with the renamed emoji font', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'w10-fonts-'))
    try {
      expect(await windows10FontsInstalled(folder)).toBe(false)
      await writeFile(join(folder, 'PrismW10-seguiemj.ttf'), '')
      expect(await windows10FontsInstalled(folder)).toBe(true)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
