import { describe, expect, it } from 'vitest'
import { autoMediaDevices, effectiveMediaDevices, isLaptopGpu, isMediaDevicesChoice } from './media-devices'

describe('media devices', () => {
  it('keeps one set per seed: a desktop has a microphone, mostly speakers and headphones, rarely a webcam', () => {
    expect(autoMediaDevices(42)).toBe(autoMediaDevices(42))
    const sets = Array.from({ length: 1000 }, (_, seed) => autoMediaDevices(seed, 'NVIDIA GeForce RTX 3060'))
    expect(sets.every((set) => set.startsWith('1,'))).toBe(true)
    expect(sets.filter((set) => set.startsWith('1,2,')).length).toBeGreaterThan(700)
    const cameras = sets.filter((set) => set.endsWith(',1')).length
    expect(cameras).toBeGreaterThan(80)
    expect(cameras).toBeLessThan(250)
  })

  it('gives a laptop card its built-in webcam', () => {
    expect(isLaptopGpu('NVIDIA GeForce RTX 4060 Laptop GPU')).toBe(true)
    expect(isLaptopGpu('NVIDIA GeForce RTX 4060')).toBe(false)
    const sets = Array.from({ length: 200 }, (_, seed) => autoMediaDevices(seed, 'NVIDIA GeForce RTX 4060 Laptop GPU'))
    expect(sets.every((set) => /^1,[12],1$/.test(set))).toBe(true)
  })

  it('passes a chosen set, nothing for the real devices', () => {
    expect(effectiveMediaDevices('2,1,1', 1)).toBe('2,1,1')
    expect(effectiveMediaDevices('real', 1)).toBeUndefined()
    expect(effectiveMediaDevices(undefined, 7)).toBe(autoMediaDevices(7))
    expect(effectiveMediaDevices(undefined, 7, 'RTX 4060 Laptop GPU')).toBe(autoMediaDevices(7, 'RTX 4060 Laptop GPU'))
    expect(isMediaDevicesChoice('4,1,1')).toBe(false)
  })
})
