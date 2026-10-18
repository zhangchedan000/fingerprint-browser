import type { BrowserProfile, ProxyCheckSummary } from '../shared/types'
import { effectiveDisabledSpoofing, effectiveFingerprintSeed } from '../shared/hardware-profiles'
import { hardwareProfile } from '../shared/hardware-profiles'
import { resolveFingerprintBrandVersion } from '../shared/fingerprint-consistency'
import { effectiveNetworkIdentity } from '../shared/network-identity'
import { effectiveScreenSource } from '../shared/screen'

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
  /** Real primary display size, used when the window follows the computer's screen. */
  hostScreen?: { width: number; height: number }
}

export function profileWindowName(profile: Pick<BrowserProfile, 'serialNumber' | 'name'>): string {
  const name = profile.name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '指纹浏览器环境'
  return `[${profile.serialNumber}] ${name}`
}

export function buildLaunchArgs(profile: BrowserProfile, options: LaunchArgumentOptions): string[] {
  const fp = profile.fingerprint
  const hardware = hardwareProfile(fp.hardwareProfileId)
  const hardwareConcurrency = (hardware?.hostMatched || fp.coresSource === 'host') && options.hostHardwareConcurrency
    ? options.hostHardwareConcurrency
    : fp.hardwareConcurrency
  const platformVersion = hardware?.hostMatched && options.hostPlatformVersion
    ? options.hostPlatformVersion
    : fp.platformVersion
  const alignedSeed = options.fingerprintKernel ? effectiveFingerprintSeed(fp, options.engineVersion) : fp.seed >>> 0
  if (alignedSeed === undefined) {
    // Checked before launch (assertFingerprintKernelCompatibility); never fall back to another card.
    throw new Error(`内核 ${options.engineVersion ?? ''} 没有这个窗口选的显卡，请在窗口设置里重新选择显卡`)
  }
  const seed = alignedSeed
  const disabledSpoofing = effectiveDisabledSpoofing(fp)
  const brandVersion = resolveFingerprintBrandVersion(fp.brandVersion, {
    fingerprintKernel: options.fingerprintKernel === true,
    version: options.engineVersion
  })
  const networkIdentity = effectiveNetworkIdentity(fp, options.proxyIdentity, {
    allowGeoConflict: options.allowGeoConflict
  })
  const followHost = effectiveScreenSource(fp) === 'host' && options.hostScreen
    && Number.isInteger(options.hostScreen.width) && Number.isInteger(options.hostScreen.height)
  const screenWidth = followHost ? options.hostScreen!.width : fp.screenWidth
  const screenHeight = followHost ? options.hostScreen!.height : fp.screenHeight
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${fp.platform}`,
    `--fingerprint-brand=${fp.brand}`,
    `--fingerprint-hardware-concurrency=${hardwareConcurrency}`,
    `--fingerprint-screen-width=${screenWidth}`,
    `--fingerprint-screen-height=${screenHeight}`,
    `--fingerprint-language=${networkIdentity.language}`,
    `--lang=${networkIdentity.language}`,
    `--accept-lang=${networkIdentity.acceptLanguages}`,
    `--timezone=${networkIdentity.timezone}`,
    `--window-name=${profileWindowName(profile)}`,
    `--prism-profile-serial=${profile.serialNumber}`,
    `--prism-profile-id=${profile.id}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-background-networking',
    '--disable-component-update'
  ]

  // Automatic size: no --window-size, so the kernel opens its own default window the way a
  // fresh Chrome does, and remembers the size the user drags it to.
  if (profile.window.mode === 'custom') {
    args.push(`--window-size=${profile.window.width},${profile.window.height}`)
    args.push(`--window-position=${profile.window.x},${profile.window.y}`)
  }

  if (platformVersion) args.push(`--fingerprint-platform-version=${platformVersion}`)
  if (brandVersion) args.push(`--fingerprint-brand-version=${brandVersion}`)
  if (fp.renderIdentityVersion !== undefined) {
    args.push(`--fingerprint-render-identity=v${fp.renderIdentityVersion}`)
  }
  if (networkIdentity.latitude !== undefined && networkIdentity.longitude !== undefined) {
    args.push(`--fingerprint-location=${networkIdentity.latitude},${networkIdentity.longitude},${networkIdentity.accuracyMeters ?? 25000}`)
  }
  if (fp.deviceMemory) args.push(`--fingerprint-device-memory=${fp.deviceMemory}`)
  if (disabledSpoofing.length) args.push(`--disable-spoofing=${disabledSpoofing.join(',')}`)
  if (fp.webrtcPolicy === 'proxy_only') {
    args.push('--disable-non-proxied-udp')
    args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp')
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
