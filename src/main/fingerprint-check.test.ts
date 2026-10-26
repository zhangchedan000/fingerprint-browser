import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from '../shared/defaults'
import { gpuKey, kernelGpuList } from '../shared/gpu-catalog'
import type { FingerprintConfig, FingerprintObserved } from '../shared/types'
import { evaluateFingerprint, type ExpectedIdentity } from './fingerprint-check'

const engine = { version: 'prism-156.0.8078.47', fingerprintKernel: true }
const RTX4060 = kernelGpuList(engine.version, 'windows')!.find((gpu) => gpu.deviceId === '0x00002882')!

// What a Windows window reports (values in the shape a real run records).
const seen: FingerprintObserved = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  uaPlatform: 'Windows',
  uaPlatformVersion: '15.0.0',
  cores: 8,
  memory: 8,
  screen: [1920, 1080],
  timezone: 'America/New_York',
  language: 'en-US',
  webdriver: false,
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer: RTX4060.renderer,
  canvas: ['f428e791afe1c303', 'f428e791afe1c303'],
  audio: ['1c7ac25dfccc08ad', '1c7ac25dfccc08ad'],
  clientrects: ['605b308cf3ea4254', '605b308cf3ea4254'],
  font: ['7144363bcb422e23', '7144363bcb422e23'],
  worker: { userAgent: '', cores: 8, language: 'en-US', timezone: 'America/New_York' },
  webrtcIps: []
}
seen.worker!.userAgent = seen.userAgent

const fp: FingerprintConfig = {
  ...defaultFingerprint(1111),
  platform: 'windows',
  platformVersion: '15.0.0',
  brand: 'Chrome',
  hardwareProfileId: 'windows-seeded-nvidia',
  gpu: gpuKey(RTX4060),
  hardwareConcurrency: 8,
  disabledSpoofing: []
}
const expected: ExpectedIdentity = { cores: 8, screen: [1920, 1080], timezone: 'America/New_York', language: 'en-US' }
const proxy = { ok: true, ip: '203.0.113.9', timezone: 'America/New_York', country: 'US' } as unknown as Record<string, unknown>

function check(overrides: { observed?: Partial<FingerprintObserved>; fingerprint?: Partial<FingerprintConfig>; others?: Parameters<typeof evaluateFingerprint>[0]['others']; proxy?: unknown } = {}) {
  return evaluateFingerprint({
    fingerprint: { ...fp, ...overrides.fingerprint },
    engine,
    observed: { ...seen, ...overrides.observed },
    expected,
    proxy: (overrides.proxy ?? proxy) as Parameters<typeof evaluateFingerprint>[0]['proxy'],
    usesProxy: true,
    others: overrides.others ?? []
  })
}
const row = (items: ReturnType<typeof check>, name: string) => items.filter((item) => item.row === name)

describe('fingerprint check verdicts', () => {
  it('is all green when the page matches the settings and the proxy', () => {
    const items = check()
    expect(items.filter((item) => item.status !== 'ok')).toEqual([])
    expect(row(items, 'gpu')[0].message).toContain('RTX 4060')
  })

  it('flags a time zone that does not match the proxy and offers to follow the IP', () => {
    const [item] = row(check({ proxy: { ...proxy, timezone: 'Europe/London' } }), 'timezone')
    expect(item).toMatchObject({ status: 'bad', fix: 'follow-ip' })
  })

  it('flags a WebRTC address other than the proxy exit', () => {
    const [item] = row(check({ observed: { webrtcIps: ['198.51.100.23', '203.0.113.9', 'abc.local'] } }), 'webrtc')
    expect(item).toMatchObject({ status: 'bad', fix: 'webrtc-replace' })
    expect(item.message).toContain('198.51.100.23')
    expect(item.message).not.toContain('203.0.113.9')
  })

  it('flags a GPU that differs from the chosen one, or does not fit the system', () => {
    expect(row(check({ observed: { webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)' } }), 'gpu')[0])
      .toMatchObject({ status: 'bad', fix: 'shuffle-gpu' })
    expect(row(check({ fingerprint: { gpu: undefined, disabledSpoofing: ['gpu'] }, observed: { webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' } }), 'gpu')[0])
      .toMatchObject({ status: 'bad' })
  })

  it('finds two windows with the same noise and offers a new set', () => {
    const items = check({ others: [{ label: '#2 shop', observed: seen, disabledSpoofing: [] }] })
    expect(row(items, 'canvas')[0]).toMatchObject({ status: 'bad', fix: 'reseed' })
    expect(row(items, 'canvas')[0].message).toContain('#2 shop')
  })

  it('treats a surface that changes between reads as detectable', () => {
    expect(row(check({ observed: { audio: ['aaaa', 'bbbb'] } }), 'audio')[0]).toMatchObject({ status: 'bad', fix: 'use-real' })
  })

  it('catches page and background thread disagreeing, and automation flags', () => {
    const items = check({ observed: { webdriver: true, worker: { ...seen.worker!, cores: 4 } } })
    const general = row(items, 'general').filter((item) => item.status === 'bad').map((item) => item.message).join(' ')
    expect(general).toContain('webdriver')
    expect(general).toContain('CPU 核数')
  })

  it('says when the page cannot fake the screen size and suggests the real one', () => {
    expect(row(check({ observed: { screen: [2560, 1440] } }), 'screen')[0]).toMatchObject({ status: 'bad', fix: 'use-real' })
  })
})
