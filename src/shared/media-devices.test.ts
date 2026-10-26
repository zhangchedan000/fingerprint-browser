import { describe, expect, it } from 'vitest'
import { autoMediaDevices, effectiveMediaDevices, isMediaDevicesChoice } from './media-devices'

describe('media devices', () => {
  it('keeps one set per seed, mostly a single microphone and speaker', () => {
    expect(autoMediaDevices(42)).toBe(autoMediaDevices(42))
    const sets = Array.from({ length: 1000 }, (_, seed) => autoMediaDevices(seed))
    const single = sets.filter((set) => set.startsWith('1,1,')).length
    expect(single).toBeGreaterThan(550)
    expect(sets.filter((set) => set.endsWith(',1')).length).toBeGreaterThan(250)
  })

  it('passes a chosen set, nothing for the real devices', () => {
    expect(effectiveMediaDevices('2,1,1', 1)).toBe('2,1,1')
    expect(effectiveMediaDevices('real', 1)).toBeUndefined()
    expect(effectiveMediaDevices(undefined, 7)).toBe(autoMediaDevices(7))
    expect(isMediaDevicesChoice('4,1,1')).toBe(false)
  })
})
