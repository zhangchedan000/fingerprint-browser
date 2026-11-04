import { describe, expect, it } from 'vitest'
import { CPU_VENDOR_SHARE, cpuWeights, gpuTier, matchedHardware, matchedScreen, matchingCpus, memoryWeights, screenSuitsGpu, screenWeights, STEAM_CPU_CORES } from './hardware-match'

const steps = (n: number) => Array.from({ length: n }, (_, i) => () => (i + 0.5) / n)

describe('hardware matched to the GPU', () => {
  it('ranks cards by tier', () => {
    expect(gpuTier('NVIDIA GeForce RTX 3050')).toBe('entry')
    expect(gpuTier('NVIDIA GeForce RTX 4060 Ti')).toBe('mid')
    expect(gpuTier('NVIDIA GeForce RTX 3080')).toBe('high')
    expect(gpuTier('NVIDIA GeForce RTX 3080 Ti')).toBe('top')
    expect(gpuTier('NVIDIA GeForce RTX 4070 Ti SUPER')).toBe('top')
  })

  it('pairs a top card only with an i7 / i9 class CPU of its years', () => {
    const cpus = matchingCpus('NVIDIA GeForce RTX 4090')
    expect(cpus.length).toBeGreaterThan(10)
    expect(cpus.every((cpu) => /i7|i9|Ryzen [79]|Ultra [79]/.test(cpu.model))).toBe(true)
    expect(cpus.some((cpu) => cpu.model.includes('9900K'))).toBe(false)
  })

  it('pairs an entry card only with an i3 / i5 class CPU of its years', () => {
    const cpus = matchingCpus('NVIDIA GeForce RTX 3050')
    expect(cpus.length).toBeGreaterThan(5)
    expect(cpus.every((cpu) => /i[35]|Ryzen [35]|Ultra 5/.test(cpu.model))).toBe(true)
    expect(cpus.some((cpu) => /Core Ultra/.test(cpu.model))).toBe(false)
  })

  it('pairs mid and high cards with the classes between', () => {
    expect(matchingCpus('NVIDIA GeForce RTX 4060').every((cpu) => /i[57]|Ryzen [57]|Ultra [57]/.test(cpu.model))).toBe(true)
    expect(matchingCpus('NVIDIA GeForce RTX 4070').some((cpu) => /i9|Ryzen 9/.test(cpu.model))).toBe(true)
    expect(matchingCpus('NVIDIA GeForce RTX 4070').some((cpu) => /Core i3|Ryzen 3/.test(cpu.model))).toBe(false)
  })

  it('picks Intel or AMD by their share first, then core counts by the Steam survey within the vendor', () => {
    for (const gpu of ['NVIDIA GeForce RTX 2060', 'NVIDIA GeForce RTX 3070', 'NVIDIA GeForce RTX 4070', 'NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 5070', 'NVIDIA GeForce RTX 5080']) {
      const weights = cpuWeights(matchingCpus(gpu))
      const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
      const intel = weights.filter(([cpu]) => cpu.vendor === 'Intel').reduce((sum, [, weight]) => sum + weight, 0)
      // Before: an RTX 5080 got AMD 81% of the time (6- and 8-core shares fell to Ryzen only).
      expect(intel / total).toBeCloseTo(CPU_VENDOR_SHARE.Intel / (CPU_VENDOR_SHARE.Intel + CPU_VENDOR_SHARE.AMD), 6)
      for (const vendor of ['Intel', 'AMD'] as const) {
        const own = weights.filter(([cpu]) => cpu.vendor === vendor)
        const byCores = new Map<number, number>()
        for (const [cpu, weight] of own) byCores.set(cpu.cores, (byCores.get(cpu.cores) ?? 0) + weight)
        const coreTotal = [...byCores.keys()].reduce((sum, cores) => sum + (STEAM_CPU_CORES[cores] ?? 0), 0)
        const vendorTotal = own.reduce((sum, [, weight]) => sum + weight, 0)
        for (const [cores, weight] of byCores) expect(weight / vendorTotal).toBeCloseTo((STEAM_CPU_CORES[cores] ?? 0) / coreTotal, 6)
      }
    }
  })

  it('picks memory by the Steam survey; 8 GB only beside an entry card; capped by what the kernel can report', () => {
    expect(memoryWeights('NVIDIA GeForce RTX 3050').map(([gb]) => gb)).toEqual([8, 16, 32])
    expect(memoryWeights('NVIDIA GeForce RTX 4060').map(([gb]) => gb)).toEqual([16, 32])
    expect(memoryWeights('NVIDIA GeForce RTX 4090').map(([gb]) => gb)).toEqual([16, 32])
    const sizes = steps(1000).map((random) => matchedHardware('NVIDIA GeForce RTX 3050', 32, random).deviceMemory)
    const share = (gb: number) => sizes.filter((size) => size === gb).length / sizes.length
    expect(share(8)).toBeGreaterThan(0.08)
    expect(share(8)).toBeLessThan(0.12)
    expect(share(16)).toBeGreaterThan(0.43)
    expect(share(32)).toBeGreaterThan(0.44)
    expect(steps(200).every((random) => matchedHardware('NVIDIA GeForce RTX 4090', 32, random).deviceMemory !== 8)).toBe(true)
    expect(matchedHardware('NVIDIA GeForce RTX 4090', 8).deviceMemory).toBe(8)
    expect(matchedHardware('NVIDIA GeForce RTX 3080', 32, () => 0).cpu.threads).toBeGreaterThan(0)
  })

  it('gives each card a monitor of its class, by Steam shares', () => {
    expect(screenSuitsGpu('NVIDIA GeForce RTX 3050', { width: 3840, height: 2160 })).toBe(false)
    expect(screenSuitsGpu('NVIDIA GeForce RTX 3050', { width: 2560, height: 1440 })).toBe(false)
    expect(screenSuitsGpu('NVIDIA GeForce RTX 3050', { width: 1920, height: 1080 })).toBe(true)
    expect(screenSuitsGpu('NVIDIA GeForce RTX 4060', { width: 2560, height: 1440 })).toBe(true)
    expect(screenSuitsGpu('NVIDIA GeForce RTX 4060', { width: 3840, height: 2160 })).toBe(false)
    expect(screenSuitsGpu('NVIDIA GeForce RTX 4070', { width: 1920, height: 1080 })).toBe(false)
    expect(screenSuitsGpu('NVIDIA GeForce RTX 4090', { width: 1920, height: 1080 })).toBe(false)
    expect(screenSuitsGpu('NVIDIA GeForce RTX 4090', { width: 3840, height: 2160 })).toBe(true)
    const share = (gpu: string, w: number, h: number) => screenWeights(gpu).find(([choice]) => choice.physical.width === w && choice.physical.height === h)?.[1] ?? 0
    // Entry mostly 1080p (the survey alone); mid and upper mid mostly 2K, high-end mostly 4K, 75% each;
    // ultrawides as often as in the survey overall; the rest by the survey.
    expect(share('NVIDIA GeForce RTX 3050', 1920, 1080)).toBeGreaterThan(0.9)
    expect(share('NVIDIA GeForce RTX 4060', 2560, 1440)).toBeCloseTo(0.75, 6)
    expect(share('NVIDIA GeForce RTX 4060', 2560, 1080)).toBeCloseTo(0.0068, 6)
    expect(share('NVIDIA GeForce RTX 4060', 1920, 1080)).toBeCloseTo((1 - 0.75 - 0.0068) * 51.93 / (51.93 + 3.01), 6)
    expect(share('NVIDIA GeForce RTX 4070', 2560, 1440)).toBeCloseTo(0.75, 6)
    expect(share('NVIDIA GeForce RTX 4070', 3440, 1440)).toBeCloseTo(0.0322, 6)
    expect(share('NVIDIA GeForce RTX 4070', 3840, 2160)).toBeCloseTo(1 - 0.75 - 0.0322, 6)
    expect(share('NVIDIA GeForce RTX 4090', 3840, 2160)).toBeCloseTo(0.75, 6)
    expect(share('NVIDIA GeForce RTX 4090', 3440, 1440)).toBeCloseTo(0.0322, 6)
    expect(share('NVIDIA GeForce RTX 4090', 2560, 1440)).toBeCloseTo(1 - 0.75 - 0.0322, 6)
    expect(share('NVIDIA GeForce RTX 4090', 1920, 1080)).toBe(0)
    for (const gpu of ['NVIDIA GeForce RTX 3050', 'NVIDIA GeForce RTX 4060', 'NVIDIA GeForce RTX 4070', 'NVIDIA GeForce RTX 4090']) {
      expect(screenWeights(gpu).reduce((sum, [, weight]) => sum + weight, 0)).toBeCloseTo(1, 6)
    }
    const top = steps(1000).map((random) => matchedScreen('NVIDIA GeForce RTX 4090', random))
    expect(top.filter((size) => size?.width === 3840).length / 1000).toBeGreaterThan(0.7)
    expect(steps(500).map((random) => matchedScreen('NVIDIA GeForce RTX 3050', random)).every((size) => size?.width === 1920)).toBe(true)
  })
})
