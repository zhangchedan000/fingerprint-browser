import type { FingerprintConfig, ProxyTestResult } from './types'
import { chromeLanguageProfile, chromeUiLocaleFor, countryLanguage } from './chrome-languages'
import { windowsReportedZone } from './windows-time-zones'
import { voiceLocaleForLanguage } from './windows-voices'
import { autoMediaDevices, legacyAutoMediaDevices, mediaLocaleFor } from './media-devices'

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

/** The Accept-Language header Chrome sends for a list (net::HttpUtil::GenerateAcceptLanguageHeader). */
export function acceptLanguageHeader(languages: string): string {
  let q = 10
  return languages.split(',').map((entry) => entry.trim()).filter(Boolean).map((language) => {
    const item = q === 10 ? language : `${language};q=0.${q}`
    if (q > 1) q -= 1
    return item
  }).join(',')
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
    ...(fingerprint.location ? {
      latitude: fingerprint.location.latitude,
      longitude: fingerprint.location.longitude,
      accuracyMeters: fingerprint.location.accuracyMeters
    } : {}),
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

/**
 * The values a window keeps for a checked IP: its country, the time zone and languages for it and
 * its location. Once written into the window they stay; a later IP does not change them.
 * Undefined when the check cannot say (failed, conflicting, or a country without a known language).
 */
export function fixedIdentityForCheck(
  fingerprint: Pick<FingerprintConfig, 'platform' | 'uiLocale'>,
  check: ProxyTestResult | undefined,
  options: NetworkIdentityOptions & { followUiLocale?: boolean } = {}
): Partial<FingerprintConfig> | undefined {
  if (!check?.ok || !check.countryCode || !check.timezone || (check.geoConfidence === 'conflict' && !options.allowGeoConflict)) return undefined
  const countryCode = check.countryCode.toUpperCase()
  const locale = localeForCountry(countryCode)
  if (!locale) return undefined
  const timezone = (fingerprint.platform === 'windows' ? windowsReportedZone(check.timezone, countryCode) : undefined) ?? check.timezone
  return {
    networkIdentityMode: 'manual',
    region: countryCode,
    regionSource: 'ip',
    language: locale.language,
    acceptLanguages: locale.acceptLanguages,
    // The system language follows the browser language unless the window chose its own.
    uiLocale: options.followUiLocale ? undefined : fingerprint.uiLocale,
    timezone,
    location: check.latitude !== undefined && check.longitude !== undefined
      ? { latitude: check.latitude, longitude: check.longitude, ...(check.accuracyMeters ? { accuracyMeters: check.accuracyMeters } : {}) }
      : undefined
  }
}

/**
 * A saved window's fingerprint, with nothing left to work out at launch. A window that still
 * followed its proxy's IP keeps the values of its last check (基于 IP 生成), or else the ones it
 * had (手动选择); the system language, speech voices and device-name language that followed the
 * language are written in, so a later version of these tables cannot change a saved window.
 */
export function savedFingerprint(
  fingerprint: FingerprintConfig,
  check?: ProxyTestResult,
  options: { gpuModel?: string; legacy?: boolean } = {}
): FingerprintConfig {
  const next: FingerprintConfig = { ...fingerprint }
  if (next.networkIdentityMode === 'proxy') {
    const fixed = fixedIdentityForCheck(next, check)
    Object.assign(next, fixed ?? { networkIdentityMode: 'manual' })
    if (!fixed) delete next.regionSource
  }
  for (const key of Object.keys(next) as Array<keyof FingerprintConfig>) {
    if (next[key] === undefined) delete next[key]
  }
  const uiLocale = next.uiLocale ?? chromeUiLocaleFor(next.language)
  return {
    ...next,
    uiLocale,
    voicesLocale: next.voicesLocale ?? voiceLocaleForLanguage(uiLocale),
    mediaLocale: next.mediaLocale ?? mediaLocaleFor(uiLocale),
    // The devices that went with its GPU (windows saved before this rule: the set they always had).
    mediaDevices: next.mediaDevices ?? (options.legacy ? legacyAutoMediaDevices : autoMediaDevices)(next.seed >>> 0, options.gpuModel)
  }
}

/**
 * The editor's view of a saved fingerprint: values equal to what they would follow show as
 * following (跟随… / 自动), so changing the language or GPU moves them along; written in again on save.
 */
export function followingLocales(fingerprint: FingerprintConfig, gpuModel?: string): FingerprintConfig {
  const next: FingerprintConfig = { ...fingerprint }
  if (next.mediaDevices === autoMediaDevices(next.seed >>> 0, gpuModel)) delete next.mediaDevices
  const followedUi = chromeUiLocaleFor(next.language)
  if (next.uiLocale === followedUi) delete next.uiLocale
  const uiLocale = next.uiLocale ?? followedUi
  if (next.voicesLocale === voiceLocaleForLanguage(uiLocale)) delete next.voicesLocale
  if (next.mediaLocale === mediaLocaleFor(uiLocale)) delete next.mediaLocale
  return next
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
