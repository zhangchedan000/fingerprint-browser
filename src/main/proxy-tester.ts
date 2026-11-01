import { ProxyAgent, request } from 'undici'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { ProxyConfig, ProxyTestResult, ServerPlace } from '../shared/types'
import { closeProxyBridge, localProxyFor, openProxyBridge, rememberDirectRoute } from './proxy-bridge'
import { safeErrorText } from './redaction'

const IP_CHECK_URL = 'https://api.ipify.org?format=json'
/** A check gives up after this long: a proxy that does not answer is reported, not waited for. */
export const PROXY_CHECK_DEADLINE_MS = 15_000
const LOOKUP_TIMEOUT_MS = 8_000

interface GeoLookupResponse {
  success?: boolean
  message?: string
  ip?: string
  country?: string
  country_code?: string
  region?: string
  city?: string
  latitude?: number
  longitude?: number
  timezone?: { id?: string }
  connection?: { asn?: number; org?: string; isp?: string }
  security?: { proxy?: boolean; vpn?: boolean; tor?: boolean; hosting?: boolean }
}

interface SecondaryGeoLookupResponse {
  error?: boolean
  reason?: string
  ip?: string
  city?: string
  region?: string
  country_name?: string
  country_code?: string
  latitude?: number
  longitude?: number
  timezone?: string
  asn?: string
  org?: string
}

function networkRisk(security: GeoLookupResponse['security']): ProxyTestResult['networkRisk'] {
  if (security?.tor) return 'tor'
  if (security?.vpn) return 'vpn'
  if (security?.proxy) return 'proxy'
  if (security?.hosting) return 'hosting'
  return undefined
}

export function parseGeoLookup(data: GeoLookupResponse, latencyMs: number): ProxyTestResult {
  if (data.success === false) throw new Error(data.message || 'IP 地理信息查询失败')
  if (!data.ip) throw new Error('IP 地理信息结果无效')
  const ipVersion = isIP(data.ip)
  if (ipVersion !== 4 && ipVersion !== 6) throw new Error('IP 地理信息返回了无效的出口地址')
  const timezone = data.timezone?.id
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    } catch {
      throw new Error('IP 地理信息返回了无效的时区')
    }
  }
  return {
    ok: true,
    ip: data.ip,
    latencyMs,
    country: data.country,
    countryCode: data.country_code?.toUpperCase(),
    latitude: typeof data.latitude === 'number' && data.latitude >= -90 && data.latitude <= 90 ? data.latitude : undefined,
    longitude: typeof data.longitude === 'number' && data.longitude >= -180 && data.longitude <= 180 ? data.longitude : undefined,
    accuracyMeters: typeof data.latitude === 'number' && typeof data.longitude === 'number' ? 25_000 : undefined,
    ipVersion,
    region: data.region,
    city: data.city,
    timezone,
    asn: data.connection?.asn,
    organization: data.connection?.org,
    isp: data.connection?.isp,
    networkRisk: networkRisk(data.security)
  }
}

export function parseSecondaryGeoLookup(data: SecondaryGeoLookupResponse, latencyMs: number): ProxyTestResult {
  if (data.error) throw new Error(data.reason || '备用 IP 地理信息查询失败')
  if (!data.ip) throw new Error('备用 IP 地理信息结果无效')
  const ipVersion = isIP(data.ip)
  if (ipVersion !== 4 && ipVersion !== 6) throw new Error('备用 IP 地理信息返回了无效的出口地址')
  if (data.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: data.timezone }).format()
    } catch {
      throw new Error('备用 IP 地理信息返回了无效的时区')
    }
  }
  const asn = typeof data.asn === 'string' ? Number(data.asn.replace(/^AS/i, '')) : undefined
  return {
    ok: true,
    ip: data.ip,
    latencyMs,
    country: data.country_name,
    countryCode: data.country_code?.toUpperCase(),
    latitude: typeof data.latitude === 'number' && data.latitude >= -90 && data.latitude <= 90 ? data.latitude : undefined,
    longitude: typeof data.longitude === 'number' && data.longitude >= -180 && data.longitude <= 180 ? data.longitude : undefined,
    accuracyMeters: typeof data.latitude === 'number' && typeof data.longitude === 'number' ? 25_000 : undefined,
    ipVersion,
    region: data.region,
    city: data.city,
    timezone: data.timezone,
    asn: Number.isFinite(asn) ? asn : undefined,
    organization: data.org,
    isp: data.org
  }
}

