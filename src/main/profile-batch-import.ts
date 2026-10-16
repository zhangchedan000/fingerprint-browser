import { defaultProfileDraft } from '../shared/defaults'
import { refreshSeededGpuIdentity } from '../shared/hardware-profiles'
import { getLocale, joinMessages, t, translateMessage } from '../shared/i18n'
import { platformStartUrl } from '../shared/platforms'
import { parsePastedProxy } from '../shared/proxy-paste'
import type { BatchImportRowView, BrowserBrand, BrowserPlatform, ProfileDraft, ProxyConfig, ProxyProtocol, WebRtcPolicy } from '../shared/types'
import { validateProfileDraft } from '../shared/validation'
import { parseCookieFile } from './cookie-file'

/** Every column the importer understands. The simple template uses only a few of them. */
export const BATCH_IMPORT_COLUMNS = [
  'name', 'group', 'tags', 'note', 'start_urls', 'kernel_version', 'color',
  'proxy', 'proxy_protocol', 'proxy_host', 'proxy_port', 'proxy_username', 'proxy_password',
  'account_platform', 'account_username', 'account_password', 'cookie',
  'fingerprint_seed', 'platform', 'platform_version', 'brand', 'brand_version', 'hardware_concurrency',
  'language', 'accept_languages', 'timezone', 'screen_width', 'screen_height',
  'window_mode', 'window_x', 'window_y', 'window_width', 'window_height',
  'webrtc_policy', 'disabled_spoofing'
] as const
export type BatchImportColumn = typeof BATCH_IMPORT_COLUMNS[number]

/** Columns of the downloadable template, in order. */
export const TEMPLATE_COLUMNS: readonly BatchImportColumn[] = [
  'name', 'group', 'proxy', 'account_platform', 'account_username', 'account_password', 'cookie', 'note', 'start_urls'
]

const TEMPLATE_LABELS: Partial<Record<BatchImportColumn, { 'zh-CN': string; 'zh-TW': string }>> = {
  name: { 'zh-CN': '窗口名称', 'zh-TW': '窗口名稱' },
  group: { 'zh-CN': '分组', 'zh-TW': '分組' },
  proxy: { 'zh-CN': '代理', 'zh-TW': '代理' },
  account_platform: { 'zh-CN': '平台', 'zh-TW': '平台' },
  account_username: { 'zh-CN': '平台账号', 'zh-TW': '平台帳號' },
  account_password: { 'zh-CN': '平台密码', 'zh-TW': '平台密碼' },
  cookie: { 'zh-CN': 'Cookie', 'zh-TW': 'Cookie' },
  note: { 'zh-CN': '备注', 'zh-TW': '備註' },
  start_urls: { 'zh-CN': '打开网址', 'zh-TW': '開啟網址' }
}

/** Header names people actually type, mapped to columns. Compared after trimming and lowercasing. */
const HEADER_ALIASES: Record<string, BatchImportColumn> = {
  窗口名称: 'name', 窗口名稱: 'name', 名称: 'name', 名稱: 'name', 窗口: 'name',
  分组: 'group', 分組: 'group',
  标签: 'tags', 標籤: 'tags',
  备注: 'note', 備註: 'note',
  打开网址: 'start_urls', 開啟網址: 'start_urls', 启动网址: 'start_urls', 啟動網址: 'start_urls', 网址: 'start_urls', 網址: 'start_urls',
  内核: 'kernel_version', 內核: 'kernel_version', 内核版本: 'kernel_version', 內核版本: 'kernel_version',
  代理: 'proxy', 代理ip: 'proxy', 代理类型: 'proxy_protocol', 代理類型: 'proxy_protocol',
  平台: 'account_platform',
  平台账号: 'account_username', 平台帳號: 'account_username', 账号: 'account_username', 帳號: 'account_username',
  平台密码: 'account_password', 平台密碼: 'account_password', 密码: 'account_password', 密碼: 'account_password',
  cookies: 'cookie',
  操作系统: 'platform', 作業系統: 'platform', 系统: 'platform', 系統: 'platform',
  时区: 'timezone', 時區: 'timezone', 语言: 'language', 語言: 'language'
}

export const MAX_IMPORT_ROWS = 1000
const MAX_CELL_LENGTH = 1_000_000
const DIRECT_WORDS = new Set(['', 'direct', '直连', '直連', '无', '無', 'none'])

export function normalizeHeader(raw: string): BatchImportColumn | undefined {
  const key = raw.trim().replace(/[*＊]|[（(]\s*必填\s*[)）]/g, '').trim().toLowerCase()
  if ((BATCH_IMPORT_COLUMNS as readonly string[]).includes(key)) return key as BatchImportColumn
  return HEADER_ALIASES[key]
}

