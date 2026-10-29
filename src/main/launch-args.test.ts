import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile, ProxyCheckSummary } from '../shared/types'
import { buildLaunchArgs, publicIpv4 } from './launch-args'
import { defaultHardwareProfileId } from '../shared/hardware-profiles'
import { savedFingerprint } from '../shared/network-identity'

const WINDOWS = { platform: 'windows' as const, hardwareProfileId: defaultHardwareProfileId('windows') }

function profile(fingerprint: Partial<BrowserProfile['fingerprint']> = {}): BrowserProfile {
  const draft = defaultProfileDraft()
  return {
    ...draft,
    fingerprint: { ...draft.fingerprint, screenWidth: 1920, screenHeight: 1080, ...fingerprint },
    id: 'p1', groupId: '', proxyId: '', serialNumber: 7, createdAt: '', updatedAt: '', favorite: false, status: 'closed'
  }
}

describe('launch arguments', () => {
  it('restores the native session without opening configured startup URLs again', () => {
    const saved = { ...profile(), startupMode: 'restore' as const, startUrls: ['https://configured.example/'] }
    const restored = buildLaunchArgs(saved, { userDataDir: '/data' })
    expect(restored).toContain('--restore-last-session')
    expect(restored).not.toContain(saved.startUrls[0])
    const urls = buildLaunchArgs({ ...saved, startupMode: 'urls' }, { userDataDir: '/data' })
    expect(urls).not.toContain('--restore-last-session')
    expect(urls).toContain(saved.startUrls[0])
    // Nothing to restore yet (the window's first opening here): its start pages instead.
    const first = buildLaunchArgs(saved, { userDataDir: '/data', firstOpen: true })
    expect(first).not.toContain('--restore-last-session')
    expect(first).toContain(saved.startUrls[0])
  })
  it('passes device memory only when the window sets it', () => {
    expect(buildLaunchArgs(profile(), { userDataDir: '/data' }).some((arg) => arg.startsWith('--fingerprint-device-memory'))).toBe(false)
    expect(buildLaunchArgs(profile({ deviceMemory: 4 }), { userDataDir: '/data' })).toContain('--fingerprint-device-memory=4')
  })

  it('uses the computer\'s screen while the kernel cannot change the resolution', () => {
    const args = buildLaunchArgs(profile(), { userDataDir: '/data', hostScreen: { width: 2560, height: 1440 } })
    expect(args).toContain('--fingerprint-screen-width=2560')
    expect(args).toContain('--fingerprint-screen-height=1440')
  })

  it('falls back to the stored size when the display size is unknown', () => {
    const args = buildLaunchArgs(profile({ screenSource: 'host' }), { userDataDir: '/data' })
    expect(args).toContain('--fingerprint-screen-width=1920')
  })

  it('lets the kernel pick its default window size unless the window has a fixed size', () => {
    const auto = buildLaunchArgs(profile(), { userDataDir: '/data', hostScreen: { width: 2560, height: 1440 } })
    expect(auto.some((arg) => arg.startsWith('--window-size') || arg.startsWith('--window-position'))).toBe(false)
    const fixed = profile()
    fixed.window = { mode: 'custom', width: 1280, height: 800, x: 40, y: 30 }
    const args = buildLaunchArgs(fixed, { userDataDir: '/data' })
    expect(args).toContain('--window-size=1280,800')
    expect(args).toContain('--window-position=40,30')
  })

  it('names the GPU explicitly on our 156 kernel, with the real driver name and PCI ids', () => {
    const args = buildLaunchArgs(profile({ ...WINDOWS, gpu: 'NVIDIA GeForce RTX 3080 Ti|0x00002208', platformVersion: '10.0.0' }), {
      userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47'
    })
    expect(args).toContain('--fingerprint-gpu-vendor-id=0x10DE')
    expect(args).toContain('--fingerprint-gpu-device-id=0x00002208')
    expect(args).toContain('--fingerprint-gpu-description=NVIDIA GeForce RTX 3080 Ti')
    // The chosen Windows version is what Sec-CH-UA-Platform-Version reports.
    expect(args).toContain('--fingerprint-platform-version=10.0.0')
  })

  it('tells Prism kernels what the chosen card does with AV1', () => {
    const prism = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47' }
    const av1 = (gpu: string) => buildLaunchArgs(profile({ ...WINDOWS, gpu }), prism).filter((arg) => arg.startsWith('--fingerprint-gpu-av1'))
    expect(av1('NVIDIA GeForce RTX 2060|0x00001E89')).toEqual(['--fingerprint-gpu-av1=none'])
    expect(av1('NVIDIA GeForce RTX 3080 Ti|0x00002208')).toEqual(['--fingerprint-gpu-av1=decode'])
    expect(av1('NVIDIA GeForce RTX 4080|0x00002704')).toEqual(['--fingerprint-gpu-av1=encode'])
    expect(av1('NVIDIA GeForce RTX 5090|0x00002B85')).toEqual(['--fingerprint-gpu-av1=encode'])
    // The real card (GPU set to real): the computer's own codecs.
    const real = buildLaunchArgs(profile({ ...WINDOWS, gpu: 'NVIDIA GeForce RTX 2060|0x00001E89', disabledSpoofing: ['gpu'] }), prism)
    expect(real.some((arg) => arg.startsWith('--fingerprint-gpu-av1'))).toBe(false)
  })

  it('passes the keyboard layout of a Windows in the window\'s language', () => {
    const prism = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47' }
    const layout = (language: string) => {
      const arg = buildLaunchArgs(profile({ language }), prism).find((entry) => entry.startsWith('--fingerprint-keyboard-layout='))
      if (!arg) return undefined
      const text = Buffer.from(arg.slice('--fingerprint-keyboard-layout='.length), 'base64').toString('utf8')
      return Object.fromEntries(text.trim().split('\n').map((line) => line.split('\t')))
    }
    const german = layout('de-DE')
    expect(german?.KeyY).toBe('z')
    expect(german?.KeyZ).toBe('y')
    expect(german?.Semicolon).toBe('ö')
    expect(Object.keys(german ?? {})).toHaveLength(48)
    expect(layout('fr-FR')?.KeyQ).toBe('a')
    expect(layout('en-GB')?.Backslash).toBe('#')
    // Russian Windows also lists the US keyboard, the first one that types a-z.
    expect(layout('ru-RU')?.KeyQ).toBe('q')
    expect(layout('ja-JP')?.Backquote).toBe('半角/全角')
    expect(layout('pt-BR')?.IntlRo).toBe('/')
    expect(buildLaunchArgs(profile({ language: 'de-DE' }), { userDataDir: '/data' }).some((arg) => arg.startsWith('--fingerprint-keyboard-layout'))).toBe(false)
  })

  it('refuses a laptop or unknown GPU on the 156 kernel instead of showing another card', () => {
    expect(() => buildLaunchArgs(profile({ ...WINDOWS, gpu: 'NVIDIA GeForce RTX 4060 Laptop GPU|0x000028A0' }), {
      userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47'
    })).toThrow()
  })

  it('reports 16 or 32 GB only on kernels whose Chromium can', () => {
    const big = profile({ deviceMemory: 32 })
    expect(buildLaunchArgs(big, { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47' })).toContain('--fingerprint-device-memory=32')
    expect(buildLaunchArgs(big, { userDataDir: '/data', fingerprintKernel: true, engineVersion: '144.0.7559.132' })).toContain('--fingerprint-device-memory=8')
  })

  it('shows the public IPv4 proxy exit through WebRTC when set to 替换', () => {
    const check = (ip: string): ProxyCheckSummary => ({ ok: true, ip, latencyMs: 10, checkedAt: '' })
    const kernel = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47' }
    const args = buildLaunchArgs(profile({ webrtcPolicy: 'proxy_only' }), { ...kernel, proxyIdentity: check('203.45.6.7') })
    expect(args).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp')
    expect(args).toContain('--fingerprint-webrtc-ip=203.45.6.7')
    for (const ip of ['192.168.1.2', '10.0.0.1', '100.64.1.1', '2001:db8::1', 'bad']) {
      const blocked = buildLaunchArgs(profile({ webrtcPolicy: 'proxy_only' }), { ...kernel, proxyIdentity: check(ip) })
      expect(blocked).toContain('--disable-non-proxied-udp')
      expect(blocked.some((arg) => arg.startsWith('--fingerprint-webrtc-ip'))).toBe(false)
    }
    const other = buildLaunchArgs(profile({ webrtcPolicy: 'default' }), { ...kernel, proxyIdentity: check('203.45.6.7') })
    expect(other.some((arg) => arg.startsWith('--fingerprint-webrtc-ip') || arg.startsWith('--webrtc-ip-handling-policy'))).toBe(false)
    // 替换 with a proxy that relays UDP (prism7+): through the relay, no address replaced.
    const relayed = buildLaunchArgs(profile({ webrtcPolicy: 'proxy_only' }), { ...kernel, proxyIdentity: check('203.45.6.7'), webrtcRelaySupported: true, webrtcRelayPort: 40123 })
    expect(relayed).toContain('--fingerprint-webrtc-udp-relay=127.0.0.1:40123')
    expect(relayed).toContain('--webrtc-ip-handling-policy=default')
    expect(relayed.some((arg) => arg.startsWith('--fingerprint-webrtc-ip') || arg === '--disable-non-proxied-udp')).toBe(false)
    // 隐私: no address; 禁止: no WebRTC on prism7+, 隐私 on older kernels.
    const privacy = buildLaunchArgs(profile({ webrtcPolicy: 'privacy' }), { ...kernel, proxyIdentity: check('203.45.6.7') })
    expect(privacy).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp')
    expect(privacy.some((arg) => arg.startsWith('--fingerprint-webrtc-ip'))).toBe(false)
    expect(buildLaunchArgs(profile({ webrtcPolicy: 'disabled' }), { ...kernel, webrtcRelaySupported: true })).toContain('--fingerprint-webrtc-disabled')
    expect(buildLaunchArgs(profile({ webrtcPolicy: 'disabled' }), kernel)).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp')
    expect(publicIpv4(' 8.8.4.4 ')).toBe('8.8.4.4')
    expect(publicIpv4('172.20.0.1')).toBeUndefined()
    expect(publicIpv4('256.1.1.1')).toBeUndefined()
  })

  it('never shows the host fonts on kernels whose fonts follow the interface language', () => {
    const kernel = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47' }
    const real = profile({ disabledSpoofing: ['font'] })
    expect(buildLaunchArgs(real, kernel).some((arg) => arg.startsWith('--disable-spoofing=') && arg.includes('font'))).toBe(true)
    expect(buildLaunchArgs(real, { ...kernel, languageFonts: true }).some((arg) => arg.includes('font'))).toBe(false)
    const opened = buildLaunchArgs(profile({}), { ...kernel, extraUrls: ['https://iphey.com/'] })
    expect(opened.at(-1)).toBe('https://iphey.com/')
    const host = buildLaunchArgs(profile({ fontSource: 'host' }), { ...kernel, languageFonts: true })
    expect(host.some((arg) => arg.startsWith('--disable-spoofing=') && arg.includes('font'))).toBe(true)
  })

  it('launches with the UI locale Chrome resolves to and keeps the stored languages', () => {
    const mx = buildLaunchArgs(profile({ language: 'es-MX', acceptLanguages: 'es-MX,es,en-US,en' }), { userDataDir: '/data' })
    expect(mx).toContain('--lang=es-419')
    expect(mx).toContain('--accept-lang=es-MX,es,en-US,en')
    const hk = buildLaunchArgs(profile({ language: 'zh-HK', acceptLanguages: 'zh-HK,zh-TW,zh,en-US,en' }), { userDataDir: '/data' })
    expect(hk).toContain('--lang=zh-TW')
    const es = buildLaunchArgs(profile({ language: 'es-ES', acceptLanguages: 'es-ES,es' }), { userDataDir: '/data' })
    expect(es).toContain('--lang=es')
    expect(es).toContain('--accept-lang=es-ES,es')
    const chosen = buildLaunchArgs(profile({ language: 'de-DE', acceptLanguages: 'de-DE,de,en-US,en', uiLocale: 'en-US' }), { userDataDir: '/data' })
    expect(chosen).toContain('--lang=en-US')
    expect(chosen).toContain('--accept-lang=de-DE,de,en-US,en')
  })

  it('lets a Prism window claim a screen larger than the real one, never a smaller one', () => {
    const prism = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47', hostScreen: { width: 2560, height: 1440 } }
    const large = buildLaunchArgs(profile({ screenWidth: 3440, screenHeight: 1440 }), prism)
    expect(large).toContain('--fingerprint-screen-width=3440')
    expect(large).toContain('--fingerprint-screen-height=1440')
    const small = buildLaunchArgs(profile({ screenWidth: 1920, screenHeight: 1080 }), prism)
    expect(small).toContain('--fingerprint-screen-width=2560')
    expect(small).toContain('--fingerprint-screen-height=1440')
  })

  it('shows a 4K window the way Windows runs a 4K monitor: 150%, pages see 2560 × 1440', () => {
    const prism = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47', hostScreen: { width: 2560, height: 1440, taskbarHeight: 48 } }
    const window4k = profile({ ...WINDOWS, screenWidth: 3840, screenHeight: 2160 })
    window4k.window = { mode: 'custom', width: 1500, height: 1200, x: 30, y: 15 }
    const args = buildLaunchArgs(window4k, prism)
    expect(args).toContain('--force-device-scale-factor=1.5')
    expect(args).toContain('--fingerprint-screen-width=2560')
    expect(args).toContain('--fingerprint-screen-height=1440')
    expect(args).toContain('--fingerprint-screen-avail-height=1392')
    // The same place on this monitor in the larger CSS pixels.
    expect(args).toContain('--window-size=1000,800')
    expect(args).toContain('--window-position=20,10')
    // This computer's own 4K screen, and other kernels, stay as they are.
    const host4k = { ...prism, hostScreen: { width: 3840, height: 2160 } }
    expect(buildLaunchArgs(profile({ ...WINDOWS, screenSource: 'host' }), host4k).some((arg) => arg.startsWith('--force-device-scale-factor'))).toBe(false)
    expect(buildLaunchArgs(profile({ ...WINDOWS, screenWidth: 3840, screenHeight: 2160 }), { userDataDir: '/data' }).some((arg) => arg.startsWith('--force-device-scale-factor'))).toBe(false)
  })

  it('keeps a saved 基于 IP 生成 window on the country of its first check when the IP moves', () => {
    const geo = (ip: string, countryCode: string, timezone: string, latitude: number, longitude: number): ProxyCheckSummary => ({
      ok: true, ip, latencyMs: 10, checkedAt: '', countryCode, timezone, latitude, longitude, geoConfidence: 'consensus'
    })
    const firstCheck = geo('203.0.113.10', 'US', 'America/New_York', 40.7, -74)
    const saved = savedFingerprint({ ...profile().fingerprint, networkIdentityMode: 'proxy' }, firstCheck)
    expect(saved.networkIdentityMode).toBe('manual')
    expect(saved.region).toBe('US')
    // The proxy now exits in Mexico: the window still opens as the US one it was saved as.
    const args = buildLaunchArgs(profile(saved), {
      userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47',
      proxyIdentity: geo('198.51.100.40', 'MX', 'America/Mexico_City', 19.4, -99.1)
    })
    expect(args).toContain('--timezone=America/New_York')
    expect(args).toContain(`--fingerprint-language=${saved.language}`)
    expect(args.some((arg) => arg.includes('Mexico'))).toBe(false)
  })

  it('passes media devices and the kept voice and device-name languages to Prism kernels only', () => {
    const prism = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47' }
    const chosen = buildLaunchArgs(profile({ mediaDevices: '2,1,1', mediaLocale: 'de-de', voicesLocale: 'zh-hk' }), prism)
    expect(chosen).toContain('--fingerprint-media-devices=2,1,1')
    expect(chosen).toContain('--fingerprint-media-locale=de-de')
    expect(chosen).toContain('--fingerprint-voices-locale=zh-hk')
    const auto = buildLaunchArgs(profile(), prism)
    expect(auto.some((arg) => /^--fingerprint-media-devices=[0-3],[0-3],[0-3]$/.test(arg))).toBe(true)
    expect(auto.some((arg) => arg.startsWith('--fingerprint-voices-locale'))).toBe(false)
    expect(buildLaunchArgs(profile({ mediaDevices: 'real' }), prism).some((arg) => arg.startsWith('--fingerprint-media-devices'))).toBe(false)
    expect(buildLaunchArgs(profile({ mediaDevices: '2,1,1' }), { userDataDir: '/data' }).some((arg) => arg.startsWith('--fingerprint-media'))).toBe(false)
  })

  it('leaves room for this computer\'s taskbar in screen.availHeight', () => {
    const kernel = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47', windowScreen: true }
    const windows = profile({ platform: 'windows', screenWidth: 1920, screenHeight: 1080 })
    expect(buildLaunchArgs(windows, { ...kernel, hostScreen: { width: 2560, height: 1440, taskbarHeight: 48 } })).toContain('--fingerprint-screen-avail-height=1032')
    expect(buildLaunchArgs(windows, { ...kernel, hostScreen: { width: 2560, height: 1440, taskbarHeight: 0 } })).toContain('--fingerprint-screen-avail-height=1080')
    expect(buildLaunchArgs(windows, { ...kernel, hostScreen: { width: 2560, height: 1440 } }).some((arg) => arg.startsWith('--fingerprint-screen-avail-height'))).toBe(false)
  })

  it('gives each window its own audio and rects on prism7 unless set to real', () => {
    const kernel = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47' }
    const seeded = buildLaunchArgs(profile(), { ...kernel, seededAudioRects: true })
    expect(seeded).toContain('--fingerprinting-audio-noise')
    expect(seeded).toContain('--fingerprinting-client-rects-noise')
    const real = buildLaunchArgs(profile({ disabledSpoofing: ['audio', 'clientrects'] }), { ...kernel, seededAudioRects: true })
    expect(real.some((arg) => arg.startsWith('--fingerprinting-'))).toBe(false)
    expect(buildLaunchArgs(profile(), kernel).some((arg) => arg.startsWith('--fingerprinting-'))).toBe(false)
  })

  it('turns Chrome\'s port scan protection off only when asked', () => {
    const kernel = { userDataDir: '/data', fingerprintKernel: true, engineVersion: 'prism-156.0.8078.47' }
    expect(buildLaunchArgs(profile(), kernel).some((arg) => arg.startsWith('--disable-features'))).toBe(false)
    expect(buildLaunchArgs(profile({ portScanProtection: false }), kernel)).toContain('--disable-features=LocalNetworkAccessChecks')
  })
})
