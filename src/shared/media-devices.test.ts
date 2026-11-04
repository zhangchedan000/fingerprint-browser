import { describe, expect, it } from 'vitest'
import { autoMediaDevices, effectiveMediaDevices, isLaptopGpu, isMediaDevicesChoice, legacyAutoMediaDevices, MEDIA_SETUPS } from './media-devices'

describe('media devices', () => {
  it('gives most windows speakers and a USB headset; a few entry ones only one of them, a few high-end ones a webcam too', () => {
    const shares = (gpu: string) => {
      const sets = Array.from({ length: 4000 }, (_, seed) => autoMediaDevices(seed * 7919 + 13, gpu))
      const share = (set: string) => sets.filter((item) => item === set).length / sets.length
      return { usual: share('1,2,0'), headset: share('1,1,0'), speakers: share('0,1,0'), webcam: share('2,2,1') }
    }
    const entry = shares('NVIDIA GeForce RTX 3050')
    expect(entry.usual).toBeGreaterThan(0.75)
    expect(entry.headset).toBeGreaterThan(0.07)
    expect(entry.speakers).toBeGreaterThan(0.07)
    expect(entry.webcam).toBe(0)
    expect(shares('NVIDIA GeForce RTX 4060')).toEqual({ usual: 1, headset: 0, speakers: 0, webcam: 0 })
    for (const gpu of ['NVIDIA GeForce RTX 4070', 'NVIDIA GeForce RTX 4090']) {
      const high = shares(gpu)
      expect(high.usual).toBeGreaterThan(0.85)
      expect(high.webcam).toBeGreaterThan(0.07)
      expect(high.webcam).toBeLessThan(0.13)
      expect(high.headset + high.speakers).toBe(0)
    }
    expect(autoMediaDevices(5)).toBe('1,2,0')
    expect(autoMediaDevices(123456, 'NVIDIA GeForce RTX 4090')).toBe(autoMediaDevices(123456, 'NVIDIA GeForce RTX 4090'))
    // A webcam brings its own microphone; a headset a microphone and headphones; speakers no microphone.
    expect(MEDIA_SETUPS.find((setup) => setup.set === '2,2,1')).toMatchObject({ microphones: 2, speakers: 1, headphones: 1, cameras: 1 })
    expect(MEDIA_SETUPS.find((setup) => setup.set === '1,1,0')).toMatchObject({ microphones: 1, speakers: 0, headphones: 1, cameras: 0 })
    expect(MEDIA_SETUPS.find((setup) => setup.set === '0,1,0')).toMatchObject({ microphones: 0, speakers: 1, headphones: 0, cameras: 0 })
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
