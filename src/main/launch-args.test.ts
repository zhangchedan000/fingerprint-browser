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

  it('uses the stored screen size by default', () => {
    const args = buildLaunchArgs(profile(), { userDataDir: '/data', hostScreen: { width: 2560, height: 1440 } })
    expect(args).toContain('--fingerprint-screen-width=1920')
    expect(args).toContain('--window-size=1920,1080')
  })

  it('follows the real display when the window is set to follow the computer', () => {
    const args = buildLaunchArgs(profile({ screenSource: 'host' }), { userDataDir: '/data', hostScreen: { width: 2560, height: 1440 } })
    expect(args).toContain('--fingerprint-screen-width=2560')
    expect(args).toContain('--fingerprint-screen-height=1440')
    expect(args).toContain('--window-size=2560,1440')
  })

  it('falls back to the stored size when the display size is unknown', () => {
    const args = buildLaunchArgs(profile({ screenSource: 'host' }), { userDataDir: '/data' })
    expect(args).toContain('--fingerprint-screen-width=1920')
  })
})
