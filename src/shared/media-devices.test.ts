import { describe, expect, it } from 'vitest'
import { autoMediaDevices, effectiveMediaDevices, isLaptopGpu, isMediaDevicesChoice, legacyAutoMediaDevices, MEDIA_SETUPS } from './media-devices'

describe('media devices', () => {
  it('starts windows on speakers and a USB headset, about one in ten also with a webcam, fixed by the seed', () => {
    const sets = Array.from({ length: 2000 }, (_, seed) => autoMediaDevices(seed * 7919 + 13))
    expect(new Set(sets)).toEqual(new Set(['1,2,0', '2,2,1']))
    const webcam = sets.filter((set) => set === '2,2,1').length / sets.length
    expect(webcam).toBeGreaterThan(0.07)
    expect(webcam).toBeLessThan(0.13)
    expect(autoMediaDevices(123456)).toBe(autoMediaDevices(123456))
    expect(autoMediaDevices(123456, 'NVIDIA GeForce RTX 4090')).toBe(autoMediaDevices(123456, 'NVIDIA GeForce RTX 3050'))
    expect(MEDIA_SETUPS.find((setup) => setup.set === '1,2,0')).toMatchObject({ microphones: 1, speakers: 1, headphones: 1, cameras: 0 })
    // Every set is one of the setups offered, each counted in full.
    for (const setup of MEDIA_SETUPS) {
      const [microphones, outputs, cameras] = setup.set.split(',').map(Number)
      expect(setup.microphones).toBe(microphones)
      expect(setup.speakers + setup.headphones).toBe(outputs)
      expect(setup.cameras).toBe(cameras)
    }
  })

  it('writes in the old rule\'s set for windows saved before it, unchanged', () => {
    const sets = Array.from({ length: 1000 }, (_, seed) => legacyAutoMediaDevices(seed, 'NVIDIA GeForce RTX 3060'))
    expect(sets.every((set) => set.startsWith('1,'))).toBe(true)
    expect(sets.filter((set) => set.startsWith('1,2,')).length).toBeGreaterThan(700)
  })

  it('tells laptop cards from desktop ones', () => {
    expect(isLaptopGpu('NVIDIA GeForce RTX 4060 Laptop GPU')).toBe(true)
    expect(isLaptopGpu('NVIDIA GeForce RTX 4060')).toBe(false)
  })

  it('passes a chosen set, nothing for the real devices', () => {
    expect(effectiveMediaDevices('2,1,1', 1)).toBe('2,1,1')
    expect(effectiveMediaDevices('real', 1)).toBeUndefined()
    expect(effectiveMediaDevices(undefined, 7)).toBe(autoMediaDevices(7))
    expect(effectiveMediaDevices(undefined, 7, 'RTX 4060 Laptop GPU')).toBe(autoMediaDevices(7, 'RTX 4060 Laptop GPU'))
    expect(isMediaDevicesChoice('4,1,1')).toBe(false)
  })
})
