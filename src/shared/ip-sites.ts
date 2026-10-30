/**
 * IP check sites: after a proxy check, the window's own check browser (its kernel, proxy and
 * fingerprint) opens them and the parsers below read what each says about the exit IP. The
 * baseline site (IPLark unless the user picks another one) decides the score, whether the IP is
 * native and whether it is a data centre or a home line; one other site, in turn, is shown next to
 * it. When a site changes its page and nothing can be read, the result says so.
 */

export type KnownIpSite = 'iplark' | 'ping0'

/** A site in the user's IP check list (Settings); IPLark and ping0.cc are the default list. */
export interface IpCheckSite {
  id: string
  name: string
  url: string
  enabled: boolean
}

/** What one site said about the exit IP, in its own words (shown with a Chinese label). */
export interface IpSiteReading {
  /** The IpCheckSite id. */
  site: string
  name: string
  url: string
  /** The IP the site saw (an API or rotating proxy may show another one than the check). */
  ip?: string
  /** The site's own score as it shows it ("56", "22%"), and what it counts out of. */
  score?: string
  scoreOf?: string
  /** What the score means on this site: a higher number is better, or riskier. */
  scoreKind?: 'quality' | 'risk'
  /** The site's own wording after the score ("纯净"). */
  scoreNote?: string
  /** Two-letter country code and the site's country name. */
  countryCode?: string
  country?: string
  city?: string
  /** The company the IP is registered to. */
  company?: string
  /** Data centre, home line or mobile, from the site's own words. */
  usage?: 'datacenter' | 'residential' | 'mobile' | 'business' | 'other'
  usageText?: string
  /** Native (registered and used in one country) or broadcast, from the site's own words. */
  native?: boolean
  nativeText?: string
  error?: string
  /** JPEG data URL of the page as the site left it (sites the user added: the only result). */
  screenshot?: string
}

/** The last reading of a window's exit IP: the baseline site, and the other one checked with it. */
export interface IpSiteRecord {
  checkedAt: string
  /** The proxy check's exit IP it belongs to. */
  checkIp?: string
  baseline: IpSiteReading
  other?: IpSiteReading
}

/** A kept reading as stored or handed over (team sync, the renderer): undefined unless well-formed. */
export function safeIpSiteRecord(value: unknown): IpSiteRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<IpSiteRecord>
  const reading = (item: unknown): item is IpSiteReading => Boolean(item && typeof item === 'object'
    && typeof (item as IpSiteReading).site === 'string' && typeof (item as IpSiteReading).name === 'string' && typeof (item as IpSiteReading).url === 'string')
  if (typeof record.checkedAt !== 'string' || Number.isNaN(Date.parse(record.checkedAt)) || !reading(record.baseline)) return undefined
  if (record.other !== undefined && !reading(record.other)) return undefined
  if (record.checkIp !== undefined && typeof record.checkIp !== 'string') return undefined
  return JSON.parse(JSON.stringify(record)) as IpSiteRecord
}

export const DEFAULT_IP_CHECK_SITES: readonly IpCheckSite[] = [
  { id: 'iplark', name: 'IPLark', url: 'https://iplark.com/', enabled: true },
  { id: 'ping0', name: 'ping0.cc', url: 'https://ping0.cc/', enabled: true }
]
export const DEFAULT_IP_BASELINE = 'iplark'

/** The built-in site a URL belongs to: read by its own parser; any other site by the general one. */
export function knownIpSite(url: string): KnownIpSite | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host === 'iplark.com') return 'iplark'
    if (host === 'ping0.cc') return 'ping0'
  } catch {
    return undefined
  }
  return undefined
}

/** The user's list, cleaned: http(s) URLs, a name, unique ids, at most 20. Undefined = the default list. */
export function validIpCheckSites(input: unknown): IpCheckSite[] | undefined {
  if (!Array.isArray(input)) return undefined
  const seen = new Set<string>()
  const sites: IpCheckSite[] = []
  for (const item of input.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue
    const { id, name, url, enabled } = item as Partial<IpCheckSite>
    if (typeof id !== 'string' || !id || seen.has(id) || typeof name !== 'string' || !name.trim() || typeof url !== 'string') continue
    try {
      if (!/^https?:$/.test(new URL(url).protocol)) continue
    } catch {
      continue
    }
    seen.add(id)
    sites.push({ id, name: name.trim().slice(0, 40), url: url.trim(), enabled: enabled !== false })
  }
  return sites
}

