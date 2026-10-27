import type { BrowserProfile, ProxyCheckSummary } from '../shared/types'
import { effectiveDisabledSpoofing, effectiveFingerprintSeed, effectiveGpu } from '../shared/hardware-profiles'
import { GPU_VENDOR_IDS, kernelTakesExplicitGpu, maxDeviceMemoryGb } from '../shared/kernel-capabilities'
import { hardwareProfile } from '../shared/hardware-profiles'
import { resolveFingerprintBrandVersion } from '../shared/fingerprint-consistency'
import { chromeAcceptLanguages, effectiveNetworkIdentity } from '../shared/network-identity'
import { effectiveScreen } from '../shared/screen'
import { effectiveMediaDevices } from '../shared/media-devices'
import { kernelVendor } from '../shared/kernel-id'

export interface HostScreen {
  width: number
  height: number
  /** Height of this computer's taskbar at the bottom (display size minus work area), in CSS pixels. */
  taskbarHeight?: number
}

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
  hostScreen?: HostScreen
  /** EngineStatus.windowScreen of the kernel this window runs. */
  windowScreen?: boolean
  /** EngineStatus.webrtcRelay of the kernel this window runs (prism6+). */
  webrtcRelaySupported?: boolean
  /** prism6+ (released with the WebRTC relay): fonts follow the interface language, never the host's. */
  languageFonts?: boolean
  /** Port of the window's WebRTC UDP relay (webrtc-relay.ts), when the proxy relays UDP. */
  webrtcRelayPort?: number
}

export function profileWindowName(profile: Pick<BrowserProfile, 'serialNumber' | 'name'>): string {
  const name = profile.name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '指纹浏览器环境'
  return `[${profile.serialNumber}] ${name}`
}

