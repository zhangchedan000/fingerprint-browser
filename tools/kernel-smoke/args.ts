// Launch arguments the app would use for a fresh window; bundled with esbuild by run.mjs.
import { buildLaunchArgs } from '../../src/main/launch-args'
import { defaultProfileDraft } from '../../src/shared/defaults'
import { validateProfileDraft } from '../../src/shared/validation'
import { applyHardwareProfile, defaultHardwareProfileId } from '../../src/shared/hardware-profiles'
export { openProxyBridge } from '../../src/main/proxy-bridge'
export { deepCheck } from '../../src/main/fingerprint-check'
import type { BrowserPlatform, BrowserProfile } from '../../src/shared/types'

export function smokeArgs(userDataDir: string, engineVersion: string, platform: BrowserPlatform, brand: 'Chrome' | 'Edge', proxyUrl?: string): string[] {
  const draft = defaultProfileDraft(1)
  draft.fingerprint = { ...applyHardwareProfile({ ...draft.fingerprint, platform }, defaultHardwareProfileId(platform), { refreshSeededGpu: true }), brand }
  const profile = { ...validateProfileDraft(draft), id: 'smoke', serialNumber: 1, groupId: '', proxyId: '', favorite: false, status: 'closed', createdAt: '', updatedAt: '' } as unknown as BrowserProfile
  return buildLaunchArgs(profile, { userDataDir, engineVersion, fingerprintKernel: true, hostHardwareConcurrency: 4, hostScreen: { width: 1920, height: 1080 }, proxyUrl })
    .filter((arg) => !/^https?:/.test(arg))
}

/** The same fresh window as smokeArgs, as a profile object (for the deep check). */
export function smokeProfile(platform: BrowserPlatform, brand: 'Chrome' | 'Edge'): BrowserProfile {
  const draft = defaultProfileDraft(1)
  draft.fingerprint = { ...applyHardwareProfile({ ...draft.fingerprint, platform }, defaultHardwareProfileId(platform), { refreshSeededGpu: true }), brand }
  return { ...validateProfileDraft(draft), id: 'smoke', serialNumber: 1, groupId: '', proxyId: '', proxy: { protocol: 'direct', host: '', username: '', password: '' }, favorite: false, status: 'closed', createdAt: '', updatedAt: '' } as unknown as BrowserProfile
}
