import { CPU_MODELS, type CpuModel } from './cpu-catalog'
import type { DeviceMemoryGb } from './types'
import { screenChoices, type ScreenSize } from './screen'

/**
 * A GPU picked for a window brings a CPU and memory size a real desktop with that card would have:
 * a CPU class that suits the card and was on sale around the same years, and the RAM such builds
 * usually carry. The editor applies the match as a default; every field stays editable.
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

/** Launch year of a GPU series (RTX 20 → 2019 … RTX 50 → 2025), undefined when unknown. */
function gpuYear(model: string): number | undefined {
  const series = model.match(/RTX (\d)0\d0/)?.[1]
  return series ? ({ 2: 2019, 3: 2021, 4: 2023, 5: 2025 } as Record<string, number>)[series] : undefined
}

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

const CPU_CLASSES: Record<GpuTier, number[]> = { entry: [1, 2], mid: [2, 3], high: [2, 3, 4], top: [3, 4] }
const MEMORY: Record<GpuTier, DeviceMemoryGb[]> = { entry: [8, 16, 16], mid: [16, 16, 32], high: [16, 32, 32], top: [32] }

/** CPUs that suit the card: its class, launched within two years of the card's series. */
export function matchingCpus(gpuModel: string): CpuModel[] {
  const tier = gpuTier(gpuModel)
  const year = gpuYear(gpuModel)
  const suited = CPU_MODELS.filter((cpu) => {
    if (!CPU_CLASSES[tier].includes(cpuClass(cpu))) return false
    const cpuYear = FAMILY_YEARS[cpu.family]
    return year === undefined || cpuYear === undefined || Math.abs(cpuYear - year) <= 2
  })
  return suited.length ? suited : [...CPU_MODELS]
}

export function matchedHardware(
  gpuModel: string,
  maxMemoryGb: number,
  random: () => number = Math.random
): { cpu: CpuModel; deviceMemory: DeviceMemoryGb } {
  const cpus = matchingCpus(gpuModel)
  const memory = MEMORY[gpuTier(gpuModel)]
  const deviceMemory = memory[Math.floor(random() * memory.length)]
  return {
    cpu: cpus[Math.floor(random() * cpus.length)],
    deviceMemory: (Math.min(deviceMemory, maxMemoryGb) as DeviceMemoryGb)
  }
}

/** How often each resolution goes with a card of this tier (keys "width x height"). */
const SCREENS: Record<GpuTier, Record<string, number>> = {
  entry: { '1920x1080': 70, '2560x1440': 25, '1920x1200': 5 },
  mid: { '1920x1080': 45, '2560x1440': 40, '2560x1080': 5, '1920x1200': 5, '3440x1440': 5 },
  high: { '1920x1080': 20, '2560x1440': 50, '3440x1440': 12, '3840x2160': 13, '2560x1600': 5 },
  top: { '2560x1440': 40, '3840x2160': 35, '3440x1440': 20, '2560x1600': 5 }
}

/**
 * A resolution a desktop with this card usually has, among those this computer can claim (see
 * screenFloor); the floor itself when none of the tier's sizes fits.
 */
export function matchedScreen(gpuModel: string, floor: ScreenSize | undefined, random: () => number = Math.random, scale = 1): ScreenSize | undefined {
  const weights = SCREENS[gpuTier(gpuModel)]
  const choices = screenChoices(floor, scale)
    .map((choice) => ({ ...choice, weight: weights[`${choice.physical.width}x${choice.physical.height}`] ?? 0 }))
    .filter((choice) => choice.weight > 0)
  if (!choices.length) return floor
  let roll = random() * choices.reduce((sum, choice) => sum + choice.weight, 0)
  for (const choice of choices) {
    roll -= choice.weight
    if (roll < 0) return { width: choice.width, height: choice.height }
  }
  const last = choices[choices.length - 1]
  return { width: last.width, height: last.height }
}

/** Whether a desktop with this card usually has a screen of this physical size (the table above). */
export function screenSuitsGpu(gpuModel: string, physical: ScreenSize): boolean {
  return (SCREENS[gpuTier(gpuModel)][`${physical.width}x${physical.height}`] ?? 0) > 0
}
