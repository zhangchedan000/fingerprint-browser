import { describe, expect, it } from 'vitest'
import { autoMediaDevices, effectiveMediaDevices, isLaptopGpu, isMediaDevicesChoice, legacyAutoMediaDevices, MEDIA_SETUPS } from './media-devices'

describe('media devices', () => {
  it('keeps one set per seed, from the usual setups of the card\'s tier', () => {
    expect(autoMediaDevices(42, 'NVIDIA GeForce RTX 3050')).toBe(autoMediaDevices(42, 'NVIDIA GeForce RTX 3050'))
    const tiers: Array<[string, string[]]> = [
      ['NVIDIA GeForce RTX 3050', ['0,1,0', '1,1,0']],
      ['NVIDIA GeForce RTX 3060', ['1,1,0', '1,2,0']],
      ['NVIDIA GeForce RTX 4070', ['1,2,0', '1,1,1']],
      ['NVIDIA GeForce RTX 4090', ['1,2,0', '2,2,1']]
    ]
    for (const [model, usual] of tiers) {
      const sets = new Set(Array.from({ length: 400 }, (_, seed) => autoMediaDevices(seed, model)))
      expect([...sets].sort()).toEqual([...usual].sort())
    }
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

  it('gives a laptop card its built-in microphone, speakers and webcam', () => {
    expect(isLaptopGpu('NVIDIA GeForce RTX 4060 Laptop GPU')).toBe(true)
    expect(isLaptopGpu('NVIDIA GeForce RTX 4060')).toBe(false)
    expect(autoMediaDevices(7, 'NVIDIA GeForce RTX 4060 Laptop GPU')).toBe('1,1,1')
  })

  it('passes a chosen set, nothing for the real devices', () => {
    expect(effectiveMediaDevices('2,1,1', 1)).toBe('2,1,1')
    expect(effectiveMediaDevices('real', 1)).toBeUndefined()
    expect(effectiveMediaDevices(undefined, 7)).toBe(autoMediaDevices(7))
    expect(effectiveMediaDevices(undefined, 7, 'RTX 4060 Laptop GPU')).toBe(autoMediaDevices(7, 'RTX 4060 Laptop GPU'))
    expect(isMediaDevicesChoice('4,1,1')).toBe(false)
  })
})
