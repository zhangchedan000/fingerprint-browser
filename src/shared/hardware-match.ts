import { CPU_MODELS, type CpuModel } from './cpu-catalog'
import type { DeviceMemoryGb } from './types'

/**
 * A GPU picked for a window brings a CPU and memory size. How often each value comes up follows the
 * Steam Hardware & Software Survey (store.steampowered.com/hwsurvey, PC, October 2026); no public
 * survey breaks these down by graphics card, so the card only rules out what does not fit it:
 * a CPU sold more than two years apart from the card, and on a top card 8 GB or an i3 / Ryzen 3.
 * The editor applies the match as a default; every field stays editable.
 */
export type GpuTier = 'entry' | 'mid' | 'high' | 'top'

const TOP = /RTX (3080 Ti|3090|4080|4090|4070 Ti SUPER|5070 Ti|5080|5090)/
const HIGH = /RTX (2080|3070|3080|4070|5070)/
const MID = /RTX (2060 SUPER|2070|3060|4060)/

export function gpuTier(model: string): GpuTier {
  if (TOP.test(model)) return 'top'
  if (HIGH.test(model)) return 'high'
  if (MID.test(model)) return 'mid'
  return 'entry'
}

/**
 * The first full year a series was on sale (launch dates from Wikipedia: RTX 20 2018-09-20,
 * RTX 30 2020-09-17, RTX 40 2022-10-12, RTX 50 2025-01-30), undefined when unknown.
 */
function gpuYear(model: string): number | undefined {
  const series = model.match(/RTX (\d)0\d0/)?.[1]
  return series ? ({ 2: 2019, 3: 2021, 4: 2023, 5: 2025 } as Record<string, number>)[series] : undefined
}

/** The first full year each CPU family was on sale, the same way as gpuYear. */
const FAMILY_YEARS: Record<string, number> = {
  'Coffee Lake Refresh (9th)': 2019,
  'Comet Lake (10th)': 2020,
  'Rocket Lake (11th)': 2021,
  'Alder Lake (12th)': 2022,
  'Raptor Lake (13th)': 2023,
  'Raptor Lake Refresh (14th)': 2024,
  'Arrow Lake (Core Ultra 200S)': 2025,
  'Arrow Lake Refresh (Core Ultra 200S Plus)': 2026,
  'Matisse (Ryzen 3000)': 2019,
  'Vermeer (Ryzen 5000)': 2021,
  'Cezanne (Ryzen 5000G)': 2021,
  'Raphael (Ryzen 7000)': 2023,
  'Phoenix (Ryzen 8000G)': 2024,
  'Granite Ridge (Ryzen 9000)': 2025
}

/** 1 = i3/Ryzen 3 … 4 = i9/Ryzen 9/Ultra 9. */
function cpuClass(cpu: CpuModel): number {
  const match = cpu.model.match(/(?:Core i|Ryzen |Ultra )([3579])\b/)
  return match ? (Number(match[1]) - 1) / 2 : 2
}

/** Steam survey, October 2026, "Physical CPUs": share of computers (%) by core count. */
export const STEAM_CPU_CORES: Readonly<Record<number, number>> = {
  1: 0.02, 2: 2.75, 3: 0.09, 4: 11.76, 5: 0.2, 6: 28.12, 7: 0.01, 8: 28.63, 10: 6.97, 12: 4.93,
  14: 4.89, 16: 6.01, 18: 0.26, 20: 2.27, 22: 0.01, 24: 3.05
}

/**
 * Steam survey, October 2026, "System RAM" (%), summed by the navigator.deviceMemory Chrome reports
 * for it (nearest power of two, ties down, at most 32: third_party/blink/common/device_memory/
 * approximated_device_memory.cc): 8 GB 7.02 + 12 GB 2.45; 16 GB 41.27 + 24 GB 2.10;
 * 28 GB 0.51 + 32 GB 38.18 + 48 GB 1.16 + 60 GB 0.93 + 64 GB 3.95 + more 0.55.
 */
export const STEAM_DEVICE_MEMORY: ReadonlyArray<[DeviceMemoryGb, number]> = [[8, 9.47], [16, 43.37], [32, 45.28]]

/** CPUs that suit the card: on sale within two years of it; no i3 / Ryzen 3 with a top card. */
export function matchingCpus(gpuModel: string): CpuModel[] {
  const top = gpuTier(gpuModel) === 'top'
  const year = gpuYear(gpuModel)
  const suited = CPU_MODELS.filter((cpu) => {
    if (top && cpuClass(cpu) === 1) return false
    const cpuYear = FAMILY_YEARS[cpu.family]
    return year === undefined || cpuYear === undefined || Math.abs(cpuYear - year) <= 2
  })
  return suited.length ? suited : [...CPU_MODELS]
}

function pick<T>(items: ReadonlyArray<[T, number]>, random: () => number): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = random() * total
  for (const [item, weight] of items) {
    roll -= weight
    if (roll < 0) return item
  }
  return items[items.length - 1][0]
}

/**
 * Each suiting CPU weighted so that core counts come up as often as in the Steam survey: a core
 * count's share is split evenly among the suiting CPUs that have it.
 */
export function cpuWeights(cpus: readonly CpuModel[]): Array<[CpuModel, number]> {
  const perCores = new Map<number, number>()
  for (const cpu of cpus) perCores.set(cpu.cores, (perCores.get(cpu.cores) ?? 0) + 1)
  const weighted = cpus.map((cpu): [CpuModel, number] => [cpu, (STEAM_CPU_CORES[cpu.cores] ?? 0) / perCores.get(cpu.cores)!])
  return weighted.some(([, weight]) => weight > 0) ? weighted : cpus.map((cpu) => [cpu, 1])
}

/** Memory sizes for this card with their Steam shares: a top card never 8 GB. */
export function memoryWeights(gpuModel: string): Array<[DeviceMemoryGb, number]> {
  const top = gpuTier(gpuModel) === 'top'
  return STEAM_DEVICE_MEMORY.filter(([gb]) => !(top && gb === 8)).map(([gb, share]) => [gb, share])
}

export function matchedHardware(
  gpuModel: string,
  maxMemoryGb: number,
  random: () => number = Math.random
): { cpu: CpuModel; deviceMemory: DeviceMemoryGb } {
  const cpu = pick(cpuWeights(matchingCpus(gpuModel)), random)
  const deviceMemory = pick(memoryWeights(gpuModel), random)
  return { cpu, deviceMemory: Math.min(deviceMemory, maxMemoryGb) as DeviceMemoryGb }
}