/** Text files from Excel on Chinese Windows are often GB18030 rather than UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('gb18030').decode(bytes)
  }
  return text.replace(/^﻿/, '')
}

export function parseCsv(raw: string): string[][] {
  const input = raw.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let afterQuote = false
  const pushCell = (): void => {
    if (cell.length > MAX_CELL_LENGTH) throw new Error('单元格内容过长')
    row.push(cell)
    cell = ''
    afterQuote = false
  }
  const pushRow = (): void => {
    pushCell()
    rows.push(row)
    row = []
  }
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
        afterQuote = true
      } else cell += char
      continue
    }
    if (afterQuote) {
      if (char === ',') pushCell()
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && input[index + 1] === '\n') index += 1
        pushRow()
      } else if (char !== ' ' && char !== '\t') throw new Error('CSV 引号字段结束后存在无效字符')
      continue
    }
    if (char === '"' && !cell.length) quoted = true
    else if (char === ',') pushCell()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index += 1
      pushRow()
    } else cell += char
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号字段')
  if (cell.length || row.length) pushRow()
  return rows
}

/** A .txt file is tab-separated when its first line has a tab, otherwise read as CSV. */
export function parseDelimitedText(raw: string): string[][] {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) ?? ''
  if (!firstLine.includes('\t')) return parseCsv(raw)
  return raw.replace(/^﻿/, '').split(/\r?\n/).map((line) => line.split('\t'))
}

export type ImportFileFormat = 'xlsx' | 'csv' | 'txt'

export function importFormat(fileName: string): ImportFileFormat {
  const extension = fileName.toLowerCase().split('.').pop()
  if (extension === 'xlsx' || extension === 'csv' || extension === 'txt') return extension
  throw new Error('只支持 .xlsx、.csv 或 .txt 文件')
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export async function readImportTable(fileName: string, bytes: Uint8Array): Promise<string[][]> {
  const format = importFormat(fileName)
  if (format === 'xlsx') {
    const { readSheet } = await import('read-excel-file/node')
    let sheet: unknown[][]
    try {
      sheet = await readSheet(Buffer.from(bytes))
    } catch {
      throw new Error('无法读取 Excel 文件，请确认它是 .xlsx 格式')
    }
    return sheet.map((row) => row.map(cellText))
  }
  if (bytes.includes(0)) throw new Error('文件包含无效的空字符')
  const text = decodeText(bytes)
  return format === 'txt' ? parseDelimitedText(text) : parseCsv(text)
}

export interface AnalyzedRow {
  /** 1-based row number in the spreadsheet, so people can find the row. */
  line: number
  cells: string[]
  draft?: ProfileDraft
  cookieText: string
  errors: string[]
  view: BatchImportRowView
}

export interface AnalyzedTable {
  headers: string[]
  rows: AnalyzedRow[]
}

function integer(value: string, column: string, errors: string[], signed = false): number | undefined {
  const text = value.trim()
  if (!text) return undefined
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(text)) {
    errors.push(`${column} 必须是整数`)
    return undefined
  }
  return Number(text)
}

function splitPipe(value: string): string[] {
  return value.split(/[|\n]/).map((item) => item.trim()).filter(Boolean)
}

function maskedProxy(proxy: ProxyConfig): string {
  if (proxy.protocol === 'direct') return ''
  const credentials = proxy.username ? `${proxy.username}:***@` : ''
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  return `${proxy.protocol}://${credentials}${host}:${proxy.port ?? ''}`
}

/** Hides whatever follows the third colon of host:port:user:pass in text that failed to parse. */
function maskedRaw(value: string): string {
  const text = value.trim().slice(0, 120)
  const url = text.replace(/(\/\/[^:/@]+:)[^@]*@/, '$1***@')
  if (url !== text) return url
  const parts = text.split(':')
  return parts.length >= 4 ? `${parts.slice(0, 3).join(':')}:***` : text
}