/**
 * The baseline site of a list: the one picked while it is in the list and on; else IPLark; else
 * the first site that is on. Any site can be it (others are read by the general reader).
 */
export function ipBaseline(sites: readonly IpCheckSite[], picked: string | undefined): IpCheckSite | undefined {
  const usable = sites.filter((site) => site.enabled)
  return usable.find((site) => site.id === picked) ?? usable.find((site) => site.id === DEFAULT_IP_BASELINE) ?? usable[0]
}

/** The other site checked this time: the enabled ones besides the baseline, in turn (`turn` counts checks). */
export function ipSiteInTurn(sites: readonly IpCheckSite[], baseline: IpCheckSite | undefined, turn: number): IpCheckSite | undefined {
  const others = sites.filter((site) => site.enabled && site.id !== baseline?.id)
  return others.length ? others[Math.abs(Math.trunc(turn)) % others.length] : undefined
}

type Parsed = Omit<IpSiteReading, 'site' | 'name' | 'url' | 'error' | 'screenshot'>

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const isNote = (line: string) => /^\(说明\?\)$/.test(line)

/** The first line after `label` that is not a "(说明?)" note, or undefined. */
function after(rows: string[], label: RegExp, skip = 0): string | undefined {
  const index = rows.findIndex((line) => label.test(line))
  if (index < 0) return undefined
  return rows.slice(index + 1).filter((line) => !isNote(line))[skip]
}

/** The site's own words for a data centre, a home line or a mobile network. */
function usageOf(text: string | undefined): IpSiteReading['usage'] {
  if (!text) return undefined
  if (/数据中心|机房|IDC|云厂商|hosting|data ?cent/i.test(text)) return 'datacenter'
  if (/家庭宽带|家宽|住宅|residential|ISP/i.test(text)) return 'residential'
  if (/移动|手机|蜂窝|mobile/i.test(text)) return 'mobile'
  if (/企业|商业|business/i.test(text)) return 'business'
  return 'other'
}

/** "韩国 江原道 春川" → the country and the last place named (the city). */
function place(text: string | undefined): { country?: string; city?: string } {
  const parts = (text ?? '').split(/\s+/).filter(Boolean)
  return { ...(parts[0] ? { country: parts[0] } : {}), ...(parts.length > 1 ? { city: parts[parts.length - 1] } : {}) }
}

/**
 * IPLark (iplark.com, checked 2026-10 with the prism kernel): the IP, its tags ("数据中心",
 * "原生IP (US)" / "广播IP (US)"), 国家/地区, 企业, 使用场景, "IP评分" with "56/100", and a
 * 地理位置（多源对比） list whose IPLark row names the city.
 */
function parseIplark(text: string): Parsed | undefined {
  const rows = lines(text)
  const scoreAt = rows.findIndex((line) => line === 'IP评分')
  const score = scoreAt >= 0 ? rows[scoreAt + 1] : undefined
  if (!score || !/^\d{1,3}$/.test(score)) return undefined
  const ip = rows.find((line) => IPV4.test(line))
  const head = rows.slice(0, Math.max(0, rows.indexOf('数字地址')))
  const nativeTag = head.find((line) => /^(原生|广播)\s*IP/.test(line))
  const geoAt = rows.indexOf('地理位置（多源对比）')
  const own = geoAt >= 0 && rows[geoAt + 1] === 'IPLark' ? place(rows[geoAt + 2]) : {}
  const usageText = after(rows, /^使用场景/) ?? head.find((line) => usageOf(line) !== 'other' && usageOf(line) !== undefined && line.length <= 8)
  const company = after(rows, /^企业$/)
  return {
    ...(ip ? { ip } : {}),
    score,
    scoreOf: '100',
    scoreKind: 'quality',
    ...(after(rows, /^国家\/地区$/) ? { country: after(rows, /^国家\/地区$/) } : own.country ? { country: own.country } : {}),
    ...(own.city ? { city: own.city } : {}),
    ...(company ? { company } : {}),
    ...(usageText ? { usage: usageOf(usageText), usageText } : {}),
    ...(nativeTag ? { native: nativeTag.startsWith('原生'), nativeText: nativeTag } : {})
  }
}

