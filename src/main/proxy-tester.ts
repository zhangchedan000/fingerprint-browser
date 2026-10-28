import { ProxyAgent, request } from 'undici'
import { isIP } from 'node:net'
import type { ProxyConfig, ProxyTestResult } from '../shared/types'
import { closeProxyBridge, localProxyFor, openProxyBridge, rememberDirectRoute } from './proxy-bridge'
import { safeErrorText } from './redaction'

const IP_CHECK_URL = 'https://api.ipify.org?format=json'
const GEO_CHECK_URL = 'https://ipwho.is/'
const SECONDARY_GEO_CHECK_URL = 'https://ipapi.co/json/'

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

export function mergeGeoLookups(primary: ProxyTestResult, secondary: ProxyTestResult): ProxyTestResult {
  const conflicts: string[] = []
  if (primary.ip && secondary.ip && primary.ip !== secondary.ip) {
    conflicts.push(`出口 IP：${primary.ip} / ${secondary.ip}`)
  }
  if (primary.countryCode && secondary.countryCode && primary.countryCode !== secondary.countryCode) {
    conflicts.push(`国家：${primary.countryCode} / ${secondary.countryCode}`)
  }
  if (primary.timezone && secondary.timezone && primary.timezone !== secondary.timezone) {
    conflicts.push(`时区：${primary.timezone} / ${secondary.timezone}`)
  }
  if (conflicts.length) {
    const geoConflict = `GeoIP 数据源冲突（${conflicts.join('；')}）`
    return {
      ...primary,
      degraded: true,
      warning: `${geoConflict}；继续使用可能影响时区、语言和地理位置的一致性，启动时将要求用户确认`,
      geoConfidence: 'conflict',
      geoSources: ['ipwho.is', 'ipapi.co'],
      geoConflict
    }
  }
  return {
    ...primary,
    geoConfidence: 'consensus',
    geoSources: ['ipwho.is', 'ipapi.co']
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

async function lookupJson<T>(url: string, dispatcher?: ProxyAgent): Promise<T> {
  const response = await request(url, {
    dispatcher,
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'Prism-Browser/0.1' },
    headersTimeout: 12_000,
    bodyTimeout: 12_000
  })
  if (response.statusCode !== 200) {
    await response.body.dump()
    throw new Error(`检测服务返回 HTTP ${response.statusCode}`)
  }
  return response.body.json() as Promise<T>
}

async function testProxyOnce(config: ProxyConfig, direct = false): Promise<ProxyTestResult> {
  const startedAt = Date.now()
  let localProxy: string | undefined
  let dispatcher: ProxyAgent | undefined
  try {
    localProxy = await openProxyBridge(config, {}, { direct })
    dispatcher = localProxy ? new ProxyAgent(localProxy) : undefined
    const lookups = await Promise.allSettled([
      lookupJson<GeoLookupResponse>(GEO_CHECK_URL, dispatcher),
      lookupJson<SecondaryGeoLookupResponse>(SECONDARY_GEO_CHECK_URL, dispatcher)
    ])
    const latencyMs = Date.now() - startedAt
    let primary: ProxyTestResult | undefined
    let secondary: ProxyTestResult | undefined
    let primaryError: unknown
    let secondaryError: unknown
    try {
      if (lookups[0].status === 'fulfilled') primary = parseGeoLookup(lookups[0].value, latencyMs)
      else primaryError = lookups[0].reason
    } catch (error) {
      primaryError = error
    }
    try {
      if (lookups[1].status === 'fulfilled') secondary = parseSecondaryGeoLookup(lookups[1].value, latencyMs)
      else secondaryError = lookups[1].reason
    } catch (error) {
      secondaryError = error
    }
    if (primary && secondary) return mergeGeoLookups(primary, secondary)
    if (primary || secondary) {
      const result = primary ?? secondary!
      const source = primary ? 'ipwho.is' : 'ipapi.co'
      const failed = primary ? secondaryError : primaryError
      return {
        ...result,
        degraded: true,
        warning: `仅 ${source} 返回有效地理信息，无法交叉确认：${failed instanceof Error ? failed.message : String(failed ?? '未知错误')}`,
        geoConfidence: 'single-source',
        geoSources: [source]
      }
    }
    try {
      const data = await lookupJson<{ ip?: string }>(IP_CHECK_URL, dispatcher)
      const ipVersion = isIP(data.ip ?? '')
      if (!data.ip || (ipVersion !== 4 && ipVersion !== 6)) throw new Error('IP 检测结果无效')
      return {
        ok: true,
        ip: data.ip,
        ipVersion,
        latencyMs: Date.now() - startedAt,
        degraded: true,
        warning: `地理信息暂不可用：${[primaryError, secondaryError].map((error) => error instanceof Error ? error.message : String(error ?? '')).filter(Boolean).join('；')}`,
        geoConfidence: 'single-source',
        geoSources: []
      }
    } catch (ipError) {
      throw new AggregateError([primaryError, secondaryError, ipError], '代理出口检测失败')
    }
  } catch (error) {
    const causes = error instanceof AggregateError ? error.errors : [error]
    const text = causes.map(errorText).join(' | ')
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: proxyFailureReason(text, !direct && Boolean(await localProxyFor(config).catch(() => undefined)), config.tunnel?.enabled === true) ?? safeErrorText(error),
      failureKind: classifyProxyFailure(new Error(text))
    }
  } finally {
    await dispatcher?.close().catch(() => undefined)
    await closeProxyBridge(localProxy)
  }
}

export async function testProxy(config: ProxyConfig): Promise<ProxyTestResult> {
  // Every check (and so every launch) decides the route afresh.
  rememberDirectRoute(config, false)
  const via = await localProxyFor(config).catch(() => undefined)
  const first = await testProxyOnce(config)
  if (first.ok || first.failureKind === 'authentication') return first
  // 网络加速 is the user's choice for this proxy: never fall back to this computer's own IP.
  if (via && !config.tunnel?.enabled) {
    // The tunnel or system proxy could not reach this proxy (some nodes block other proxies' ports,
    // and domestic proxies often refuse foreign visitors): try the computer's own network.
    const direct = await testProxyOnce(config, true)
    if (direct.ok) {
      rememberDirectRoute(config, true)
      return { ...direct, retried: true, latencyMs: first.latencyMs + direct.latencyMs }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  const second = await testProxyOnce(config)
  return { ...second, retried: true, latencyMs: first.latencyMs + second.latencyMs + 250 }
}