function rowProxy(values: Record<BatchImportColumn, string>, errors: string[]): ProxyConfig | undefined {
  const pasted = values.proxy.trim()
  const protocolText = values.proxy_protocol.trim().toLowerCase()
  if (protocolText && !['direct', 'http', 'https', 'socks5'].includes(protocolText)) {
    errors.push('代理类型只能是 http、https、socks5 或 direct')
    return undefined
  }
  if (pasted && values.proxy_host.trim()) {
    errors.push('代理和 proxy_host 只能填写一个')
    return undefined
  }
  if (pasted || !values.proxy_host.trim()) {
    if (DIRECT_WORDS.has(pasted.toLowerCase())) return { protocol: 'direct', host: '', port: undefined, username: '', password: '' }
    try {
      const parsed = parsePastedProxy(pasted)
      const protocol = parsed.protocol ?? ((protocolText && protocolText !== 'direct' ? protocolText : 'http') as ProxyProtocol)
      return { protocol, host: parsed.host, port: parsed.port, username: parsed.username, password: parsed.password }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      return undefined
    }
  }
  const port = integer(values.proxy_port, 'proxy_port', errors)
  return {
    protocol: (protocolText || 'http') as ProxyProtocol,
    host: values.proxy_host.trim(),
    port,
    username: values.proxy_username,
    password: values.proxy_password
  }
}

