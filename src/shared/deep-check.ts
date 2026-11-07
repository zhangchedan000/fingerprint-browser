/**
 * Deep check: public detection sites, which keep improving their own tests, judge the window. The
 * temporary check browser opens each one and these parsers read the verdict from the page text
 * (calibrated with tools/kernel-smoke BISECT=sites). When a site changes its page and nothing can
 * be read, the result says so and the screenshot still shows the site's own answer.
 */

export type DeepSite = 'iphey' | 'browserscan' | 'pixelscan' | 'creepjs' | 'fpcom' | 'whoer'

export interface DeepSiteResult {
  /** The DeepCheckSite id. */
  site: string
  name: string
  url: string
  status: 'ok' | 'warn' | 'bad' | 'unknown'
  /** The site's own score, as it shows it ("100", "90%"…). */
  score?: string
  /** What the site flagged, in its own words (each one also has a Chinese key when known). */
  findings: string[]
  /** JPEG data URL of the page as the site left it. */
  screenshot?: string
  error?: string
}

/** The last deep check of a window, kept in its folder so it is there when the editor opens again. */
export interface DeepCheckRecord {
  checkedAt: string
  /** The editor's settings key when it ran, to tell when the window has changed since. */
  checkedSettings?: string
  results: DeepSiteResult[]
}

/** A site in the user's deep check list (Settings); the built-in ones are the default list. */
export interface DeepCheckSite {
  id: string
  name: string
  url: string
  enabled: boolean
}

export interface DeepSiteSpec {
  site: DeepSite
  name: string
  url: string
  /** How long to wait for the verdict to appear. */
  timeoutMs: number
}

/**
 * After the verdict shows, how much longer the rest of the page may take to settle before the
 * screenshot. Measured 2026-10-31 (direct, Win11): every site settled within 6 s of its verdict;
 * through a proxy BrowserScan kept filling rows past 45 s.
 */
export const DEEP_SETTLE_AFTER_VERDICT_MS = 30_000

/** The sites whose verdict the parsers below can read. */
// Verdicts came after 2 s (CreepJS), 3 s (BrowserScan), 13 s (iphey) and 21 s (Pixelscan) on a direct
// connection (2026-10-31); a slow proxy takes several times that, so each gets two minutes.
export const DEEP_SITES: readonly DeepSiteSpec[] = [
  { site: 'iphey', name: 'iphey', url: 'https://iphey.com/', timeoutMs: 120_000 },
  { site: 'browserscan', name: 'BrowserScan', url: 'https://www.browserscan.net/', timeoutMs: 120_000 },
  { site: 'pixelscan', name: 'Pixelscan', url: 'https://pixelscan.net/fingerprint-check', timeoutMs: 120_000 },
  { site: 'creepjs', name: 'CreepJS', url: 'https://abrahamjuliot.github.io/creepjs/', timeoutMs: 120_000 },
  // Its verdict came after 3 s on a direct connection (2026-11-07); the same IP asking too often gets 429.
  { site: 'fpcom', name: 'Fingerprint.com', url: 'https://demo.fingerprint.com/playground', timeoutMs: 120_000 },
  // 11-07: its 70% on a Mexico proxy was the DNS server in Italy; 90% on a US node, its clock an hour off the IP's.
  { site: 'whoer', name: 'whoer', url: 'https://whoer.net/', timeoutMs: 120_000 }
]
type Parsed = Pick<DeepSiteResult, 'status' | 'score' | 'findings'>

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

/** iphey: "Your Digital Identity Looks Trustworthy", "100 MX SCORE", one line per card. */
function iphey(text: string): Parsed | undefined {
  if (/Temporary value/i.test(text)) return undefined
  const score = text.match(/(\d{1,3})\s*MX SCORE/i)?.[1]
  const verdict = text.match(/Identity Looks\s+([A-Za-z]+)/i)?.[1]
  if (!score || !verdict) return undefined
  const all = lines(text)
  const findings: string[] = [`Looks ${verdict}`]
  const trusted = /trustworthy/i.test(verdict)
  for (const card of ['BROWSER', 'LOCATION', 'IP ADDRESS', 'HARDWARE', 'SOFTWARE']) {
    const index = all.indexOf(card)
    const value = index >= 0 ? all[index + 1] : undefined
    if (!value) continue
    // Hardware and software say what is wrong. Location and IP only name what iphey found; when it
    // does not trust the window they are usually why (its GeoIP country against the time zone).
    if ((card === 'HARDWARE' || card === 'SOFTWARE') && !/everything is fine/i.test(value)) findings.push(`${card}: ${value}`)
    if (!trusted && (card === 'LOCATION' || card === 'IP ADDRESS')) findings.push(`${card}: ${value}`)
  }
  const value = Number(score)
  return { status: trusted && value >= 90 ? 'ok' : value >= 60 ? 'warn' : 'bad', score, findings }
}

