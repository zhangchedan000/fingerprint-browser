import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from './defaults'
import { acceptLanguageHeader, effectiveNetworkIdentity, hasCompleteProxyIdentity, localeForCountry, proxyLaunchError } from './network-identity'

describe('proxy-derived network identity', () => {
  it('maps common exit countries to realistic locale headers', () => {
    // A Japanese Chrome really sends "ja,en-US;q=0.9,en;q=0.8" (IDS_ACCEPT_LANGUAGES for ja).
    expect(localeForCountry('JP')).toEqual({ language: 'ja', acceptLanguages: 'ja,en-US,en', uiLocale: 'ja' })
    expect(localeForCountry('US')).toEqual({ language: 'en-US', acceptLanguages: 'en-US,en', uiLocale: 'en-US' })
    expect(localeForCountry('MX')).toEqual({ language: 'es-419', acceptLanguages: 'es-419,es', uiLocale: 'es-419' })
    expect(localeForCountry('AU')).toEqual({ language: 'en-GB', acceptLanguages: 'en-GB,en-US,en', uiLocale: 'en-GB' })
    expect(localeForCountry('DE')).toEqual({ language: 'de-DE', acceptLanguages: 'de-DE,de,en-US,en', uiLocale: 'de' })
    expect(localeForCountry('HK')).toEqual({ language: 'zh-TW', acceptLanguages: 'zh-TW,zh,en-US,en', uiLocale: 'zh-TW' })
    expect(localeForCountry('BR')?.uiLocale).toBe('pt-BR')
    expect(localeForCountry('AO')?.uiLocale).toBe('pt-PT')
  })

  it('uses verified proxy geography as one atomic identity', () => {
    const fingerprint = { ...defaultFingerprint(1), networkIdentityMode: 'proxy' as const }
    const identity = effectiveNetworkIdentity(fingerprint, {
      ok: true,
      latencyMs: 20,
      ip: '203.0.113.10',
      countryCode: 'JP',
      timezone: 'Asia/Tokyo',
      latitude: 35.6762,
      longitude: 139.6503
    })
    expect(identity).toMatchObject({
      source: 'proxy',
      language: 'ja',
      acceptLanguages: 'ja,en-US,en',
      uiLocale: 'ja',
      timezone: 'Asia/Tokyo',
      latitude: 35.6762,
      longitude: 139.6503
    })
  })

  it('keeps a manual identity unchanged', () => {
    const fingerprint = { ...defaultFingerprint(1), language: 'zh-CN', acceptLanguages: 'zh-CN,zh', timezone: 'Asia/Shanghai' }
    expect(effectiveNetworkIdentity(fingerprint, { ok: true, latencyMs: 1, countryCode: 'US', timezone: 'America/New_York' })).toMatchObject({
      source: 'manual', language: 'zh-CN', timezone: 'Asia/Shanghai'
    })
  })

  it('never creates a partially proxy-derived identity from degraded lookup data', () => {
    const fingerprint = { ...defaultFingerprint(1), networkIdentityMode: 'proxy' as const, language: 'zh-CN', acceptLanguages: 'zh-CN,zh', timezone: 'Asia/Shanghai' }
    const incomplete = { ok: true as const, latencyMs: 10, countryCode: 'US', timezone: 'America/New_York' }
    expect(hasCompleteProxyIdentity(incomplete)).toBe(false)
    expect(effectiveNetworkIdentity(fingerprint, incomplete)).toMatchObject({
      source: 'manual',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai'
    })
  })

  it('writes Accept-Language the way Chrome does', () => {
    expect(acceptLanguageHeader('en-US,en')).toBe('en-US,en;q=0.9')
    expect(acceptLanguageHeader('de-DE,de,en-US,en')).toBe('de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7')
    expect(acceptLanguageHeader('a,b,c,d,e,f,g,h,i,j,k,l')).toBe('a,b;q=0.9,c;q=0.8,d;q=0.7,e;q=0.6,f;q=0.5,g;q=0.4,h;q=0.3,i;q=0.2,j;q=0.1,k;q=0.1,l;q=0.1')
  })

  it('starts new windows in the United States', () => {
    expect(defaultFingerprint(1)).toMatchObject({ networkIdentityMode: 'manual', region: 'US', language: 'en-US', acceptLanguages: 'en-US,en', timezone: 'America/New_York' })
  })

  it('reports the IP time zone the way Windows Chrome does', () => {
    const lookup = { ok: true as const, latencyMs: 5, ip: '198.51.100.7', countryCode: 'US', timezone: 'America/Detroit', latitude: 42.33, longitude: -83.05 }
    const windows = { ...defaultFingerprint(1), platform: 'windows' as const, networkIdentityMode: 'proxy' as const }
    expect(effectiveNetworkIdentity(windows, lookup).timezone).toBe('America/New_York')
    expect(effectiveNetworkIdentity({ ...windows, platform: 'macos' }, lookup).timezone).toBe('America/Detroit')
  })

  it('rejects automatic identity when GeoIP providers disagree', () => {
    const fingerprint = { ...defaultFingerprint(1), networkIdentityMode: 'proxy' as const }
    const conflict = {
      ok: true as const,
      latencyMs: 10,
      ip: '104.251.237.13',
      countryCode: 'JP',
      timezone: 'Asia/Tokyo',
      latitude: 35.68,
      longitude: 139.76,
      geoConfidence: 'conflict' as const
    }
    expect(hasCompleteProxyIdentity(conflict)).toBe(false)
    expect(effectiveNetworkIdentity(fingerprint, conflict).source).toBe('manual')
    expect(hasCompleteProxyIdentity(conflict, { allowGeoConflict: true })).toBe(true)
    expect(effectiveNetworkIdentity(fingerprint, conflict, { allowGeoConflict: true })).toMatchObject({
      source: 'proxy',
      language: 'ja',
      timezone: 'Asia/Tokyo',
      latitude: 35.68,
      longitude: 139.76
    })
  })

  it('blocks authentication failures and changed exits under strict policy', () => {
    expect(proxyLaunchError({ ok: false, latencyMs: 1, failureKind: 'authentication' }, 'block')).toContain('认证失败')
    expect(proxyLaunchError({ ok: true, latencyMs: 1, ip: '2.2.2.2', previousIp: '1.1.1.1', exitChanged: true }, 'block')).toContain('出口已从')
    expect(proxyLaunchError({ ok: true, latencyMs: 1, exitChanged: true }, 'warn')).toBeUndefined()
  })
})