function analyzeRow(values: Record<BatchImportColumn, string>, index: number): Pick<AnalyzedRow, 'draft' | 'errors' | 'view'> {
  const errors: string[] = []
  const base = defaultProfileDraft(index)
  const name = values.name.trim()
  if (!name) errors.push('缺少窗口名称')
  const proxy = rowProxy(values, errors)
  const seed = integer(values.fingerprint_seed, 'fingerprint_seed', errors)
  const cores = integer(values.hardware_concurrency, 'hardware_concurrency', errors)
  const screenWidth = integer(values.screen_width, 'screen_width', errors)
  const screenHeight = integer(values.screen_height, 'screen_height', errors)
  const windowX = integer(values.window_x, 'window_x', errors, true)
  const windowY = integer(values.window_y, 'window_y', errors, true)
  const windowWidth = integer(values.window_width, 'window_width', errors)
  const windowHeight = integer(values.window_height, 'window_height', errors)
  if (values.cookie.trim()) {
    try {
      parseCookieFile(values.cookie)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  const platform = values.account_platform.trim()
  const username = values.account_username.trim()
  const view: BatchImportRowView = {
    line: 0,
    name,
    group: values.group.trim(),
    proxy: proxy ? maskedProxy(proxy) : maskedRaw(values.proxy || values.proxy_host),
    account: [platform, username].filter(Boolean).join(' · '),
    cookie: Boolean(values.cookie.trim()),
    errors
  }
  if (errors.length || !proxy) return { errors, view }

  try {
    const rawBrand = values.brand.trim()
    const startUrls = values.start_urls.trim() ? splitPipe(values.start_urls) : [platformStartUrl(platform)].filter((url): url is string => Boolean(url))
    const windowMode = values.window_mode.trim().toLowerCase()
    const fingerprint = refreshSeededGpuIdentity({
      ...base.fingerprint,
      seed: seed ?? base.fingerprint.seed,
      platform: (values.platform.trim().toLowerCase() || base.fingerprint.platform) as BrowserPlatform,
      platformVersion: values.platform_version.trim() || base.fingerprint.platformVersion,
      brand: (rawBrand ? `${rawBrand[0].toUpperCase()}${rawBrand.slice(1).toLowerCase()}` : base.fingerprint.brand) as BrowserBrand,
      brandVersion: values.brand_version.trim(),
      hardwareConcurrency: (cores ?? base.fingerprint.hardwareConcurrency) as typeof base.fingerprint.hardwareConcurrency,
      language: values.language.trim() || base.fingerprint.language,
      acceptLanguages: values.accept_languages.trim() || base.fingerprint.acceptLanguages,
      timezone: values.timezone.trim() || base.fingerprint.timezone,
      screenWidth: screenWidth ?? base.fingerprint.screenWidth,
      screenHeight: screenHeight ?? base.fingerprint.screenHeight,
      webrtcPolicy: (values.webrtc_policy.trim().toLowerCase() || base.fingerprint.webrtcPolicy) as WebRtcPolicy,
      disabledSpoofing: splitPipe(values.disabled_spoofing) as typeof base.fingerprint.disabledSpoofing
    })
    const draft = validateProfileDraft({
      ...base,
      name,
      group: values.group.trim(),
      tags: splitPipe(values.tags),
      note: values.note,
      startUrls,
      kernelVersion: values.kernel_version.trim(),
      color: values.color.trim() || base.color,
      proxy,
      account: { platform, username, password: values.account_password },
      window: {
        ...base.window,
        mode: windowMode === 'custom' ? 'custom' : windowMode === '' || windowMode === 'auto' ? 'auto' : windowMode as typeof base.window.mode,
        x: windowX ?? base.window.x,
        y: windowY ?? base.window.y,
        width: windowWidth ?? base.window.width,
        height: windowHeight ?? base.window.height
      },
      fingerprint
    })
    return { draft, errors, view }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    return { errors, view }
  }
}

/**
 * Checks every row independently so one bad row never blocks the others.
 * Problems with the file as a whole (no header, unknown columns, too many rows) still throw.
 */
export function analyzeBatchTable(table: string[][], startIndex = 1): AnalyzedTable {
  const numbered = table
    .map((cells, index) => ({ cells: cells.map((cell) => cell ?? ''), line: index + 1 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim()))
  const headerRow = numbered.shift()
  if (!headerRow) throw new Error('文件没有内容')
  const headers = headerRow.cells.map((cell) => cell.trim())
  const columns = headers.map((header) => header ? normalizeHeader(header) : undefined)
  const unknown = headers.filter((header, index) => header && !columns[index])
  if (unknown.length) throw new Error(`表头包含无法识别的列：${unknown.join(', ')}`)
  if (!columns.includes('name')) throw new Error('缺少“窗口名称”列，请使用导入模板')
  const known = columns.filter(Boolean)
  if (new Set(known).size !== known.length) throw new Error('表头包含重复的列')

  const dataRows = numbered.filter(({ cells }) => !cells[columns.indexOf('name')]?.trim().startsWith('#'))
  if (!dataRows.length) throw new Error('文件没有可导入的数据行')
  if (dataRows.length > MAX_IMPORT_ROWS) throw new Error(`单次最多导入 ${MAX_IMPORT_ROWS} 行`)

  const rows = dataRows.map(({ cells, line }, index): AnalyzedRow => {
    const values = Object.fromEntries(BATCH_IMPORT_COLUMNS.map((column) => [column, ''])) as Record<BatchImportColumn, string>
    columns.forEach((column, columnIndex) => { if (column) values[column] = cells[columnIndex] ?? '' })
    const extra = cells.slice(headers.length).some((cell) => cell.trim())
    const result = extra
      ? { errors: ['这一行的列数超过表头'], view: { line, name: values.name.trim(), group: values.group.trim(), proxy: '', account: '', cookie: false, errors: [] as string[] } }
      : analyzeRow(values, startIndex + index)
    result.view.line = line
    result.view.errors = result.errors
    return { line, cells, cookieText: values.cookie.trim(), ...result }
  })
  return { headers, rows }
}

function templateHeader(column: BatchImportColumn): string {
  const locale = getLocale()
  const label = TEMPLATE_LABELS[column]
  return label && (locale === 'zh-CN' || locale === 'zh-TW') ? label[locale] : column
}

/** Template rows: header plus one example row that starts with # and is never imported. */
export function batchTemplateRows(): string[][] {
  const example: Partial<Record<BatchImportColumn, string>> = {
    name: t('# 示例窗口（以 # 开头的行不会导入）'),
    group: t('示例分组'),
    proxy: '203.0.113.10:1080:user:pass',
    account_platform: 'TikTok',
    account_username: 'shop01@example.com',
    account_password: '',
    cookie: '',
    note: t('代理可写 host:port:user:pass、socks5://user:pass@host:port 或留空直连'),
    start_urls: ''
  }
  return [TEMPLATE_COLUMNS.map(templateHeader), TEMPLATE_COLUMNS.map((column) => example[column] ?? '')]
}

const escapeCsv = (value: string): string => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value

export function serializeCsv(rows: string[][]): string {
  return `﻿${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}\r\n`
}

/** The original rows that failed, with a reason column, ready to fix and import again. */
export function errorRows(table: AnalyzedTable): string[][] {
  const failed = table.rows.filter((row) => !row.draft)
  const width = table.headers.length
  return [
    [...table.headers, t('错误原因')],
    ...failed.map((row) => [...Array.from({ length: width }, (_, index) => row.cells[index] ?? ''), joinMessages(row.errors.map((error) => translateMessage(error)))])
  ]
}

export async function serializeXlsx(rows: string[][]): Promise<Buffer> {
  const { default: writeXlsxFile } = await import('write-excel-file/node')
  const data = rows.map((row, rowIndex) => row.map((value) => ({ value, type: String, ...(rowIndex === 0 ? { fontWeight: 'bold' as const } : {}) })))
  const widths = rows[0].map((_, column) => Math.min(60, Math.max(12, ...rows.map((row) => (row[column] ?? '').length + 2))))
  return writeXlsxFile(data, { columns: widths.map((width) => ({ width })) }).toBuffer()
}
