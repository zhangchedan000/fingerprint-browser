import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from './defaults'
import { normalizeUrl, validateProfileDraft } from './validation'

describe('profile validation', () => {
  it('accepts the draft of any index, 0 included (the proxy form reads IP 评分 with one)', () => {
    for (const index of [0, -3, 1, 2, 9, 100]) {
      const draft = defaultProfileDraft(index)
      expect(draft.color).toMatch(/^#[\da-f]{6}$/i)
      expect(() => validateProfileDraft(draft)).not.toThrow()
    }
  })

  it('normalizes start pages to HTTPS URLs', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/')
  })

  it('rejects non-web start page protocols', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow('HTTP 或 HTTPS')
  })

  it('rejects invalid proxy ports', () => {
    const draft = defaultProfileDraft()
    draft.proxy = { protocol: 'socks5', host: '127.0.0.1', port: 70000, username: '', password: '' }
    expect(() => validateProfileDraft(draft)).toThrow('代理端口')
  })

  it('normalizes DNS and IPv6 proxy hosts while rejecting pasted proxy URLs', () => {
    const dnsDraft = defaultProfileDraft()
    dnsDraft.proxy = { protocol: 'https', host: 'BÜCHER.example', port: 8443, username: '', password: '' }
    expect(validateProfileDraft(dnsDraft).proxy.host).toBe('xn--bcher-kva.example')

    const ipv6Draft = defaultProfileDraft()
    ipv6Draft.proxy = { protocol: 'socks5', host: '[2001:db8::15]', port: 1080, username: '', password: '' }
    expect(validateProfileDraft(ipv6Draft).proxy.host).toBe('2001:db8::15')

    const urlDraft = defaultProfileDraft()
    urlDraft.proxy = { protocol: 'http', host: 'http://proxy.example.com:8080', port: 8080, username: '', password: '' }
    expect(() => validateProfileDraft(urlDraft)).toThrow('只能填写主机名或 IP')
  })

  it('removes stale proxy endpoints and credentials when switching to direct mode', () => {
    const draft = defaultProfileDraft()
    draft.proxy = {
      protocol: 'direct',
      host: 'old-proxy.example.com',
      port: 8080,
      username: 'old-user',
      password: 'old-secret',
      passwordStored: true
    }
    expect(validateProfileDraft(draft).proxy).toEqual({
      protocol: 'direct',
      host: '',
      username: '',
      password: ''
    })
  })

  it('keeps fingerprint inputs stable', () => {
    const draft = defaultProfileDraft()
    draft.fingerprint.seed = 123456
    const result = validateProfileDraft(draft)
    expect(result.fingerprint.seed).toBe(123456)
  })

  it('normalizes every hardware field from a coherent preset', () => {
    const draft = defaultProfileDraft()
    draft.fingerprint.hardwareProfileId = 'windows-11-rtx4070'
    draft.fingerprint.platform = 'macos'
    draft.fingerprint.hardwareConcurrency = 2
    draft.fingerprint.screenWidth = 800
    const result = validateProfileDraft(draft)

    expect(result.fingerprint).toMatchObject({
      hardwareProfileId: 'windows-11-rtx4070',
      platform: 'windows',
      platformVersion: '19.0.0',
      hardwareConcurrency: 16,
      screenWidth: 2560,
      screenHeight: 1440
    })
  })

  it('rejects unknown hardware templates', () => {
    const draft = defaultProfileDraft()
    draft.fingerprint.hardwareProfileId = 'macos-impossible' as typeof draft.fingerprint.hardwareProfileId
    expect(() => validateProfileDraft(draft)).toThrow('硬件模板')
  })

  it('rejects malformed browser brand versions', () => {
    const draft = defaultProfileDraft()
    draft.fingerprint.brandVersion = 'Chrome 148'
    expect(() => validateProfileDraft(draft)).toThrow('品牌版本')
  })

  it('accepts an exact managed kernel version and rejects ambiguous versions', () => {
    const draft = defaultProfileDraft()
    draft.kernelVersion = ' 144.0.7559.132 '
    expect(validateProfileDraft(draft).kernelVersion).toBe('144.0.7559.132')
    draft.kernelVersion = '144'
    expect(() => validateProfileDraft(draft)).toThrow('绑定内核版本')
  })

  it('rejects invalid timezone and WebRTC values', () => {
    const timezoneDraft = defaultProfileDraft()
    timezoneDraft.fingerprint.timezone = 'Moon/Sea_of_Tranquility'
    expect(() => validateProfileDraft(timezoneDraft)).toThrow('IANA 时区')

    const webrtcDraft = defaultProfileDraft()
    webrtcDraft.fingerprint.webrtcPolicy = 'leaky' as typeof webrtcDraft.fingerprint.webrtcPolicy
    expect(() => validateProfileDraft(webrtcDraft)).toThrow('WebRTC')
  })

  it('rejects invalid network identity and exit policies', () => {
    const identityDraft = defaultProfileDraft()
    identityDraft.fingerprint.networkIdentityMode = 'random' as typeof identityDraft.fingerprint.networkIdentityMode
    expect(() => validateProfileDraft(identityDraft)).toThrow('网络身份')

    const exitDraft = defaultProfileDraft()
    exitDraft.fingerprint.proxyExitPolicy = 'ignore' as typeof exitDraft.fingerprint.proxyExitPolicy
    expect(() => validateProfileDraft(exitDraft)).toThrow('出口变化')
  })

  it('normalizes duplicate groups and tags', () => {
    const draft = defaultProfileDraft()
    draft.group = '  美国店铺  '
    draft.tags = [' 重点 ', '重点', '', '广告']
    const result = validateProfileDraft(draft)
    expect(result.group).toBe('美国店铺')
    expect(result.tags).toEqual(['重点', '广告'])
  })

  it('keeps each value of a seeded window; old fixed templates still own theirs', () => {
    const draft = defaultProfileDraft()
    const seeded = validateProfileDraft({ ...draft, fingerprint: { ...draft.fingerprint, screenWidth: 1280, screenHeight: 720, hardwareConcurrency: 12 } })
    expect(seeded.fingerprint).toMatchObject({ screenWidth: 1280, screenHeight: 720, hardwareConcurrency: 12 })

    const fixed = validateProfileDraft({
      ...draft,
      fingerprint: { ...draft.fingerprint, platform: 'windows', hardwareProfileId: 'windows-11-rtx4070', screenWidth: 1280, screenHeight: 720, hardwareConcurrency: 12 }
    })
    expect(fixed.fingerprint).toMatchObject({ screenWidth: 2560, screenHeight: 1440, hardwareConcurrency: 16 })
    const fixedHandSet = validateProfileDraft({
      ...draft,
      fingerprint: { ...draft.fingerprint, platform: 'windows', hardwareProfileId: 'windows-11-rtx4070', screenWidth: 1280, screenHeight: 720, overrides: ['screen', 'screen'] }
    })
    expect(fixedHandSet.fingerprint).toMatchObject({ screenWidth: 1280, screenHeight: 720, overrides: ['screen'] })
  })

  it('stores "real CPU cores" and leaves it out when not used', () => {
    const draft = defaultProfileDraft()
    expect(validateProfileDraft({ ...draft, fingerprint: { ...draft.fingerprint, coresSource: 'host' } }).fingerprint.coresSource).toBe('host')
    expect(validateProfileDraft({ ...draft, fingerprint: { ...draft.fingerprint, coresSource: 'profile' } }).fingerprint).not.toHaveProperty('coresSource')
  })

  it('validates the new site permission and screen options and omits defaults', () => {
    const draft = defaultProfileDraft()
    const chosen = validateProfileDraft({ ...draft, fingerprint: { ...draft.fingerprint, geolocationPermission: 'block', doNotTrack: 'on', screenSource: 'host' } })
    expect(chosen.fingerprint).toMatchObject({ geolocationPermission: 'block', doNotTrack: 'on', screenSource: 'host' })
    const defaults = validateProfileDraft({ ...draft, fingerprint: { ...draft.fingerprint, geolocationPermission: 'ask', doNotTrack: 'default', screenSource: 'profile' } })
    expect(defaults.fingerprint).not.toHaveProperty('geolocationPermission')
    expect(defaults.fingerprint).not.toHaveProperty('doNotTrack')
    expect(defaults.fingerprint).not.toHaveProperty('screenSource')
    expect(() => validateProfileDraft({ ...draft, fingerprint: { ...draft.fingerprint, geolocationPermission: 'maybe' as never } })).toThrow('地理位置')
    expect(() => validateProfileDraft({ ...draft, fingerprint: { ...draft.fingerprint, overrides: ['gpu' as never] } })).toThrow('自定义项')
    expect(() => validateProfileDraft({ ...draft, fingerprint: { ...draft.fingerprint, screenWidth: 9000, overrides: ['screen'] } })).toThrow('7680')
  })
})

describe('CPU model', () => {
  it('keeps a known desktop CPU and makes the core count its thread count', async () => {
    const { validateProfileDraft } = await import('./validation')
    const { defaultProfileDraft } = await import('./defaults')
    const draft = defaultProfileDraft()
    draft.fingerprint = { ...draft.fingerprint, cpu: 'Intel Core i5-12400F', hardwareConcurrency: 8 }
    const result = validateProfileDraft(draft)
    expect(result.fingerprint.cpu).toBe('Intel Core i5-12400F')
    expect(result.fingerprint.hardwareConcurrency).toBe(12)
    draft.fingerprint = { ...draft.fingerprint, cpu: 'Intel Core i9-99999K' }
    expect(() => validateProfileDraft(draft)).toThrow('CPU')
  })
})
