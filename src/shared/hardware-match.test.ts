import { describe, expect, it } from 'vitest'
import { cpuWeights, gpuTier, matchedHardware, matchingCpus, memoryWeights, STEAM_CPU_CORES } from './hardware-match'

const steps = (n: number) => Array.from({ length: n }, (_, i) => () => (i + 0.5) / n)

describe('hardware matched to the GPU', () => {
  it('ranks cards by tier', () => {
    expect(gpuTier('NVIDIA GeForce RTX 3050')).toBe('entry')
    expect(gpuTier('NVIDIA GeForce RTX 4060 Ti')).toBe('mid')
    expect(gpuTier('NVIDIA GeForce RTX 3080')).toBe('high')
    expect(gpuTier('NVIDIA GeForce RTX 3080 Ti')).toBe('top')
    expect(gpuTier('NVIDIA GeForce RTX 4070 Ti SUPER')).toBe('top')
  })

  it('pairs a card with CPUs sold within two years of it, never an i3 / Ryzen 3 with a top card', () => {
    const cpus = matchingCpus('NVIDIA GeForce RTX 4090')
    expect(cpus.length).toBeGreaterThan(10)
    expect(cpus.some((cpu) => /Core i3|Ryzen 3/.test(cpu.model))).toBe(false)
    expect(cpus.some((cpu) => cpu.model.includes('9900K'))).toBe(false)
    const entry = matchingCpus('NVIDIA GeForce RTX 3050')
    expect(entry.some((cpu) => /i7|i9|Ryzen [79]/.test(cpu.model))).toBe(true)
    expect(entry.some((cpu) => /Core Ultra/.test(cpu.model))).toBe(false)
  })

  it('gives each core count its Steam survey share, split among the CPUs that have it', () => {
    const weights = cpuWeights(matchingCpus('NVIDIA GeForce RTX 4070'))
    const byCores = new Map<number, number>()
    for (const [cpu, weight] of weights) byCores.set(cpu.cores, (byCores.get(cpu.cores) ?? 0) + weight)
    for (const [cores, total] of byCores) expect(total).toBeCloseTo(STEAM_CPU_CORES[cores] ?? 0, 6)
  })

  it('picks memory by the Steam survey; a top card never gets 8 GB; capped by what the kernel can report', () => {
    expect(memoryWeights('NVIDIA GeForce RTX 3060').map(([gb]) => gb)).toEqual([8, 16, 32])
    expect(memoryWeights('NVIDIA GeForce RTX 4090').map(([gb]) => gb)).toEqual([16, 32])
    const sizes = steps(1000).map((random) => matchedHardware('NVIDIA GeForce RTX 3060', 32, random).deviceMemory)
    const share = (gb: number) => sizes.filter((size) => size === gb).length / sizes.length
    expect(share(8)).toBeGreaterThan(0.08)
    expect(share(8)).toBeLessThan(0.12)
    expect(share(16)).toBeGreaterThan(0.43)
    expect(share(32)).toBeGreaterThan(0.44)
    expect(steps(200).every((random) => matchedHardware('NVIDIA GeForce RTX 4090', 32, random).deviceMemory !== 8)).toBe(true)
    expect(matchedHardware('NVIDIA GeForce RTX 4090', 8).deviceMemory).toBe(8)
    expect(matchedHardware('NVIDIA GeForce RTX 3080', 32, () => 0).cpu.threads).toBeGreaterThan(0)
  })
})
