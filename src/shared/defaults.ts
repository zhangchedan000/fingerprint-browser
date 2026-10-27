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

export function defaultFingerprint(seed = randomSeed()): FingerprintConfig {
  const platform = defaultPlatform()
  const fingerprint: FingerprintConfig = {
    seed,
    hardwareProfileId: defaultHardwareProfileId(platform),
    platform,
    platformVersion: platform === 'windows' ? '10.0.0' : '15.0.0',
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
    disabledSpoofing: []
  }
  return {
    ...applyHardwareProfile(fingerprint, fingerprint.hardwareProfileId, { refreshSeededGpu: true }),
    deviceName: deviceName(seed, platform),
    macAddress: macAddress(seed)
  }
}

export function defaultProfileWindow(): ProfileWindowConfig {
  return { mode: 'auto', x: 0, y: 0, width: 1200, height: 800 }
}

export function defaultProfileDraft(index = 1): ProfileDraft & { account: PlatformAccount } {
  return {
    name: t('环境 {0}', index),
    note: '',
    group: '',
    tags: [],
    extensionIds: [],
    color: PROFILE_COLORS[(index - 1) % PROFILE_COLORS.length],
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
    fingerprint: defaultFingerprint()
  }
}