/** BrowserScan: "Browser fingerprint authenticity: 90%", then each deduction as a line and "-10%". */
function browserscan(text: string): Parsed | undefined {
  const score = text.match(/authenticity\s*:?\s*(\d{1,3})\s*%/i)?.[1] ?? text.match(/autenticidad[^\d]{0,40}(\d{1,3})\s*%/i)?.[1]
  if (!score) return undefined
  const all = lines(text)
  const findings = all.flatMap((line, index) => /^-\d{1,3}%$/.test(line) && all[index - 1] ? [`${all[index - 1]} ${line}`] : [])
  const value = Number(score)
  return { status: value >= 95 ? 'ok' : value >= 75 ? 'warn' : 'bad', score: `${score}%`, findings }
}

/** Pixelscan: "Your Browser Fingerprint is inconsistent" and a status line above each check. */
function pixelscan(text: string): Parsed | undefined {
  // Its headline only: the FAQ below says "…your fingerprint is consistent" while the scan still runs.
  const verdict = text.match(/^\s*Your Browser Fingerprint is (consistent|inconsistent)\s*$/im)?.[1]
  if (!verdict) return undefined
  const all = lines(text)
  const findings: string[] = [`Fingerprint is ${verdict}`]
  let flagged = false
  const flaggedLabels: string[] = []
  for (const label of ['Location', 'Proxy', 'Fingerprint', 'Bot check']) {
    const index = all.findIndex((line, i) => line === label && i > 0)
    const status = index > 0 ? all[index - 1] : undefined
    if (!status) continue
    const bad = /detected|spoofed|mismatch/i.test(status) && !/^no /i.test(status)
    if (bad) {
      flagged = true
      flaggedLabels.push(label)
      findings.push(`${label}: ${status}`)
    }
  }
  // Its proxy check reads the IP's database entry: a data-centre IP is always "Proxy detected" and the headline then
  // says inconsistent, though nothing about the browser was flagged. That alone is a risk of the IP, not a failure.
  const onlyProxy = flaggedLabels.length > 0 && flaggedLabels.every((label) => label === 'Proxy')
  const inconsistent = /^inconsistent$/i.test(verdict)
  return { status: inconsistent && !onlyProxy ? 'bad' : inconsistent || flagged ? 'warn' : 'ok', findings }
}

/** CreepJS: "0% headless", "25% like headless", "0% stealth". */
function creepjs(text: string): Parsed | undefined {
  const like = text.match(/(\d{1,3})% like headless/i)?.[1]
  const headless = text.match(/(\d{1,3})% headless/i)?.[1]
  const stealth = text.match(/(\d{1,3})% stealth/i)?.[1]
  if (like === undefined || headless === undefined || stealth === undefined) return undefined
  const findings = [`${headless}% headless`, `${like}% like headless`, `${stealth}% stealth`]
  const status = Number(headless) > 0 || Number(stealth) > 0 ? 'bad' : Number(like) >= 50 ? 'warn' : 'ok'
  return { status, score: `${like}% / ${headless}% / ${stealth}%`, findings }
}

/**
 * Fingerprint.com's playground prints its Server API response as "key: value" lines. Thresholds are
 * Fingerprint's own (docs.fingerprint.com, Smart Signals reference, read 2026-11-07): an anti-detect
 * browser at tampering_ml_score above 0.8, an anomalous one at anomaly_score above 0.5; tampering,
 * bot "bad" and the IP blocklist are its verdicts. VPN, proxy, virtual machine and the rest are risks.
 */
