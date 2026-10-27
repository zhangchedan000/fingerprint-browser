/**
 * Deep check: public detection sites, which keep improving their own tests, judge the window. The
 * temporary check browser opens each one and these parsers read the verdict from the page text
 * (calibrated with tools/kernel-smoke BISECT=sites). When a site changes its page and nothing can
 * be read, the result says so and the screenshot still shows the site's own answer.
 */

export type DeepSite = 'iphey' | 'browserscan' | 'pixelscan' | 'creepjs'

export interface DeepSiteResult {
  site: DeepSite
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

export interface DeepSiteSpec {
  site: DeepSite
  name: string
  url: string
  /** How long to wait for the verdict to appear. */
  timeoutMs: number
}

export const DEEP_SITES: readonly DeepSiteSpec[] = [
  { site: 'iphey', name: 'iphey', url: 'https://iphey.com/', timeoutMs: 60_000 },
  { site: 'browserscan', name: 'BrowserScan', url: 'https://www.browserscan.net/', timeoutMs: 45_000 },
  { site: 'pixelscan', name: 'Pixelscan', url: 'https://pixelscan.net/fingerprint-check', timeoutMs: 45_000 },
  { site: 'creepjs', name: 'CreepJS', url: 'https://abrahamjuliot.github.io/creepjs/', timeoutMs: 45_000 }
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
  const verdict = text.match(/Fingerprint is (consistent|inconsistent)/i)?.[1]
  if (!verdict) return undefined
  const all = lines(text)
  const findings: string[] = [`Fingerprint is ${verdict}`]
  let flagged = false
  for (const label of ['Location', 'Proxy', 'Fingerprint', 'Bot check']) {
    const index = all.findIndex((line, i) => line === label && i > 0)
    const status = index > 0 ? all[index - 1] : undefined
    if (!status) continue
    const bad = /detected|spoofed|mismatch/i.test(status) && !/^no /i.test(status)
    if (bad) {
      flagged = true
      findings.push(`${label}: ${status}`)
    }
  }
  return { status: /^inconsistent$/i.test(verdict) ? 'bad' : flagged ? 'warn' : 'ok', findings }
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

const PARSERS: Record<DeepSite, (text: string) => Parsed | undefined> = { iphey, browserscan, pixelscan, creepjs }

/**
 * Placeholders the sites show while a value is still coming: BrowserScan's "---.---.---.---" IP
 * and "--/--", iphey's "Temporary value", "Loading…" anywhere.
 */
export function pageStillLoading(text: string): boolean {
  return /-{3}\.-{3}|(^|\s)--\/--(\s|$)|Temporary value|Loading\.\.\.|Loading…/i.test(text)
}

/** The site's verdict, or undefined while the page has not produced one yet. */
export function parseDeepSite(site: DeepSite, text: string): Parsed | undefined {
  return PARSERS[site](text)
}

/** Chinese explanations for findings the sites word the same way every time. */
export const FINDING_NOTES: ReadonlyArray<[RegExp, string]> = [
  [/Different time zones|Timezone spoofed/i, '时区与 IP 所在地不一致'],
  [/Proxy detected/i, '被识别为代理 IP'],
  [/Masking detected/i, '发现指纹伪装痕迹'],
  [/automated behavior detected|Bot/i, '被识别为自动化浏览器'],
  [/Different languages?/i, '语言与 IP 所在地不一致'],
  [/WebRTC/i, 'WebRTC 相关'],
  [/stealth/i, '发现隐身插件或伪装痕迹'],
  [/headless/i, '像无头浏览器的特征'],
  [/^LOCATION:/, 'iphey 按 IP 判断的位置，和窗口时区所在国家不同时通常就是扣分原因'],
  [/^IP ADDRESS:/, 'iphey 看到的出口 IP'],
  [/没有完全加载完/, '截图和结论可能不完整，可以打开原网页再看']
]