const finite = (value: unknown, limit: number) => {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= limit ? number : undefined
}

/** The common shape of the other services' answers, checked the same way as the first two. */
function geoResult(source: string, fields: {
  ip?: string, countryCode?: string, country?: string, region?: string, city?: string, latitude?: unknown, longitude?: unknown,
  timezone?: string, asn?: unknown, organization?: string, networkRisk?: ProxyTestResult['networkRisk']
}, latencyMs: number): ProxyTestResult {
  if (!fields.ip) throw new Error(`${source} 结果无效`)
  const ipVersion = isIP(fields.ip)
  if (ipVersion !== 4 && ipVersion !== 6) throw new Error(`${source} 返回了无效的出口地址`)
  let timezone = fields.timezone || undefined
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    } catch {
      timezone = undefined
    }
  }
  const countryCode = fields.countryCode?.toUpperCase() || undefined
  let country = fields.country
  if (!country && countryCode) {
    try { country = new Intl.DisplayNames('en', { type: 'region' }).of(countryCode) } catch { country = undefined }
  }
  const latitude = finite(fields.latitude, 90)
  const longitude = finite(fields.longitude, 180)
  const asn = typeof fields.asn === 'string' ? Number(fields.asn.replace(/^AS/i, '')) : fields.asn
  return {
    ok: true,
    ip: fields.ip,
    latencyMs,
    country,
    countryCode,
    latitude,
    longitude,
    accuracyMeters: latitude !== undefined && longitude !== undefined ? 25_000 : undefined,
    ipVersion,
    region: fields.region || undefined,
    city: fields.city || undefined,
    timezone,
    asn: typeof asn === 'number' && Number.isFinite(asn) ? asn : undefined,
    organization: fields.organization,
    isp: fields.organization,
    networkRisk: fields.networkRisk
  }
}

type Json = Record<string, any>

/**
 * Free services that say where the connection comes from, no key needed. Each check asks two of
 * them, picked at random, so no one service sees every check (they limit how often one IP asks);
 * one that fails or is rate-limited is replaced by the next.
 */
export const GEO_SOURCES: ReadonlyArray<{ name: string; url: string; parse: (data: Json, latencyMs: number) => ProxyTestResult }> = [
  { name: 'ipwho.is', url: 'https://ipwho.is/', parse: (data, latencyMs) => parseGeoLookup(data as GeoLookupResponse, latencyMs) },
  { name: 'ipapi.co', url: 'https://ipapi.co/json/', parse: (data, latencyMs) => parseSecondaryGeoLookup(data as SecondaryGeoLookupResponse, latencyMs) },
  {
    name: 'ipinfo.io',
    url: 'https://ipinfo.io/json',
    parse: (data, latencyMs) => {
      const [latitude, longitude] = typeof data.loc === 'string' ? data.loc.split(',') : []
      const org = typeof data.org === 'string' ? data.org : ''
      return geoResult('ipinfo.io', {
        ip: data.ip, countryCode: data.country, region: data.region, city: data.city, latitude, longitude,
        timezone: data.timezone, asn: /^AS\d+/i.exec(org)?.[0], organization: org.replace(/^AS\d+\s*/i, '') || undefined
      }, latencyMs)
    }
  },
  {
    name: 'geojs.io',
    url: 'https://get.geojs.io/v1/ip/geo.json',
    parse: (data, latencyMs) => geoResult('geojs.io', {
      ip: data.ip, countryCode: data.country_code, country: data.country, region: data.region, city: data.city,
      latitude: data.latitude, longitude: data.longitude, timezone: data.timezone, asn: data.asn, organization: data.organization_name
    }, latencyMs)
  },
  {
    name: 'ip.sb',
    url: 'https://api.ip.sb/geoip',
    parse: (data, latencyMs) => geoResult('ip.sb', {
      ip: data.ip, countryCode: data.country_code, country: data.country, region: data.region, city: data.city,
      latitude: data.latitude, longitude: data.longitude, timezone: data.timezone, asn: data.asn, organization: data.organization ?? data.isp
    }, latencyMs)
  },
  {
    name: 'ipapi.is',
    url: 'https://api.ipapi.is/',
    parse: (data, latencyMs) => {
      const location: Json = data.location ?? {}
      return geoResult('ipapi.is', {
        ip: data.ip, countryCode: location.country_code, country: location.country, region: location.state, city: location.city,
        latitude: location.latitude, longitude: location.longitude, timezone: location.timezone, asn: data.asn?.asn, organization: data.asn?.org,
        networkRisk: data.is_tor ? 'tor' : data.is_vpn ? 'vpn' : data.is_proxy ? 'proxy' : data.is_datacenter ? 'hosting' : undefined
      }, latencyMs)
    }
  }
]

