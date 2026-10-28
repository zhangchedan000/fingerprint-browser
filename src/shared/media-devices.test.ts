import { describe, expect, it } from 'vitest'
import { autoMediaDevices, effectiveMediaDevices, isLaptopGpu, isMediaDevicesChoice, legacyAutoMediaDevices, MEDIA_SETUPS } from './media-devices'

describe('media devices', () => {
  it('starts every window on speakers and a USB headset', () => {
    for (const model of ['NVIDIA GeForce RTX 3050', 'NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 4060 Laptop GPU', undefined]) {
      const sets = new Set(Array.from({ length: 100 }, (_, seed) => autoMediaDevices(seed, model)))
      expect([...sets]).toEqual(['1,2,0'])
    }
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
