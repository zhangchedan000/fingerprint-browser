import catalog from './cpu-catalog.json'

/**
 * Desktop CPUs a profile can claim (Intel 9th–14th gen and Core Ultra 200S, AMD Ryzen 3000–9000),
 * each with the core/thread counts its source states. Pages cannot read the model; it is kept so
 * a profile describes one real machine, and its thread count is what navigator.hardwareConcurrency
 * reports.
 */
export interface CpuModel {
  vendor: 'Intel' | 'AMD'
  model: string
  family: string
  cores: number
  threads: number
  source: string
  /**
   * No longer offered (uncommon AMD models, user 2026-11-07: 「冷门u 不要」): new windows never get it
   * and the picker does not list it, but a window that already has it keeps it.
   */
  retired?: boolean
}

/** Every known CPU, retired ones included (what a saved window may name). */
export const ALL_CPU_MODELS: readonly CpuModel[] = (catalog as { cpus: CpuModel[] }).cpus

/** The CPUs offered for windows: picked at random, listed in the picker. */
export const CPU_MODELS: readonly CpuModel[] = ALL_CPU_MODELS.filter((cpu) => !cpu.retired)

export function findCpu(model: string | undefined): CpuModel | undefined {
  return model ? ALL_CPU_MODELS.find((cpu) => cpu.model === model) : undefined
}

/**
 * Offered CPUs grouped by family, in catalog order (oldest generation first per vendor); a retired
 * one is listed too when it is the window's own (keep).
 */
export function cpuFamilies(keep?: string): Array<{ family: string; cpus: CpuModel[] }> {
  const groups = new Map<string, CpuModel[]>()
  for (const cpu of ALL_CPU_MODELS) {
    if (cpu.retired && cpu.model !== keep) continue
    groups.set(cpu.family, [...(groups.get(cpu.family) ?? []), cpu])
  }
  return [...groups].map(([family, cpus]) => ({ family, cpus }))
}