function fpcom(text: string): Parsed | undefined {
  const start = text.indexOf('Server API Response')
  if (start < 0) return undefined
  const api = text.slice(start)
  const field = (key: string) => api.match(new RegExp(`^${key}: "?([^"\\n]*)"?$`, 'm'))?.[1]
  const ml = field('tampering_ml_score')
  const tampering = field('tampering')
  if (ml === undefined || tampering === undefined) return undefined
  const anomaly = field('anomaly_score') ?? '0'
  const yes = (key: string) => field(key) === 'true'
  const antiDetect = yes('anti_detect_browser') || Number(ml) > 0.8
  const findings = [`tampering: ${tampering}`, `tampering_ml_score: ${ml}`, `anomaly_score: ${anomaly}`]
  const suspect = field('suspect_score')
  if (suspect !== undefined) findings.push(`suspect_score: ${suspect}`)
  let bad = tampering === 'true' || antiDetect || Number(anomaly) > 0.5
  let risky = false
  const bot = field('bot')
  if (bot && bot !== 'not_detected') {
    findings.push(`bot: ${bot}`)
    bad ||= bot === 'bad'
  }
  const blocked = ['email_spam', 'attack_source', 'tor_node'].filter(yes)
  if (blocked.length) {
    findings.push(`ip_blocklist: ${blocked.join(', ')}`)
    bad = true
  }
  if (yes('vpn')) {
    risky = true
    const methods = ['timezone_mismatch', 'public_vpn', 'os_mismatch', 'relay', 'auxiliary_mobile', 'ml_prediction'].filter(yes)
    findings.push(...(methods.length ? methods.map((method) => `vpn: ${method}`) : ['vpn: true']))
  }
  if (yes('proxy')) {
    risky = true
    const details = api.match(/^proxy_details: \{([^}]*)\}/m)?.[1] ?? ''
    const type = details.match(/^proxy_type: "?([^"\n]*)"?$/m)?.[1]
    const provider = details.match(/^provider: "?([^"\n]*)"?$/m)?.[1]
    findings.push(`proxy: ${type ?? 'true'}${provider ? ` (${provider})` : ''}`)
  }
  for (const key of ['virtual_machine', 'developer_tools', 'incognito', 'privacy_settings', 'high_activity_device', 'rare_device']) {
    if (!yes(key)) continue
    risky = true
    findings.push(`${key}: true`)
  }
  return { status: bad ? 'bad' : risky ? 'warn' : 'ok', score: ml, findings }
}

/**
 * whoer.net: "Your disguise: 90% …" (the page is in the window's language, so rows are found by their
 * place, not their words). Above the score: the IP line with "city / country" under it, then the DNS
 * server's address and country, and three yes/no rows (proxy, anonymizer, blacklist). Below: the IP's
 * local time and the browser's ("GMT-0700" / "GMT-0800"). Read 11-07 in English, Spanish, Chinese and German.
 */
function whoer(text: string): Parsed | undefined {
  const all = lines(text)
  const dns = all.indexOf('DNS')
  const scoreAt = all.findIndex((line, index) => index > dns && /^[^\d%]{2,40}[:：]\s*\d{1,3}\s*%/.test(line))
  if (dns < 0 || scoreAt < 0) return undefined
  const score = Number(all[scoreAt].match(/(\d{1,3})\s*%/)![1])
  const findings: string[] = []
  // The country is the part after the last "/" of the line under the IP ("Draper / United States").
  const ipAt = all.findIndex((line) => /\bIP\s*[:：]/.test(line))
  const ipCountry = ipAt >= 0 && ipAt < dns ? all[ipAt + 1]?.split('/').pop()?.trim() : undefined
  // "203.0.113.5  Italia" (an address, sometimes a number stuck to it, then the country).
  const dnsCountry = all[dns + 1]?.match(/^[\d.:a-f]+\s{2,}(.+)$/i)?.[1]?.trim()
  if (dnsCountry) findings.push(dnsCountry === ipCountry || !ipCountry ? `DNS: ${dnsCountry}` : `DNS: ${dnsCountry} ≠ IP: ${ipCountry}`)
  // The yes/no rows: the last three "label:" + value pairs before the score.
  const pairs: Array<[string, string]> = []
  for (let index = dns + 2; index < scoreAt - 1; index++) {
    if (/[:：]$/.test(all[index]) && all[index + 1] && !/[:：]$/.test(all[index + 1])) pairs.push([all[index].replace(/[:：]$/, ''), all[index + 1]])
  }
  const yes = /^(yes|s[ií]|是|有|ja|oui|да|はい|sim|evet|có|ใช่|हाँ|так)$/i
  pairs.slice(-3).forEach(([label, value], index) => {
    if (yes.test(value)) findings.push(`${['Proxy', 'Anonymizer', 'Blacklist'][index]}: ${label} ${value}`)
  })
  // The IP's local time and the browser's, first and second "GMT±hhmm" after the score.
  const offsets = all.slice(scoreAt).map((line) => line.match(/GMT([+-]\d{4})/)?.[1]).filter((value): value is string => Boolean(value))
  if (offsets.length >= 2 && offsets[0] !== offsets[1]) findings.push(`Time zone: IP GMT${offsets[0]} ≠ browser GMT${offsets[1]}`)
  return { status: score >= 100 ? 'ok' : score >= 60 ? 'warn' : 'bad', score: `${score}%`, findings }
}

