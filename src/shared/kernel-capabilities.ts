import { kernelChromiumVersion, kernelVendor, prismRevision } from './kernel-id'

/** What a kernel can be told on its command line. */
export function kernelMajor(version: string | null | undefined): number | undefined {
  const major = Number(kernelChromiumVersion(version)?.split('.')[0])
  return Number.isInteger(major) && major > 0 ? major : undefined
}

/** Takes the GPU by --fingerprint-gpu-* (vendor id, device id, driver name) instead of a seeded pick. */
export function kernelTakesExplicitGpu(version: string | null | undefined): boolean {
  return kernelVendor(version) === 'prism'
}

/**
 * Largest navigator.deviceMemory the kernel's Chromium can report: desktop Chrome capped it at 8
 * until 146 and reports 2/4/8/16/32 from 147 (blink-dev Intent to Ship; 156 source clamps to 2..32).
 */
export function maxDeviceMemoryGb(version: string | null | undefined): 8 | 32 {
  return (kernelMajor(version) ?? 0) >= 147 ? 32 : 8
}

/**
 * The kernel ships a clean Windows 10 and 11's fonts and language font packages and windows use only
 * those (prism16, patch 007): nothing has to be installed into this computer's Windows.
 */
export function kernelHasBuiltInFonts(version: string | null | undefined): boolean {
  return (prismRevision(version ?? undefined) ?? 0) >= 16
}

/** PCI vendor ids, as ANGLE names them (src/libANGLE/renderer/driver_utils.cpp). */
export const GPU_VENDOR_IDS: Readonly<Record<string, string>> = { NVIDIA: '0x10DE', AMD: '0x1002', Intel: '0x8086' }
