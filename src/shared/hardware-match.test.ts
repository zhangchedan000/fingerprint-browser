import { describe, expect, it } from 'vitest'
import { gpuTier, matchedHardware, matchedScreen, matchingCpus } from './hardware-match'

describe('hardware matched to the GPU', () => {
  it('ranks cards by tier', () => {
    expect(gpuTier('NVIDIA GeForce RTX 3050')).toBe('entry')
    expect(gpuTier('NVIDIA GeForce RTX 4060 Ti')).toBe('mid')
    expect(gpuTier('NVIDIA GeForce RTX 3080')).toBe('high')
    expect(gpuTier('NVIDIA GeForce RTX 3080 Ti')).toBe('top')
    expect(gpuTier('NVIDIA GeForce RTX 4070 Ti SUPER')).toBe('top')
  })

  it('pairs a high-end card with an i7/i9 or Ryzen 7/9 of its era', () => {
    const cpus = matchingCpus('NVIDIA GeForce RTX 4090')
    expect(cpus.length).toBeGreaterThan(10)
    expect(cpus.every((cpu) => /i7|i9|Ryzen [79]|Ultra [79]/.test(cpu.model))).toBe(true)
    expect(cpus.some((cpu) => cpu.model.includes('9900K') && !cpu.model.includes('12'))).toBe(false)
  })

  it('pairs an entry card with an i3/i5 or Ryzen 3/5', () => {
    expect(matchingCpus('NVIDIA GeForce RTX 3050').every((cpu) => /i[35]|Ryzen [35]/.test(cpu.model))).toBe(true)
  })

  it('gives top cards 32 GB, capped by what the kernel can report', () => {
    expect(matchedHardware('NVIDIA GeForce RTX 4090', 32).deviceMemory).toBe(32)
    expect(matchedHardware('NVIDIA GeForce RTX 4090', 8).deviceMemory).toBe(8)
    const { cpu } = matchedHardware('NVIDIA GeForce RTX 3080', 32, () => 0)
    expect(cpu.threads).toBeGreaterThan(0)
  })

  it('gives top cards large screens and never one smaller than the real one', () => {
    const sizes = Array.from({ length: 200 }, (_, i) => matchedScreen('NVIDIA GeForce RTX 4090', { width: 1920, height: 1080 }, () => i / 200))
    expect(sizes.some((size) => size?.width === 3840)).toBe(true)
    expect(sizes.some((size) => size?.width === 1920)).toBe(false)
    const entry = matchedScreen('NVIDIA GeForce RTX 3050', { width: 2560, height: 1440 }, () => 0)
    expect(entry).toEqual({ width: 2560, height: 1440 })
    expect(matchedScreen('NVIDIA GeForce RTX 3050', { width: 1920, height: 1080 }, () => 0)).toEqual({ width: 1920, height: 1080 })
  })
})