const PARSERS: Record<DeepSite, (text: string) => Parsed | undefined> = { iphey, browserscan, pixelscan, creepjs, fpcom, whoer }

/** The list a new installation starts with, and "恢复默认" brings back. */
export const DEFAULT_DEEP_CHECK_SITES: readonly DeepCheckSite[] = DEEP_SITES.map((spec) => ({
  id: spec.site, name: spec.name, url: spec.url, enabled: true
}))

/** Sites added by the user get no score; this long is spent waiting for their page to settle. */
const OTHER_SITE_TIMEOUT_MS = 45_000
/**
 * A site the user added is not shot before this, however still its page looks: results that come a
 * few seconds later (whoer's score and DNS, 11-07) were shot as "N/A" when 3 still seconds were enough.
 */
export const OTHER_SITE_MIN_WAIT_MS = 15_000

/** The built-in site this URL is on (its verdict can be read), by host and path. */
export function knownDeepSite(url: string): DeepSiteSpec | undefined {
  try {
    const target = new URL(url)
    const host = (address: URL) => address.hostname.replace(/^www\./, '')
    // On shared hosts (CreepJS on github.io) the first path segment names the site.
    const first = (address: URL) => address.pathname.split('/')[1] ?? ''
    return DEEP_SITES.find((spec) => {
      const known = new URL(spec.url)
      return host(target) === host(known) && (!known.hostname.endsWith('github.io') || first(target) === first(known))
    })
  } catch {
    return undefined
  }
}

export function deepSiteTimeout(url: string): number {
  return knownDeepSite(url)?.timeoutMs ?? OTHER_SITE_TIMEOUT_MS
}

