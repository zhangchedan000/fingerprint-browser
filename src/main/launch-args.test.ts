import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile, ProxyCheckSummary } from '../shared/types'
import { buildLaunchArgs, publicIpv4 } from './launch-args'
import { defaultHardwareProfileId } from '../shared/hardware-profiles'

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
    const large = buildLaunchArgs(profile({ screenWidth: 3840, screenHeight: 2160 }), prism)
    expect(large).toContain('--fingerprint-screen-width=3840')
    expect(large).toContain('--fingerprint-screen-height=2160')
    const small = buildLaunchArgs(profile({ screenWidth: 1920, screenHeight: 1080 }), prism)
    expect(small).toContain('--fingerprint-screen-width=2560')
    expect(small).toContain('--fingerprint-screen-height=1440')
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
