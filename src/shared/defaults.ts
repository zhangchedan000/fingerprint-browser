import { deviceName, macAddress } from './device-identity'
import { t } from './i18n'
import type { BrowserPlatform, FingerprintConfig, PlatformAccount, ProfileDraft, ProfileWindowConfig } from './types'
import { applyHardwareProfile, defaultHardwareProfileId } from './hardware-profiles'

export const PROFILE_COLORS = ['#5965e8', '#1d9a6c', '#d97706', '#d9506b', '#7c4dce', '#0784a8']

export function seedFromId(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function randomSeed(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
}

export function defaultPlatform(): BrowserPlatform {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'win32' ? 'windows' : 'macos'
  }
  return /Win/i.test(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent ?? '') ? 'windows' : 'macos'
}

/**
 * Canvas, AudioContext and ClientRects of a new window: this computer's real values (user 11-07).
 * Measured on Fingerprint.com (same IP, same hardware, only these changed): made-up values from the
 * noise scored anywhere from 0.005 to 0.32 depending on which values a seed happened to give, the real
 * ones 0.005–0.031 on every hardware set; windows with different hardware stayed different visitors
 * with identical canvas and audio, and noise did not keep same-hardware windows on one IP apart.
 * Each window can still turn the noise on in the editor (每个窗口不同).
 */
export const DEFAULT_REAL_SURFACES = ['canvas', 'audio', 'clientrects'] as const

export function defaultFingerprint(seed = randomSeed()): FingerprintConfig {
  const platform = defaultPlatform()
  const fingerprint: FingerprintConfig = {
    seed,
    hardwareProfileId: defaultHardwareProfileId(platform),
    platform,
    platformVersion: platform === 'windows' ? '19.0.0' : '15.0.0',
    brand: 'Chrome',
    brandVersion: '',
    hardwareConcurrency: 8,
    // A computer in the United States: Chrome's en-US interface and its Accept-Language
    // (IDS_ACCEPT_LANGUAGES), and the Windows Eastern zone. "Based on IP" is one choice away.
    language: 'en-US',
    acceptLanguages: 'en-US,en',
    timezone: 'America/New_York',
    region: 'US',
    webrtcPolicy: 'proxy_only',
    networkIdentityMode: 'manual',
    proxyExitPolicy: 'block',
    screenWidth: 1440,
    screenHeight: 900,
    disabledSpoofing: [...DEFAULT_REAL_SURFACES]
  }
  return {
    ...applyHardwareProfile(fingerprint, fingerprint.hardwareProfileId, { refreshSeededGpu: true }),
    deviceName: deviceName(seed, platform),
    macAddress: macAddress(seed, platform)
  }
}

export function defaultProfileWindow(): ProfileWindowConfig {
  return { mode: 'auto', x: 0, y: 0, width: 1200, height: 800 }
}

/**
 * What a new window's 「设备绑定登录」 shows in the editor and recommends in the dialog before its first
 * opening, until someone picks. 'off' (ordinary cookies, the common way) for now; 'on' once binding with
 * software keys kept in the window (prism18+) has proven itself on real accounts.
 */
export const DEFAULT_DEVICE_BINDING: 'on' | 'off' = 'off'

export function defaultProfileDraft(index = 1): ProfileDraft & { account: PlatformAccount } {
  return {
    name: t('环境 {0}', index),
    note: '',
    group: '',
    tags: [],
    extensionIds: [],
    // Any index gives a colour (the proxy form's check draft passes 0).
    color: PROFILE_COLORS[(((index - 1) % PROFILE_COLORS.length) + PROFILE_COLORS.length) % PROFILE_COLORS.length],
    startUrls: ['https://browserleaks.com/'],
    // New windows reopen the tabs they were closed with; the start page is still kept for "urls".
    startupMode: 'restore',
    kernelVersion: '',
    window: defaultProfileWindow(),
    proxy: {
      protocol: 'direct',
      host: '',
      username: '',
      password: ''
    },
    account: { platform: '', username: '', password: '' },
    // A new window asks before its first opening whether sign-ins may be bound to the device
    // (until then it shows DEFAULT_DEVICE_BINDING).
    fingerprint: { ...defaultFingerprint(), deviceBinding: 'ask' }
  }
}

/** What two window names are compared by: trimmed, case and width folded ("环境 1" = "环境１"). */
export function windowNameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}