/**
 * ping0.cc (checked 2026-10 with the prism kernel): "IP 地址", "IP 位置" ("韩国 江原道 春川市 —
 * 甲骨文云 Oracle"), 企业 (after its IDC / ISP tag), "IP 类型" ("IDC机房 IP"), "风控值" ("20%",
 * "纯净") and "原生 IP" ("原生 IP" / "广播 IP").
 */
function parsePing0(text: string): Parsed | undefined {
  const rows = lines(text)
  const riskAt = rows.findIndex((line) => /^风控值/.test(line))
  const risk = riskAt >= 0 ? rows.slice(riskAt + 1).find((line) => !isNote(line)) : undefined
  if (!risk || !/^\d{1,3}%$/.test(risk)) return undefined
  const note = rows.slice(riskAt + 1).filter((line) => !isNote(line))[1]
  const ip = after(rows, /^IP 地址$/)
  const where = place(after(rows, /^IP 位置$/)?.split(/\s+—\s+/)[0])
  const companyAt = rows.indexOf('企业')
  const companyRows = companyAt >= 0 ? rows.slice(companyAt + 1, companyAt + 3) : []
  const company = companyRows[0] && /^[A-Z]{2,5}$/.test(companyRows[0]) ? companyRows[1] : companyRows[0]
  const usageText = after(rows, /^IP 类型$/)
  const nativeText = after(rows, /^原生 IP$/)
  return {
    ...(ip && IPV4.test(ip) ? { ip } : {}),
    score: risk,
    scoreKind: 'risk',
    ...(note && note.length <= 6 ? { scoreNote: note } : {}),
    ...where,
    ...(company ? { company } : {}),
    ...(usageText ? { usage: usageOf(usageText), usageText } : {}),
    ...(nativeText && /^(原生|广播)/.test(nativeText) ? { native: nativeText.startsWith('原生'), nativeText } : {})
  }
}

const PARSERS: Record<KnownIpSite, (text: string) => Parsed | undefined> = { iplark: parseIplark, ping0: parsePing0 }

/**
 * The panel's five rows, as other IP sites label them (checked on browserleaks.com, ipapi.is,
 * iplocation.net, ipdata.co, ippure.com, whoer.net with the prism kernel, 2026-10-30). Scores in
 * order of preference: a site's own verdict first, a bare "score" last; VPN and proxy scores
 * (how likely it is a VPN) are not an IP score.
 */
const SCORE_LABELS = [
  /^(?:ip\s*)?(?:评分|纯净度|质量分|风控值|风险值|风险分数?|风险评分|欺诈分数?|欺诈评分)$|系数$/i,
  /^(?:fraud|risk|trust|ip|abuse(?:\s*confidence)?|reputation)\s*score$/i,
  /^threat\s*score$/i,
  /^(?:score|分数|得分)$/i
]
const LABELS = {
  country: /^(?:国家\/地区|国家或地区|国家|country|country\s*name)$/i,
  city: /^(?:城市|city)$/i,
  company: /^(?:isp|isp\s*name|运营商|服务商|提供商|企业|组织|机构|organi[sz]ation|org|company|company\s*name|provider|as\s*name|asn\s*name|asn\s*organi[sz]ation|org\s*\/\s*isp)$/i,
  usage: /^(?:ip\s*类型|ip\s*属性|使用场景|用途|类型|usage\s*type|connection\s*type|ip\s*type|asn\s*type|type)$/i,
  native: /^(?:原生\s*ip|native\s*ip|ip\s*来源)$/i,
  ip: /^(?:ip|ip\s*地址|ip\s*address|你的\s*ip|我的\s*ip|my\s*ip|your\s*ip|query)$/i
} as const

