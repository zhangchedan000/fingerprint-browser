import type { FingerprintConfig, ProxyTestResult } from './types'
import { chromeLanguageProfile, chromeUiLocaleFor, countryLanguage } from './chrome-languages'
import { windowsReportedZone } from './windows-time-zones'

export const GEOIP_CONFLICT_CONFIRMATION_PREFIX = '[PRISM_GEOIP_CONFLICT_CONFIRMATION_REQUIRED]'

export interface NetworkIdentityOptions {
  allowGeoConflict?: boolean
}

export interface NetworkIdentity {
  language: string
  acceptLanguages: string
  /** Chrome's interface language (--lang): chosen in the window, otherwise the one for `language`. */
  uiLocale: string
  timezone: string
  latitude?: number
  longitude?: number
  accuracyMeters?: number
  source: 'manual' | 'proxy'
}

/**
 * navigator.languages lists the window's language first, then the rest of Accept-Language without
 * repeats (Blink reports the accept list, and navigator.language is its first entry).
 */
export function chromeAcceptLanguages(language: string, acceptLanguages: string): string {
  const ordered = [language, ...acceptLanguages.split(',').map((entry) => entry.trim()).filter(Boolean)]
  return ordered.filter((entry, index) => ordered.findIndex((other) => other.toLowerCase() === entry.toLowerCase()) === index).join(',')
}

/**
 * What a Chrome installed in this country shows: the country's language (CLDR), the interface
 * language Chrome picks for it and that interface's default Accept-Language (chrome-languages.ts).
 */
export function localeForCountry(countryCode: string | undefined): { language: string; acceptLanguages: string; uiLocale: string } | undefined {
  const language = countryCode ? countryLanguage(countryCode) : undefined
  return language ? chromeLanguageProfile(language) : undefined
}

type CompleteProxyIdentity = ProxyTestResult & {
  ok: true
  ip: string
  countryCode: string
  timezone: string
  latitude: number
  longitude: number
}

export function hasCompleteProxyIdentity(
  check: ProxyTestResult | undefined,
  options: NetworkIdentityOptions = {}
): check is CompleteProxyIdentity {
  return Boolean(check?.ok
    && (check.geoConfidence !== 'conflict' || options.allowGeoConflict)
    && check.ip
    && check.countryCode
    && check.timezone
    && check.latitude !== undefined
    && check.longitude !== undefined)
}

export function effectiveNetworkIdentity(
  fingerprint: FingerprintConfig,
  check?: ProxyTestResult,
  options: NetworkIdentityOptions = {}
): NetworkIdentity {
  const fallback: NetworkIdentity = {
    language: fingerprint.language,
    acceptLanguages: fingerprint.acceptLanguages,
    uiLocale: fingerprint.uiLocale ?? chromeUiLocaleFor(fingerprint.language),
    timezone: fingerprint.timezone,
    source: 'manual'
  }
  if (fingerprint.networkIdentityMode !== 'proxy' || !hasCompleteProxyIdentity(check, options)) return fallback
  const locale = localeForCountry(check.countryCode)
  return {
    language: locale?.language ?? fallback.language,
    acceptLanguages: locale?.acceptLanguages ?? fallback.acceptLanguages,
    uiLocale: fingerprint.uiLocale ?? locale?.uiLocale ?? fallback.uiLocale,
    // Windows only has its own zones; Chrome there reports the id CLDR gives that zone in the country.
    timezone: (fingerprint.platform === 'windows' ? windowsReportedZone(check.timezone, check.countryCode) : undefined) ?? check.timezone,
    latitude: check.latitude,
    longitude: check.longitude,
    accuracyMeters: check.accuracyMeters,
    source: 'proxy'
  }
}

export function geoConflictConfirmationMessage(errorText: string): string | undefined {
  const marker = errorText.indexOf(GEOIP_CONFLICT_CONFIRMATION_PREFIX)
  if (marker < 0) return undefined
  return errorText.slice(marker + GEOIP_CONFLICT_CONFIRMATION_PREFIX.length).replace(/^\s*[:：]?\s*/, '')
}

export function proxyLaunchError(check: ProxyTestResult, exitPolicy: FingerprintConfig['proxyExitPolicy']): string | undefined {
  if (!check.ok) {
    if (check.failureKind === 'authentication') return '代理认证失败，请检查用户名和密码'
    if (check.failureKind === 'timeout') return '代理连接超时，请检查线路或更换代理'
    return `代理启动前检测失败：${check.error ?? '无法连接代理出口'}`
  }
  if (check.exitChanged && exitPolicy === 'block') {
    return `代理出口已从 ${check.previousIp ?? '原地址'} 变为 ${check.ip ?? '新地址'}；请确认后再次检测再启动`
  }
  return undefined
}
