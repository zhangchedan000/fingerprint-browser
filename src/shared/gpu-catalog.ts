import catalogs from './gpu-catalogs.json'
import type { BrowserPlatform } from './types'

/**
 * The GPUs built into each fingerprint-chromium kernel, measured with tools/gpu-catalog/probe.mjs.
 * A kernel reports list[seed % list.length], so choosing a GPU means choosing a matching seed.
 * Windows store a GPU by its key (model + device id), never by its position, because the lists
 * differ between kernel versions.
 */
export interface KernelGpu {
  vendor: string
  model: string
  deviceId?: string
  renderer: string
}

interface KernelCatalog {
  kernelVersion: string
  measuredAt: string
  windows: KernelGpu[]
  macos: KernelGpu[]
}

const CATALOGS = catalogs as Record<string, KernelCatalog>

/** Stable identity of a GPU across kernel versions. */
export function gpuKey(gpu: Pick<KernelGpu, 'model' | 'deviceId'>): string {
  return gpu.deviceId ? `${gpu.model}|${gpu.deviceId}` : gpu.model
}

/** Short label, e.g. "NVIDIA GeForce RTX 4060 · 2882". */
export function gpuLabel(gpu: Pick<KernelGpu, 'model' | 'deviceId'>): string {
  return gpu.deviceId ? `${gpu.model} · ${gpu.deviceId.replace(/^0x0*/i, '')}` : gpu.model
}

function majorOf(version: string | null | undefined): string | undefined {
  return version?.match(/^(\d+)\./)?.[1]
}

/** The list a kernel version picks from, or undefined for versions that were never measured. */
export function kernelGpuList(version: string | null | undefined, platform: BrowserPlatform): readonly KernelGpu[] | undefined {
  const major = majorOf(version)
  return major ? CATALOGS[major]?.[platform] : undefined
}

/** Kernel major versions that have a measured list, oldest first. */
export const MEASURED_KERNELS: readonly string[] = Object.keys(CATALOGS).sort((a, b) => Number(a) - Number(b))

export interface GpuChoice extends KernelGpu {
  key: string
  /** Kernel major versions that contain this GPU. */
  kernels: string[]
}

/** Every GPU any measured kernel can report on this platform, each with the kernels that have it. */
export function allKernelGpus(platform: BrowserPlatform): GpuChoice[] {
  const byKey = new Map<string, GpuChoice>()
  for (const major of MEASURED_KERNELS) {
    for (const gpu of CATALOGS[major][platform]) {
      const key = gpuKey(gpu)
      const existing = byKey.get(key)
      if (!existing) byKey.set(key, { ...gpu, key, kernels: [major] })
      else if (!existing.kernels.includes(major)) existing.kernels.push(major)
    }
  }
  return [...byKey.values()].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model, undefined, { numeric: true }))
}

export function findKernelGpu(key: string, platform: BrowserPlatform): GpuChoice | undefined {
  return allKernelGpus(platform).find((gpu) => gpu.key === key)
}

/**
 * The seed to pass so `version` reports `key`. Undefined when the kernel does not have that GPU
 * (or its list was never measured) — callers must not launch with a silently different GPU.
 */
export function seedForGpu(seed: number, key: string, version: string | null | undefined, platform: BrowserPlatform): number | undefined {
  const list = kernelGpuList(version, platform)
  const index = list?.findIndex((gpu) => gpuKey(gpu) === key) ?? -1
  if (!list || index < 0) return undefined
  const base = seed >>> 0
  const candidate = base - (base % list.length) + index
  return candidate <= 0xffffffff ? candidate : candidate - list.length
}

/** What a kernel reports for a raw seed. */
export function gpuForSeed(seed: number, version: string | null | undefined, platform: BrowserPlatform): KernelGpu | undefined {
  const list = kernelGpuList(version, platform)
  return list?.length ? list[(seed >>> 0) % list.length] : undefined
}

/**
 * Windows saved before per-version lists stored a position in the 139–144 list (the only one the
 * app knew). Turns that position into the GPU it meant.
 */
export function legacyBucketGpuKey(bucket: number, platform: BrowserPlatform): string | undefined {
  const gpu = CATALOGS['144']?.[platform]?.[bucket]
  return gpu ? gpuKey(gpu) : undefined
}