/** The same services asked about a given IP instead of the asker's own. */
const PLACE_URLS: Record<string, (ip: string) => string> = {
  'ipwho.is': (ip) => `https://ipwho.is/${ip}`,
  'ipapi.co': (ip) => `https://ipapi.co/${ip}/json/`,
  'ipinfo.io': (ip) => `https://ipinfo.io/${ip}/json`,
  'geojs.io': (ip) => `https://get.geojs.io/v1/ip/geo/${ip}.json`,
  'ip.sb': (ip) => `https://api.ip.sb/geoip/${ip}`,
  'ipapi.is': (ip) => `https://api.ipapi.is/?q=${ip}`
}
const places = new Map<string, ServerPlace>()

/**
 * Where a proxy server is (the address an API link gave, not the exit IP websites see): asked
 * from this computer, one service after another until one answers; remembered per address.
 */
export async function locateServer(host: string): Promise<ServerPlace | undefined> {
  const ip = isIP(host) ? host : await lookup(host).then((found) => found.address, () => undefined)
  if (!ip) return undefined
  const known = places.get(ip)
  if (known) return known
  const signal = AbortSignal.timeout(12_000)
  for (const source of [...GEO_SOURCES].sort(() => Math.random() - 0.5)) {
    if (signal.aborted) return undefined
    try {
      const result = source.parse(await lookupJson<Json>(PLACE_URLS[source.name](ip), undefined, signal), 0)
      if (!result.countryCode) continue
      const place: ServerPlace = { countryCode: result.countryCode.toUpperCase(), ...(result.city ? { city: result.city } : {}) }
      places.set(ip, place)
      return place
    } catch {
      // The next service.
    }
  }
  return undefined
}

/** A check result labelled with the service that gave it. */
export interface GeoAnswer {
  source: string
  result: ProxyTestResult
}

/**
 * Two services' answers for the same connection. Different exit IPs mean the proxy hands out a new
 * IP per connection (a rotating proxy). Same IP, different countries: the databases disagree. Same
 * country: agreed; a city they disagree on is left out (the country is what counts).
 */
export function mergeGeoLookups(first: GeoAnswer, second: GeoAnswer): ProxyTestResult {
  const a = first.result
  const b = second.result
  const geoSources = [first.source, second.source]
  const where = (result: ProxyTestResult) => [result.countryCode, result.city].filter(Boolean).join(' ')
  if (a.ip && b.ip && a.ip !== b.ip) {
    const geoConflict = `这个代理每个连接换一个出口 IP（轮换代理）：${a.ip}（${where(a) || '未知'}）、${b.ip}（${where(b) || '未知'}）`
    return {
      ...a,
      degraded: true,
      warning: `${geoConflict}；网站会看到 IP 在变，时区和语言也对不上。请在代理商后台改成固定会话（粘性 IP）`,
      geoConfidence: 'conflict',
      geoSources,
      geoConflict,
      rotating: true
    }
  }
  if (a.countryCode && b.countryCode && a.countryCode !== b.countryCode) {
    const geoConflict = `两个 IP 数据库判断的国家不同：${a.countryCode}（${first.source}）/ ${b.countryCode}（${second.source}）`
    return {
      ...a,
      degraded: true,
      warning: `${geoConflict}；时区、语言和地理位置可能对不上`,
      geoConfidence: 'conflict',
      geoSources,
      geoConflict
    }
  }
  const sameCity = Boolean(a.city && b.city && a.city.toLowerCase() === b.city.toLowerCase())
  return {
    ...a,
    countryCode: a.countryCode ?? b.countryCode,
    country: a.country ?? b.country,
    timezone: a.timezone ?? b.timezone,
    networkRisk: a.networkRisk ?? b.networkRisk,
    ...(sameCity ? {} : { city: undefined, region: undefined }),
    geoConfidence: 'consensus',
    geoSources
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error ?? '')
  const cause = (error as Error & { cause?: unknown }).cause
  return `${error.name} ${error.message} ${(error as NodeJS.ErrnoException).code ?? ''}${cause ? ` ${errorText(cause)}` : ''}`
}

