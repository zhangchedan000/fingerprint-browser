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
}

export const CPU_MODELS: readonly CpuModel[] = (catalog as { cpus: CpuModel[] }).cpus

export function findCpu(model: string | undefined): CpuModel | undefined {
  return model ? CPU_MODELS.find((cpu) => cpu.model === model) : undefined
}

/** CPUs grouped by family, in catalog order (oldest generation first per vendor). */
export function cpuFamilies(): Array<{ family: string; cpus: CpuModel[] }> {
  const groups = new Map<string, CpuModel[]>()
  for (const cpu of CPU_MODELS) groups.set(cpu.family, [...(groups.get(cpu.family) ?? []), cpu])
  return [...groups].map(([family, cpus]) => ({ family, cpus }))
}