/** A label as written, made comparable: "6\tcompany.name" / "usage_type" → "company name" / "usage type". */
const labelOf = (key: string) => key.replace(/^[#\d\s]+(?=\D)/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Label and value pairs of a page, surest first: JSON "key": value and "label<tab>value" /
 * "label: value" on one line; then a short label line with its value on the next line.
 */
function pairs(rows: string[]): Array<[string, string]> {
  const same: Array<[string, string]> = []
  const next: Array<[string, string]> = []
  rows.forEach((row, index) => {
    const json = row.match(/^"([\w. ]{1,30})"\s*:\s*"?([^"]*?)"?,?$/)
    if (json) { same.push([labelOf(json[1]), json[2]]); return }
    const split = row.match(/^([^\t:：]{1,30}?)\s*(?:\t+|[:：]\s*|\s{2,})(\S.*)$/)
    if (split) same.push([labelOf(split[1]), split[2]])
    const label = labelOf(row.replace(/\s*[:：\t]$/, ''))
    const value = rows[index + 1]
    if (label.length <= 30 && value && value.length <= 80) next.push([label, value])
  })
  return [...same, ...next]
}

const EMPTY = /^(?:-|n\/a|null|none|unknown|未知|\[.*\]|\{)$/i

/**
 * Any other IP site: its page's labels mapped onto the panel's rows. Only the part of the page from
 * where it shows the exit IP (`checkIp`) on is read, so a sample lookup above it, or a page about
 * another IP, is not taken for this IP's data.
 */
function parseGeneral(text: string, checkIp?: string): Parsed | undefined {
  let rows = lines(text)
  if (checkIp) {
    const at = rows.findIndex((row) => row.includes(checkIp))
    if (at < 0) return undefined
    rows = rows.slice(at)
  }
  const all = pairs(rows)
  const value = (label: RegExp) => all.find(([key, found]) => label.test(key) && found.trim() && !EMPTY.test(found.trim()))?.[1].trim()
  const parsed: Parsed = {}
  const ip = checkIp ?? value(LABELS.ip)?.match(/(?:\d{1,3}\.){3}\d{1,3}/)?.[0]
  if (ip) parsed.ip = ip
  for (const label of SCORE_LABELS) {
    const found = all.find(([key, text]) => label.test(key) && /^\D{0,3}\d/.test(text.trim()))
    const number = found?.[1].match(/(\d{1,3}(?:\.\d+)?)\s*(%|\/\s*100)?/)
    if (!found || !number || Number(number[1]) > 100) continue
    parsed.score = number[2] === '%' ? `${number[1]}%` : number[1]
    parsed.scoreKind = /风控|风险|欺诈|risk|fraud|abuse|threat/i.test(found[0]) ? 'risk' : 'quality'
    if (number[2] !== '%') parsed.scoreOf = '100'
    const note = found[1].slice(number.index! + number[0].length).replace(/^[\s(（]+|[)）\s]+$/g, '')
    if (note && note.length <= 12) parsed.scoreNote = note
    break
  }
  const country = value(LABELS.country)
  if (country) parsed.country = country
  const city = value(LABELS.city)
  if (city) parsed.city = city
  const company = value(LABELS.company)
  if (company) parsed.company = company
  const usageText = value(LABELS.usage)
  if (usageText && usageOf(usageText) !== 'other') { parsed.usage = usageOf(usageText); parsed.usageText = usageText }
  const nativeText = value(LABELS.native) ?? rows.find((row) => /^(?:原生|广播)\s*IP/.test(row))
  if (nativeText && /原生|广播|native|broadcast|yes|no|是|否/i.test(nativeText)) {
    parsed.native = /原生|native|yes|是/i.test(nativeText) && !/非原生|not\s*native|no|否/i.test(nativeText)
    parsed.nativeText = nativeText
  }
  const rowsFound = [parsed.country, parsed.company, parsed.usage, parsed.nativeText].filter(Boolean).length
  return parsed.score || rowsFound >= 2 ? parsed : undefined
}

/** What a site says: a built-in one by its own parser, any other by the general one; undefined while its page has not shown it yet. */
export function parseIpSite(url: string, text: string, checkIp?: string): Parsed | undefined {
  const known = knownIpSite(url)
  return known ? PARSERS[known](text) : parseGeneral(text, checkIp)
}

/** A site's address for this IP: "{ip}" in it (sites that look an IP up by its address) becomes the exit IP. */
export function ipSiteUrl(url: string, ip?: string): string | undefined {
  if (!/\{ip\}|%7Bip%7D/i.test(url)) return url
  return ip ? url.replace(/\{ip\}|%7Bip%7D/gi, ip) : undefined
}