/**
 * A plain reason for a failed check. The bridge answers the browser with proxy-chain's status
 * codes (593 not found, 594 refused, 595 reset, 597 auth, 599 upstream error), which undici
 * reports as "Proxy response (595) !== 200 when HTTP Tunneling".
 */
export function proxyFailureReason(text: string, viaLocalProxy: boolean, accelerated = false): string | undefined {
  if (/\b(407|597)\b|proxy authentication|authentication failed|auth failed/i.test(text)) return '代理认证失败，请检查用户名和密码'
  if (/\b593\b|ENOTFOUND|EAI_AGAIN/i.test(text)) return '找不到代理服务器，请检查地址是否填对'
  if (/\b594\b|ECONNREFUSED/i.test(text)) return '代理服务器拒绝连接，请检查端口是否填对，或代理是否已过期'
  if (/\b59[56]\b|ECONNRESET|EPIPE|socket hang up|Socket closed/i.test(text)) {
    if (accelerated) return '已经过网络加速，仍然连不上这个代理；请换一个加速节点，或检查代理是否可用'
    return viaLocalProxy
      ? '已经过本机代理，仍然连不上这个代理；请检查本机代理软件是否正常，或更换代理'
      : '连接被中断，本机网络连不上这个代理；国外代理请先开启本机代理软件（如 Clash）的系统代理'
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) {
    return viaLocalProxy || accelerated
      ? '代理连接超时，请检查线路或更换代理'
      : '代理连接超时；国外代理请先开启本机代理软件（如 Clash）的系统代理，或更换代理'
  }
  if (/\b(590|592|599)\b/.test(text)) return '代理服务器打不开检测网站，可能已过期或限制了访问'
  return undefined
}

export function classifyProxyFailure(error: unknown): NonNullable<ProxyTestResult['failureKind']> {
  const text = error instanceof Error ? `${error.name} ${error.message} ${(error as NodeJS.ErrnoException).code ?? ''}` : String(error)
  if (/\b(407|597)\b|proxy authentication|authentication failed|auth failed|auth required|credentials/i.test(text)) return 'authentication'
  if (/timeout|timed out|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT/i.test(text)) return 'timeout'
  if (/\b59\d\b|ECONN|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|socket|connect|TLS|certificate/i.test(text)) return 'connection'
  return 'unknown'
}

/** A service answered but not usefully (rate limit, error page): ask another one. */
class SiteError extends Error {}

async function lookupJson<T>(url: string, dispatcher: ProxyAgent | undefined, signal: AbortSignal): Promise<T> {
  const response = await request(url, {
    dispatcher,
    method: 'GET',
    signal,
    headers: { accept: 'application/json', 'user-agent': 'Prism-Browser/0.1' },
    headersTimeout: LOOKUP_TIMEOUT_MS,
    bodyTimeout: LOOKUP_TIMEOUT_MS
  })
  if (response.statusCode !== 200) {
    await response.body.dump().catch(() => undefined)
    throw new SiteError(`检测服务返回 HTTP ${response.statusCode}`)
  }
  try {
    return await response.body.json() as T
  } catch {
    throw new SiteError('检测服务返回的不是 JSON')
  }
}

const isSiteProblem = (error: unknown) => error instanceof SiteError || /timeout|timed out|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(errorText(error))

/**
 * Two answers from different services, picked at random; a service that fails is replaced by the
 * next. A failure of the proxy itself (refused, reset, authentication) ends the search at once.
 */
