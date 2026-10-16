import { describe, expect, it } from 'vitest'
import {
  analyzeBatchTable, batchTemplateRows, decodeText, errorRows, normalizeHeader, parseCsv, parseDelimitedText,
  readImportTable, serializeCsv, serializeXlsx
} from './profile-batch-import'

const COOKIE = JSON.stringify([{ name: 'sid', value: '1', domain: '.example.com', path: '/' }])

describe('batch import', () => {
  it('maps Chinese, traditional and English headers to columns', () => {
    expect(normalizeHeader(' 窗口名称* ')).toBe('name')
    expect(normalizeHeader('窗口名稱（必填）')).toBe('name')
    expect(normalizeHeader('平台帳號')).toBe('account_username')
    expect(normalizeHeader('Cookie')).toBe('cookie')
    expect(normalizeHeader('proxy_host')).toBe('proxy_host')
    expect(normalizeHeader('序号')).toBeUndefined()
  })

  it('checks every row on its own and keeps the good ones', () => {
    const table = analyzeBatchTable([
      ['窗口名称', '分组', '代理', '平台', '平台账号', '平台密码', 'Cookie', '备注'],
      ['# 示例', '', '', '', '', '', '', ''],
      ['TK-06', 'TikTok 美区', '203.0.113.31:1080:u1:secret', 'TikTok', 'shop06@example.com', 'pw', COOKIE, ''],
      ['TK-08', '', 'socks5://u1:secret@203.0.113.33:1080', '', '', '', '', ''],
      ['', 'TikTok 美区', '203.0.113.35', '', '', '', '', ''],
      ['TK-10', 'TikTok 美区', '直连', '', '', '', '[bad', ''],
      ['TK-11', '', '', '', '', '', '', '']
    ])
    expect(table.rows.map((row) => row.line)).toEqual([3, 4, 5, 6, 7])
    const [first, second, missing, badCookie, direct] = table.rows
    expect(first.draft).toMatchObject({
      name: 'TK-06', group: 'TikTok 美区',
      proxy: { protocol: 'http', host: '203.0.113.31', port: 1080, username: 'u1', password: 'secret' },
      account: { platform: 'TikTok', username: 'shop06@example.com', password: 'pw' },
      startUrls: ['https://www.tiktok.com/login']
    })
    expect(first.cookieText).toBe(COOKIE)
    expect(first.view).toMatchObject({ line: 3, proxy: 'http://u1:***@203.0.113.31:1080', account: 'TikTok · shop06@example.com', cookie: true, errors: [] })
    expect(JSON.stringify(first.view)).not.toContain('secret')
    expect(second.draft?.proxy.protocol).toBe('socks5')
    expect(missing.draft).toBeUndefined()
    expect(missing.errors).toHaveLength(2)
    expect(missing.errors[0]).toBe('缺少窗口名称')
    expect(badCookie.draft).toBeUndefined()
    expect(badCookie.errors).toEqual(['Cookie 文件不是有效的 JSON'])
    expect(direct.draft?.proxy).toMatchObject({ protocol: 'direct', host: '' })
    expect(direct.draft?.startUrls).toEqual([])
    // Every window gets its own fingerprint.
    expect(new Set(table.rows.filter((row) => row.draft).map((row) => row.draft!.fingerprint.seed)).size).toBe(3)
  })

  it('still reads the full English column set', () => {
    const [row] = analyzeBatchTable([
      ['name', 'proxy_protocol', 'proxy_host', 'proxy_port', 'platform', 'hardware_concurrency', 'window_x'],
      ['A', 'socks5', 'proxy.example.com', '1080', 'macos', '8', '-20']
    ]).rows
    expect(row.errors).toEqual([])
    expect(row.draft).toMatchObject({ proxy: { protocol: 'socks5', host: 'proxy.example.com', port: 1080 }, window: { x: -20 } })
    expect(row.draft?.fingerprint.platform).toBe('macos')
    const [bad] = analyzeBatchTable([['name', 'proxy_port', 'proxy_host'], ['B', '80x', 'h.example.com']]).rows
    expect(bad.errors).toEqual(['proxy_port 必须是整数'])
    const [both] = analyzeBatchTable([['name', 'proxy', 'proxy_host'], ['C', 'h:1', 'h.example.com']]).rows
    expect(both.errors).toEqual(['代理和 proxy_host 只能填写一个'])
  })

  it('rejects files it cannot use as a whole', () => {
    expect(() => analyzeBatchTable([])).toThrow('没有内容')
    expect(() => analyzeBatchTable([['分组'], ['x']])).toThrow('窗口名称')
    expect(() => analyzeBatchTable([['窗口名称', '序号'], ['a', '1']])).toThrow('序号')
    expect(() => analyzeBatchTable([['name', '窗口名称'], ['a', 'b']])).toThrow('重复')
    expect(() => analyzeBatchTable([['name'], ['# only example']])).toThrow('没有可导入')
    expect(() => analyzeBatchTable([['name'], ...Array.from({ length: 1001 }, (_, i) => [`w${i}`])])).toThrow('1000')
  })

  it('writes the failing rows back with a reason column', () => {
    const table = analyzeBatchTable([['窗口名称', '代理'], ['ok', ''], ['', 'h:1']])
    const rows = errorRows(table)
    expect(rows).toHaveLength(2)
    expect(rows[1].slice(0, 2)).toEqual(['', 'h:1'])
    expect(rows[1][2]).toContain('缺少窗口名称')
    expect(serializeCsv([['a', 'b,c'], ['"q"', '']])).toBe('﻿a,"b,c"\r\n"""q""",\r\n')
  })

  it('decodes GB18030 text and tab-separated txt files', () => {
    const gbk = Uint8Array.from([0xb4, 0xb0, 0xbf, 0xda]) // 窗口 in GBK
    expect(decodeText(gbk)).toBe('窗口')
    expect(decodeText(new TextEncoder().encode('﻿名称'))).toBe('名称')
    expect(parseDelimitedText('name\tproxy\r\nA\th:1\r\n')).toEqual([['name', 'proxy'], ['A', 'h:1'], ['']])
    expect(parseCsv('name\nA "x"\n')).toEqual([['name'], ['A "x"']])
  })

  it('round-trips the template through xlsx', async () => {
    const template = batchTemplateRows()
    const bytes = await serializeXlsx(template)
    const table = await readImportTable('template.xlsx', bytes)
    expect(table[0]).toEqual(template[0])
    expect(() => analyzeBatchTable(table)).toThrow('没有可导入')
    const filled = await serializeXlsx([template[0], ['W1', '', '203.0.113.9:8080', '', '', '', '', '', '']])
    const [row] = analyzeBatchTable(await readImportTable('w.xlsx', filled)).rows
    expect(row.draft?.proxy).toMatchObject({ host: '203.0.113.9', port: 8080 })
    await expect(readImportTable('w.xlsx', new TextEncoder().encode('not a zip'))).rejects.toThrow('Excel')
    await expect(readImportTable('w.json', new Uint8Array())).rejects.toThrow('.xlsx')
  })
})
