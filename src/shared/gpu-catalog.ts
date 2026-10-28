import catalogs from './gpu-catalogs.json'
import type { BrowserPlatform } from './types'
import { kernelVendor } from './kernel-id'

/**
 * The desktop GPUs a Prism kernel can be told to report (real driver names and PCI ids, see
 * tools/hardware-db). Windows store a GPU by its key (model + device id).
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

/**
 * What a GeForce RTX card does with AV1 (NVIDIA's video codec SDK support matrix): RTX 20 (Turing)
 * neither decodes nor encodes it, RTX 30 (Ampere) decodes it, RTX 40 and 50 encode it too.
 * Undefined for any other card (the host's own codecs are kept).
 */
export function gpuAv1Support(model: string): 'none' | 'decode' | 'encode' | undefined {
  const series = model.match(/\bRTX ([2-5])0[5-9]0\b/)?.[1]
  if (series === '2') return 'none'
  if (series === '3') return 'decode'
  if (series === '4' || series === '5') return 'encode'
  return undefined
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
  // Prism kernels take the GPU on the command line; every version accepts the same desktop list.
  if (kernelVendor(version) === 'prism') return CATALOGS.prism?.[platform]
  if (kernelVendor(version) !== 'fingerprint-chromium') return undefined
  const major = majorOf(version)
  return major ? CATALOGS[major]?.[platform] : undefined
}

/** Kernel lists: fingerprint-chromium major versions oldest first, then "prism". */
export const MEASURED_KERNELS: readonly string[] = Object.keys(CATALOGS)
  .sort((a, b) => (Number(a) || Infinity) - (Number(b) || Infinity))

/** "144" stays a version; the Prism list reads "Prism". */
export function kernelListLabel(key: string): string {
  return key === 'prism' ? 'Prism' : key
}

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
 * Windows saved before per-version lists stored a position in the old 139–144 list. Those
 * kernels are gone (only Prism kernels remain), so the position no longer names a card.
 */
export function legacyBucketGpuKey(_bucket: number, _platform: BrowserPlatform): string | undefined {
  return undefined
}
