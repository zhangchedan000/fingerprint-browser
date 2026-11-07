import { describe, expect, it } from 'vitest'
import { DEFAULT_DEVICE_BINDING, defaultProfileDraft } from './defaults'

describe('device-bound sign-in default', () => {
  it('is off for now, and a new window still asks before its first opening', () => {
    expect(DEFAULT_DEVICE_BINDING).toBe('off')
    expect(defaultProfileDraft().fingerprint.deviceBinding).toBe('ask')
  })
})

describe('canvas, audio and ClientRects of a new window', () => {
  it('are the real values (11-07): no noise flags, GPU still a listed card', () => {
    const fp = defaultProfileDraft().fingerprint
    expect([...fp.disabledSpoofing].sort()).toEqual(['audio', 'canvas', 'clientrects'])
    expect(fp.disabledSpoofing).not.toContain('gpu')
  })
})
