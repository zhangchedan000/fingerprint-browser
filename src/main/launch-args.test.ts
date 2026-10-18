import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'
import { buildLaunchArgs } from './launch-args'

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
})
