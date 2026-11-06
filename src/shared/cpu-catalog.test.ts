import { describe, expect, it } from 'vitest'

describe('uncommon AMD models (retired 2026-11-07)', () => {
  it('are never offered, but a window that already has one keeps it', async () => {
    const { ALL_CPU_MODELS, CPU_MODELS, cpuFamilies, findCpu } = await import('./cpu-catalog')
    const amd = CPU_MODELS.filter((cpu) => cpu.vendor === 'AMD')
    expect(amd).toHaveLength(37)
    expect(ALL_CPU_MODELS.filter((cpu) => cpu.retired)).toHaveLength(26)
    expect(CPU_MODELS.some((cpu) => cpu.model === 'AMD Ryzen 3 3100')).toBe(false)
    expect(findCpu('AMD Ryzen 3 3100')).toMatchObject({ cores: 4, threads: 8 })
    const listed = (keep?: string) => cpuFamilies(keep).flatMap((group) => group.cpus.map((cpu) => cpu.model))
    expect(listed()).not.toContain('AMD Ryzen 3 3100')
    expect(listed('AMD Ryzen 3 3100')).toContain('AMD Ryzen 3 3100')
    // Intel unchanged.
    expect(CPU_MODELS.filter((cpu) => cpu.vendor === 'Intel')).toHaveLength(ALL_CPU_MODELS.filter((cpu) => cpu.vendor === 'Intel').length)
  })
})