// Mirrors the kernel check: only a public IPv4 exit address is shown to pages.
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
  const disabledSpoofing = effectiveDisabledSpoofing(fp).filter((surface) => !(options.languageFonts && surface === 'font'))
  const brandVersion = resolveFingerprintBrandVersion(fp.brandVersion, {
    fingerprintKernel: options.fingerprintKernel === true,
    version: options.engineVersion
  })
  const networkIdentity = effectiveNetworkIdentity(fp, options.proxyIdentity, {
    allowGeoConflict: options.allowGeoConflict
  })
  const { width: screenWidth, height: screenHeight } = effectiveScreen(
    fp,
    options.fingerprintKernel ? options.engineVersion : undefined,
    options.hostScreen,
    options.windowScreen
  )
  const language = networkIdentity.language
  const acceptLanguages = chromeAcceptLanguages(language, networkIdentity.acceptLanguages)
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${fp.platform}`,
    `--fingerprint-brand=${fp.brand}`,
    `--fingerprint-hardware-concurrency=${hardwareConcurrency}`,
    `--fingerprint-screen-width=${screenWidth}`,
    `--fingerprint-screen-height=${screenHeight}`,
    `--fingerprint-language=${language}`,
    `--lang=${networkIdentity.uiLocale}`,
    `--accept-lang=${acceptLanguages}`,
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

  const explicitGpuKernel = options.fingerprintKernel === true && kernelTakesExplicitGpu(options.engineVersion)
  // On our own kernels a Windows profile reports the computer's real Windows version: fonts, the
  // taskbar height and system UI come from the real system, so claiming another version would not match.
  if (platformVersion && !(explicitGpuKernel && fp.platform === 'windows')) {
    args.push(`--fingerprint-platform-version=${platformVersion}`)
  }
  if (explicitGpuKernel && !disabledSpoofing.includes('gpu')) {
    const gpu = effectiveGpu(fp, options.engineVersion)
    const vendorId = gpu ? GPU_VENDOR_IDS[gpu.vendor] : undefined
    if (gpu?.deviceId && vendorId) {
      args.push(`--fingerprint-gpu-vendor-id=${vendorId}`)
      args.push(`--fingerprint-gpu-device-id=${gpu.deviceId}`)
      args.push(`--fingerprint-gpu-description=${gpu.model}`)
    }
  }
  if (brandVersion) args.push(`--fingerprint-brand-version=${brandVersion}`)
  if (fp.renderIdentityVersion !== undefined) {
    args.push(`--fingerprint-render-identity=v${fp.renderIdentityVersion}`)
  }
  if (networkIdentity.latitude !== undefined && networkIdentity.longitude !== undefined) {
    args.push(`--fingerprint-location=${networkIdentity.latitude},${networkIdentity.longitude},${networkIdentity.accuracyMeters ?? 25000}`)
  }
  if (fp.deviceMemory) {
    const memory = Math.min(fp.deviceMemory, maxDeviceMemoryGb(options.engineVersion))
    args.push(`--fingerprint-device-memory=${memory}`)
  }
  // screen.availHeight leaves room for the taskbar; the kernel assumes 48 (Windows 11 at any scale)
  // unless told this computer's own, which a small or auto-hidden taskbar changes.
  const taskbar = options.hostScreen?.taskbarHeight
  if (options.fingerprintKernel && fp.platform === 'windows' && taskbar !== undefined && Number.isInteger(taskbar) && taskbar >= 0 && taskbar <= 200) {
    args.push(`--fingerprint-screen-avail-height=${screenHeight - taskbar}`)
  }
  if (disabledSpoofing.length) args.push(`--disable-spoofing=${disabledSpoofing.join(',')}`)
  if (options.fingerprintKernel && kernelVendor(options.engineVersion) === 'prism') {
    // Prism 4+: media devices (patch 014). Their names and the speech voices (patch 012) follow --lang.
    const mediaDevices = effectiveMediaDevices(fp.mediaDevices, fp.seed >>> 0, effectiveGpu(fp, options.engineVersion)?.model)
    if (mediaDevices) args.push(`--fingerprint-media-devices=${mediaDevices}`)
  }
  if (fp.webrtcPolicy === 'proxy_only' && options.webrtcRelayPort) {
    // 替换 on prism6+ with a proxy that relays UDP: WebRTC really goes through the proxy.
    args.push('--webrtc-ip-handling-policy=default')
    args.push(`--fingerprint-webrtc-udp-relay=127.0.0.1:${options.webrtcRelayPort}`)
  } else if (fp.webrtcPolicy === 'proxy_only') {
    args.push('--disable-non-proxied-udp')
    args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp')
    // 替换 without UDP through the proxy: our kernels show the proxy's exit address to pages;
    // without a public IPv4 exit WebRTC simply stays blocked.
    const webrtcIp = publicIpv4(options.proxyIdentity?.ip)
    if (webrtcIp) args.push(`--fingerprint-webrtc-ip=${webrtcIp}`)
  } else if (fp.webrtcPolicy === 'privacy' || (fp.webrtcPolicy === 'disabled' && !options.webrtcRelaySupported)) {
    // 隐私 (and 禁止 on kernels that cannot remove WebRTC): no address reaches the page.
    args.push('--disable-non-proxied-udp')
    args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp')
  } else if (fp.webrtcPolicy === 'disabled') {
    args.push('--fingerprint-webrtc-disabled')
  }
  if (options.proxyUrl) {
    args.push('--disable-quic')
    args.push('--dns-prefetch-disable')
    args.push('--no-pings')
    args.push(`--proxy-server=${options.proxyUrl}`)
    args.push('--proxy-bypass-list=localhost;127.0.0.1')
  } else {
    // 直连 means this computer's own network: never the system proxy (Clash, v2rayN…) it may have on.
    args.push('--no-proxy-server')
  }
  if (options.remoteDebuggingPort) args.push(`--remote-debugging-port=${options.remoteDebuggingPort}`)
  if (options.extensionPaths?.length) args.push(`--load-extension=${options.extensionPaths.join(',')}`)
  if (profile.startupMode === 'restore') args.push('--restore-last-session')
  else args.push(...profile.startUrls)
  return args
}
