import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from './defaults'
import { effectiveNetworkIdentity, hasCompleteProxyIdentity, localeForCountry, proxyLaunchError } from './network-identity'

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
    const fingerprint = defaultFingerprint(1)
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

  it('keeps legacy manual identity unchanged', () => {
    const fingerprint = defaultFingerprint(1)
    fingerprint.networkIdentityMode = 'manual'
    expect(effectiveNetworkIdentity(fingerprint, { ok: true, latencyMs: 1, countryCode: 'US', timezone: 'America/New_York' })).toMatchObject({
      source: 'manual', language: 'zh-CN', timezone: 'Asia/Shanghai'
    })
  })

  it('never creates a partially proxy-derived identity from degraded lookup data', () => {
    const fingerprint = defaultFingerprint(1)
    const incomplete = { ok: true as const, latencyMs: 10, countryCode: 'US', timezone: 'America/New_York' }
    expect(hasCompleteProxyIdentity(incomplete)).toBe(false)
    expect(effectiveNetworkIdentity(fingerprint, incomplete)).toMatchObject({
      source: 'manual',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai'
    })
  })

  it('rejects automatic identity when GeoIP providers disagree', () => {
    const fingerprint = defaultFingerprint(1)
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
