import { describe, expect, it } from 'vitest'
import { DEFAULT_DEVICE_BINDING, defaultProfileDraft } from './defaults'

describe('device-bound sign-in default', () => {
  it('is off for now, and a new window still asks before its first opening', () => {
    expect(DEFAULT_DEVICE_BINDING).toBe('off')
    expect(defaultProfileDraft().fingerprint.deviceBinding).toBe('ask')
  })
})