export async function geoAnswers(dispatcher: ProxyAgent | undefined, signal: AbortSignal, startedAt: number, sources = GEO_SOURCES): Promise<{ answers: GeoAnswer[]; failures: string[] }> {
  const order = [...sources].sort(() => Math.random() - 0.5)
  const answers: GeoAnswer[] = []
  const failures: string[] = []
  let next = 0
  let fatal: unknown
  const worker = async () => {
    while (answers.length < 2 && next < order.length && fatal === undefined && !signal.aborted) {
      const source = order[next++]
      try {
        const data = await lookupJson<Json>(source.url, dispatcher, signal)
        let result: ProxyTestResult
        try {
          result = source.parse(data, Date.now() - startedAt)
        } catch (error) {
          throw new SiteError(error instanceof Error ? error.message : String(error))
        }
        answers.push({ source: source.name, result })
      } catch (error) {
        if (signal.aborted) return
        if (!isSiteProblem(error)) { fatal ??= error; return }
        failures.push(`${source.name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  await Promise.all([worker(), worker()])
  if (fatal !== undefined && !answers.length) throw fatal
  return { answers, failures }
}

async function testProxyOnce(config: ProxyConfig, direct: boolean, signal: AbortSignal): Promise<ProxyTestResult> {
  const startedAt = Date.now()
  let localProxy: string | undefined
  let dispatcher: ProxyAgent | undefined
  try {
    localProxy = await openProxyBridge(config, {}, { direct })
    dispatcher = localProxy ? new ProxyAgent(localProxy) : undefined
    const { answers, failures } = await geoAnswers(dispatcher, signal, startedAt)
    if (answers.length >= 2) return { ...mergeGeoLookups(answers[0], answers[1]), latencyMs: answers[0].result.latencyMs }
    if (answers.length === 1) {
      return {
        ...answers[0].result,
        degraded: true,
        warning: `只有 ${answers[0].source} 查到了地理信息，没能用第二个网站核对（${failures.join('；') || '其他网站没有回应'}）；IP 和国家一般没问题`,
        geoConfidence: 'single-source',
        geoSources: [answers[0].source]
      }
    }
    if (signal.aborted) throw new Error('deadline')
    try {
      const data = await lookupJson<{ ip?: string }>(IP_CHECK_URL, dispatcher, signal)
      const ipVersion = isIP(data.ip ?? '')
      if (!data.ip || (ipVersion !== 4 && ipVersion !== 6)) throw new Error('IP 检测结果无效')
      return {
        ok: true,
        ip: data.ip,
        ipVersion,
        latencyMs: Date.now() - startedAt,
        degraded: true,
        warning: `地理信息暂不可用：${failures.join('；')}`,
        geoConfidence: 'single-source',
        geoSources: []
      }
    } catch (ipError) {
      throw new AggregateError([...failures.map((failure) => new Error(failure)), ipError], '代理出口检测失败')
    }
  } catch (error) {
    if (signal.aborted) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `代理 ${PROXY_CHECK_DEADLINE_MS / 1000} 秒内没有响应：可能已过期、被限制访问，或线路太慢`,
        failureKind: 'timeout'
      }
    }
    const causes = error instanceof AggregateError ? error.errors : [error]
    const text = causes.map(errorText).join(' | ')
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: proxyFailureReason(text, !direct && Boolean(await localProxyFor(config).catch(() => undefined)), config.tunnel?.enabled === true) ?? safeErrorText(error),
      failureKind: classifyProxyFailure(new Error(text))
    }
  } finally {
    await dispatcher?.destroy().catch(() => undefined)
    await closeProxyBridge(localProxy)
  }
}

/**
 * One check, finished within PROXY_CHECK_DEADLINE_MS: a proxy that does not work is reported
 * quickly, and the user checks again when they want to (no automatic re-runs).
 */
export async function testProxy(config: ProxyConfig, deadlineMs = PROXY_CHECK_DEADLINE_MS): Promise<ProxyTestResult> {
  const signal = AbortSignal.timeout(deadlineMs)
  // Every check (and so every launch) decides the route afresh.
  rememberDirectRoute(config, false)
  const via = await localProxyFor(config).catch(() => undefined)
  const first = await testProxyOnce(config, false, signal)
  if (first.ok || first.failureKind === 'authentication' || signal.aborted) return first
  // 网络加速 is the user's choice for this proxy: never fall back to this computer's own IP.
  if (via && !config.tunnel?.enabled) {
    // The system proxy could not reach this proxy (domestic proxies often refuse foreign
    // visitors): try the computer's own network in the time left.
    const direct = await testProxyOnce(config, true, signal)
    if (direct.ok) {
      rememberDirectRoute(config, true)
      return { ...direct, retried: true }
    }
  }
  return first
}