/** The user's list, cleaned: http(s) URLs, a name, unique ids, at most 20. Undefined = the default list. */
export function validDeepCheckSites(input: unknown): DeepCheckSite[] | undefined {
  if (!Array.isArray(input)) return undefined
  const seen = new Set<string>()
  const sites: DeepCheckSite[] = []
  for (const item of input.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue
    const { id, name, url, enabled } = item as Partial<DeepCheckSite>
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
 * Placeholders the sites show while a value is still coming: BrowserScan's "---.---.---.---" IP
 * and "--/--", iphey's "Temporary value", "Loading…" anywhere.
 */
export function pageStillLoading(text: string): boolean {
  return /-{3}\.-{3}|(^|\s)--\/--(\s|$)|Temporary value|Loading\.\.\.|Loading…|scanning…|Collecting Data…|Computing\.\.\./i.test(text)
    // whoer while its DNS test runs: nothing under "DNS" yet, the next row's label comes right after it (11-07).
    || /(^|\n)\s*DNS\s*\n\s*[^\n]{1,30}[:：]\s*(\n|$)/.test(text)
    // A score still "N/A N/A" (whoer before its test is done, on any site the user adds too).
    || /[:：]\s*N\/A\s+N\/A/i.test(text)
}

/**
 * For a site the user added (no reader written for it): the short lines of its page that carry a
 * score — a percentage, or a number next to a word like score / 评分 / 伪装 / risk — so the result
 * shows what the site said without opening the screenshot (user 11-07: what the user adds must work
 * as well as the built-in sites). No verdict is drawn from them: the site's own scale is unknown.
 */
export function scoreLines(text: string, limit = 4): string[] {
  const words = /(score|rating|trust|risk|anonymity|disguise|fraud|quality|评分|分数|得分|分值|伪装|偽裝|风险|風險|信任|可信|匿名|puntuaci|disfraz|riesgo|note|bewertung|tarnung|оценк|рейтинг|スコア|リスク)/i
  const found: string[] = []
  for (const line of lines(text)) {
    if (line.length > 100 || found.includes(line)) continue
    const percent = /\d{1,3}(\.\d+)?\s*%/.test(line)
    const scored = words.test(line) && /\d/.test(line)
    if (percent || scored) found.push(line)
    if (found.length >= limit) break
  }
  return found
}

/**
 * The site's verdict, or undefined while the page has not produced one yet. A site that is not
 * one of the built-in ones has no verdict to read: it is "unknown" with only its page title.
 */
export function parseDeepSite(url: string, text: string): Parsed | undefined {
  const known = knownDeepSite(url)
  return known ? PARSERS[known.site](text) : undefined
}

/**
 * Chinese explanations for findings the sites word the same way every time. A note with a site is only for that
 * site's findings (Pixelscan and whoer both write "Proxy: …"); the others fit any site.
 */
export const FINDING_NOTES: ReadonlyArray<readonly [RegExp, string, DeepSite?]> = [
  // whoer.net.
  [/^DNS: .*≠ IP:/, 'DNS 服务器和 IP 不在同一个国家：代理那边用的 DNS，whoer 实测会扣 30%（换代理或让代理商改 DNS）', 'whoer'],
  [/^DNS: /, 'DNS 服务器所在国家，和 IP 同一个国家就没问题', 'whoer'],
  [/^Time zone: IP GMT/, 'whoer 按它的 IP 库算的当地时间和浏览器时间不一样（各家 IP 库对城市的判断可能不同）', 'whoer'],
  [/^Proxy: /, '被 whoer 识别为代理', 'whoer'],
  [/^Anonymizer: /, '被 whoer 识别为匿名服务', 'whoer'],
  [/^Blacklist: /, '出口 IP 在 whoer 的黑名单里', 'whoer'],
  // Pixelscan.
  [/^Fingerprint is inconsistent/, '下面任意一项报红，Pixelscan 就写 inconsistent，看下面具体是哪一项', 'pixelscan'],
  [/^Proxy: /, 'Pixelscan 按 IP 数据库判断是代理：机房 IP 都会这样，换住宅 IP 才不报；和浏览器指纹无关', 'pixelscan'],
  // Fingerprint.com (its field names; what they mean from its docs).
  [/^tampering: true/, '被判定为浏览器篡改'],
  [/^tampering: false/, '没有判定为浏览器篡改'],
  [/^tampering_ml_score:/, '防关联浏览器模型分（0～1），官方 0.8 以上判为防关联浏览器；真实浏览器也不是 0'],
  [/^anomaly_score:/, '浏览器特征的罕见程度（0～1），官方 0.5 以上判为异常'],
  [/^suspect_score:/, '可疑总分：判中的各项信号按官方权重相加'],
  [/^bot:/, '被识别为自动化浏览器'],
  [/^ip_blocklist:/, '出口 IP 在黑名单里（垃圾邮件、攻击来源或 Tor 出口）'],
  [/^vpn: timezone_mismatch/, '时区与 IP 所在国家不一致；同一个 IP 近 7 天有一半访问不一致也会判中（多人共用的 IP 容易这样）'],
  [/^vpn: os_mismatch/, '网络流量看出的系统和浏览器的系统不一致；同一个 IP 近 7 天有 10% 访问不一致也会判中'],
  [/^vpn: public_vpn/, '出口 IP 属于公开的 VPN 服务商'],
  [/^vpn: relay/, '出口 IP 属于匿名中继服务'],
  [/^vpn: ml_prediction/, '网站的模型判断在用 VPN'],
  [/^vpn:/, '被识别为 VPN'],
  [/^proxy:/, '被识别为代理 IP：data_center 是机房 IP，residential 是住宅代理'],
  [/^virtual_machine:/, '被识别为虚拟机'],
  [/^developer_tools:/, '开着开发者工具'],
  [/^incognito:/, '无痕模式'],
  [/^privacy_settings:/, '开了隐私保护设置'],
  [/^high_activity_device:/, '这台设备近期访问次数很多'],
  [/^rare_device:/, '设备配置很少见'],
  [/Different time zones|Timezone spoofed/i, '时区与 IP 所在地不一致'],
  [/Proxy detected/i, '被识别为代理 IP'],
  [/Masking detected/i, '发现指纹伪装痕迹'],
  [/automated behavior detected|Bot/i, '被识别为自动化浏览器'],
  [/Different languages?/i, '语言与 IP 所在地不一致'],
  [/WebRTC/i, 'WebRTC 相关'],
  [/stealth/i, '发现隐身插件或伪装痕迹'],
  [/headless/i, '像无头浏览器的特征'],
  [/^LOCATION:/, 'iphey 按 IP 判断的位置，和窗口时区所在国家不同时通常就是扣分原因', 'iphey'],
  [/^IP ADDRESS:/, 'iphey 看到的出口 IP', 'iphey'],
  [/没有完全加载完/, '截图和结论可能不完整，可以打开原网页再看'],
  [/^网页弹窗：/, '检测网站自己弹出的提示，检测时已自动点掉；常见是网站的接口连不上（Failed to fetch），结论可能不完整']
]

/** The note for one finding of a site (undefined: the site is not a built-in one, only notes for any site). */
export function findingNote(finding: string, site?: DeepSite): string | undefined {
  return FINDING_NOTES.find(([pattern, , only]) => (!only || only === site) && pattern.test(finding))?.[1]
}
