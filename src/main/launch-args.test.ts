import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'
import { buildLaunchArgs } from './launch-args'
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
    // Windows version follows the computer on our kernels (fonts and taskbar are the real ones).
    expect(args.some((arg) => arg.startsWith('--fingerprint-platform-version'))).toBe(false)
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
})
