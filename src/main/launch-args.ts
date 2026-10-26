import type { BrowserProfile, ProxyCheckSummary } from '../shared/types'
import { effectiveDisabledSpoofing, effectiveFingerprintSeed } from '../shared/hardware-profiles'
import { hardwareProfile } from '../shared/hardware-profiles'
import { resolveFingerprintBrandVersion } from '../shared/fingerprint-consistency'
import { chromeAcceptLanguages, chromeUiLocale, effectiveNetworkIdentity } from '../shared/network-identity'

export interface LaunchArgumentOptions {
  userDataDir: string
  proxyUrl?: string
  remoteDebuggingPort?: number
  extensionPaths?: string[]
  engineVersion?: string
  fingerprintKernel?: boolean
  hostHardwareConcurrency?: number
  hostPlatformVersion?: string
  proxyIdentity?: ProxyCheckSummary
  allowGeoConflict?: boolean
}

export function profileWindowName(profile: Pick<BrowserProfile, 'serialNumber' | 'name'>): string {
  const name = profile.name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Prism 环境'
  return `[${profile.serialNumber}] ${name}`
}

// Mirrors the kernel check: only a public IPv4 exit address is shown to pages;
// anything else leaves WebRTC in leak-protection mode.
export function publicIpv4(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return undefined
  const [a, b, c, d] = match.slice(1).map(Number)
  if ([a, b, c, d].some((part) => part > 255)) return undefined
  if (a === 0 || a === 10 || a === 127 || a >= 224) return undefined
  if (a === 100 && b >= 64 && b <= 127) return undefined
  if (a === 169 && b === 254) return undefined
  if (a === 172 && b >= 16 && b <= 31) return undefined
  if (a === 192 && b === 168) return undefined
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return undefined
  if (a === 198 && (b === 18 || b === 19)) return undefined
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return undefined
  return `${a}.${b}.${c}.${d}`
}

export function buildLaunchArgs(profile: BrowserProfile, options: LaunchArgumentOptions): string[] {
  const fp = profile.fingerprint
  const hardware = hardwareProfile(fp.hardwareProfileId)
  const hardwareConcurrency = hardware?.hostMatched && options.hostHardwareConcurrency
    ? options.hostHardwareConcurrency
    : fp.hardwareConcurrency
  const platformVersion = hardware?.hostMatched && options.hostPlatformVersion
    ? options.hostPlatformVersion
    : fp.platformVersion
  const seed = effectiveFingerprintSeed(fp)
  const disabledSpoofing = effectiveDisabledSpoofing(fp)
  const brandVersion = resolveFingerprintBrandVersion(fp.brandVersion, {
    fingerprintKernel: options.fingerprintKernel === true,
    version: options.engineVersion
  })
  const networkIdentity = effectiveNetworkIdentity(fp, options.proxyIdentity, {
    allowGeoConflict: options.allowGeoConflict
  })
  const language = chromeUiLocale(networkIdentity.language)
  const acceptLanguages = chromeAcceptLanguages(language, networkIdentity.acceptLanguages)
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${fp.platform}`,
    `--fingerprint-brand=${fp.brand}`,
    `--fingerprint-hardware-concurrency=${hardwareConcurrency}`,
    `--fingerprint-screen-width=${fp.screenWidth}`,
    `--fingerprint-screen-height=${fp.screenHeight}`,
    `--fingerprint-language=${language}`,
    `--lang=${language}`,
    `--accept-lang=${acceptLanguages}`,
    `--timezone=${networkIdentity.timezone}`,
    `--window-size=${profile.window.mode === 'custom' ? profile.window.width : fp.screenWidth},${profile.window.mode === 'custom' ? profile.window.height : fp.screenHeight}`,
    `--window-name=${profileWindowName(profile)}`,
    `--prism-profile-serial=${profile.serialNumber}`,
    `--prism-profile-id=${profile.id}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-background-networking',
    '--disable-component-update'
  ]

  if (profile.window.mode === 'custom') args.push(`--window-position=${profile.window.x},${profile.window.y}`)

  if (platformVersion) args.push(`--fingerprint-platform-version=${platformVersion}`)
  if (brandVersion) args.push(`--fingerprint-brand-version=${brandVersion}`)
  if (fp.renderIdentityVersion !== undefined) {
    args.push(`--fingerprint-render-identity=v${fp.renderIdentityVersion}`)
  }
  if (networkIdentity.latitude !== undefined && networkIdentity.longitude !== undefined) {
    args.push(`--fingerprint-location=${networkIdentity.latitude},${networkIdentity.longitude},${networkIdentity.accuracyMeters ?? 25000}`)
  }
  if (disabledSpoofing.length) args.push(`--disable-spoofing=${disabledSpoofing.join(',')}`)
  if (fp.webrtcPolicy === 'proxy_only' || fp.webrtcPolicy === 'replace') {
    args.push('--disable-non-proxied-udp')
    args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp')
    const webrtcIp = fp.webrtcPolicy === 'replace' ? publicIpv4(options.proxyIdentity?.ip) : undefined
    if (webrtcIp) args.push(`--fingerprint-webrtc-ip=${webrtcIp}`)
  } else if (fp.webrtcPolicy === 'public_only') {
    args.push('--webrtc-ip-handling-policy=default_public_interface_only')
  }
  if (options.proxyUrl) {
    args.push('--disable-quic')
    args.push('--dns-prefetch-disable')
    args.push('--no-pings')
    args.push(`--proxy-server=${options.proxyUrl}`)
    args.push('--proxy-bypass-list=localhost;127.0.0.1')
  }
  if (options.remoteDebuggingPort) args.push(`--remote-debugging-port=${options.remoteDebuggingPort}`)
  if (options.extensionPaths?.length) args.push(`--load-extension=${options.extensionPaths.join(',')}`)
  args.push(...profile.startUrls)
  return args
}
