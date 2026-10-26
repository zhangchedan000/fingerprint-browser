import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile, ProxyCheckSummary, WebRtcPolicy } from '../shared/types'
import { buildLaunchArgs, publicIpv4 } from './launch-args'

function profile(webrtcPolicy: WebRtcPolicy, language = 'en-US', acceptLanguages = 'en-US,en'): BrowserProfile {
  const draft = defaultProfileDraft()
  return {
    ...draft,
    id: 'profile-1',
    serialNumber: 1,
    favorite: false,
    status: 'closed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    fingerprint: { ...draft.fingerprint, webrtcPolicy, language, acceptLanguages, networkIdentityMode: 'manual' }
  }
}

const check = (ip: string): ProxyCheckSummary => ({ ok: true, ip, latencyMs: 10, checkedAt: '2026-01-01T00:00:00.000Z' })

describe('launch arguments', () => {
  it('shows only the public IPv4 proxy exit through WebRTC in replace mode', () => {
    const args = buildLaunchArgs(profile('replace'), { userDataDir: 'data', proxyIdentity: check('203.45.6.7') })
    expect(args).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp')
    expect(args).toContain('--fingerprint-webrtc-ip=203.45.6.7')
  })

  it('falls back to leak protection without a usable exit address', () => {
    for (const ip of ['192.168.1.2', '10.0.0.1', '100.64.1.1', '2001:db8::1', 'bad']) {
      const args = buildLaunchArgs(profile('replace'), { userDataDir: 'data', proxyIdentity: check(ip) })
      expect(args).toContain('--disable-non-proxied-udp')
      expect(args.some((arg) => arg.startsWith('--fingerprint-webrtc-ip'))).toBe(false)
    }
    const blocked = buildLaunchArgs(profile('proxy_only'), { userDataDir: 'data', proxyIdentity: check('203.45.6.7') })
    expect(blocked.some((arg) => arg.startsWith('--fingerprint-webrtc-ip'))).toBe(false)
  })

  it('validates public IPv4 addresses', () => {
    expect(publicIpv4(' 8.8.4.4 ')).toBe('8.8.4.4')
    expect(publicIpv4('172.20.0.1')).toBeUndefined()
    expect(publicIpv4('256.1.1.1')).toBeUndefined()
  })

  it('launches with the UI locale Chrome resolves to', () => {
    const mx = buildLaunchArgs(profile('replace', 'es-MX', 'es-MX,es,en-US,en'), { userDataDir: 'data' })
    expect(mx).toContain('--lang=es-419')
    expect(mx).toContain('--fingerprint-language=es-419')
    expect(mx).toContain('--accept-lang=es-419,es,en-US,en')
    const hk = buildLaunchArgs(profile('replace', 'zh-HK', 'zh-HK,zh-TW,zh,en-US,en'), { userDataDir: 'data' })
    expect(hk).toContain('--lang=zh-TW')
    expect(hk).toContain('--accept-lang=zh-TW,zh,en-US,en')
    const es = buildLaunchArgs(profile('replace', 'es-ES', 'es-ES,es,en-US,en'), { userDataDir: 'data' })
    expect(es).toContain('--lang=es-ES')
    expect(es).toContain('--accept-lang=es-ES,es,en-US,en')
  })
})
