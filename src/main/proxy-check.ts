import type { ProxyCheckSummary } from '../shared/types'

/** Accepts only a well-formed check result; anything else is dropped. */
export function safeProxyCheck(value: unknown): ProxyCheckSummary | undefined {
  if (!value || typeof value !== 'object') return undefined
  const check = value as Partial<ProxyCheckSummary>
  if (typeof check.ok !== 'boolean' || typeof check.latencyMs !== 'number' || typeof check.checkedAt !== 'string') return undefined
  if (Number.isNaN(Date.parse(check.checkedAt))) return undefined
  const risk = check.networkRisk === 'tor' || check.networkRisk === 'vpn' || check.networkRisk === 'proxy' || check.networkRisk === 'hosting'
    ? check.networkRisk
    : undefined
  return {
    ok: check.ok,
    ip: typeof check.ip === 'string' ? check.ip : undefined,
    latencyMs: Math.max(0, Math.round(check.latencyMs)),
    error: typeof check.error === 'string' ? check.error.slice(0, 500) : undefined,
    warning: typeof check.warning === 'string' ? check.warning.slice(0, 500) : undefined,
    degraded: check.degraded === true,
    country: typeof check.country === 'string' ? check.country : undefined,
    countryCode: typeof check.countryCode === 'string' ? check.countryCode : undefined,
    latitude: typeof check.latitude === 'number' && check.latitude >= -90 && check.latitude <= 90 ? check.latitude : undefined,
    longitude: typeof check.longitude === 'number' && check.longitude >= -180 && check.longitude <= 180 ? check.longitude : undefined,
    accuracyMeters: typeof check.accuracyMeters === 'number' && check.accuracyMeters > 0 ? check.accuracyMeters : undefined,
    ipVersion: check.ipVersion === 4 || check.ipVersion === 6 ? check.ipVersion : undefined,
    region: typeof check.region === 'string' ? check.region : undefined,
    city: typeof check.city === 'string' ? check.city : undefined,
    timezone: typeof check.timezone === 'string' ? check.timezone : undefined,
    asn: typeof check.asn === 'number' ? check.asn : undefined,
    organization: typeof check.organization === 'string' ? check.organization : undefined,
    isp: typeof check.isp === 'string' ? check.isp : undefined,
    networkRisk: risk,
    geoConfidence: check.geoConfidence === 'consensus' || check.geoConfidence === 'single-source' || check.geoConfidence === 'conflict'
      ? check.geoConfidence
      : undefined,
    geoSources: Array.isArray(check.geoSources)
      ? check.geoSources.filter((source): source is string => typeof source === 'string').slice(0, 5)
      : undefined,
    geoConflict: typeof check.geoConflict === 'string' ? check.geoConflict.slice(0, 500) : undefined,
    failureKind: ['authentication', 'timeout', 'connection', 'unknown'].includes(check.failureKind ?? '') ? check.failureKind : undefined,
    retried: check.retried === true,
    exitChanged: check.exitChanged === true,
    previousIp: typeof check.previousIp === 'string' ? check.previousIp : undefined,
    checkedAt: check.checkedAt
  }
}

/**
 * The check to store after a new test: marks an exit IP change against the baseline
 * (the IP the running window started with, or else the previous successful check).
 */
export function nextProxyCheck(check: ProxyCheckSummary, previous?: ProxyCheckSummary, baselineIp?: string): ProxyCheckSummary {
  const next = safeProxyCheck(check)
  if (!next) throw new Error('代理检测结果无效')
  const previousIp = baselineIp ?? (previous?.ok ? previous.ip : undefined)
  if (previousIp && next.ok && next.ip && previousIp !== next.ip) {
    next.exitChanged = true
    next.previousIp = previousIp
  } else {
    next.exitChanged = false
    next.previousIp = undefined
  }
  return next
}
