/**
 * A kernel is identified by its Chromium version ("148.0.7778.215", fingerprint-chromium) or, for
 * other builds, that version with the build's prefix ("clearcote-150.0.7871.114",
 * "prism-156.0.8078.47"). The id names the kernel's folder and what windows store as their
 * kernel; anything that needs the Chromium version itself (UA, profile downgrade check) uses
 * kernelChromiumVersion.
 *
 * Prism kernels are our own builds (tools/kernel-patches, private build repo). fingerprint-chromium
 * GPU lists and known issues are keyed by its major version, which the prefixes keep other builds
 * from matching.
 */
export const KERNEL_ID_PATTERN = /^(?:(?:clearcote|prism)-)?\d+(?:\.\d+){3}(?:-\d{12})?$/

/**
 * A second local build of a version already installed gets the import time as a suffix
 * ("prism-156.0.8078.47-202610261501", yyyyMMddHHmm) so both can stay installed side by side.
 */
const BUILD_SUFFIX = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/

export function kernelBuildId(base: string, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${base}-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}`
}

/** "10-26 15:01" for an id with a build suffix. */
export function kernelBuildLabel(id: string | null | undefined): string | undefined {
  const match = id?.match(BUILD_SUFFIX)
  return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : undefined
}

export type KernelVendor = 'fingerprint-chromium' | 'clearcote' | 'prism'

export function isKernelId(value: string): boolean {
  return KERNEL_ID_PATTERN.test(value)
}

export function kernelVendor(id: string | null | undefined): KernelVendor {
  if (id?.startsWith('clearcote-')) return 'clearcote'
  if (id?.startsWith('prism-')) return 'prism'
  return 'fingerprint-chromium'
}

export function kernelChromiumVersion(id: string): string
export function kernelChromiumVersion(id: string | null | undefined): string | undefined
export function kernelChromiumVersion(id: string | null | undefined): string | undefined {
  return id?.replace(/^(?:clearcote|prism)-/, '').replace(BUILD_SUFFIX, '')
}

const VENDOR_NAMES: Record<KernelVendor, string> = { 'fingerprint-chromium': 'Chromium', clearcote: 'Clearcote', prism: 'Prism' }

/** "Chromium 148.0.7778.215" / "Clearcote 150.0.7871.114" / "Prism 156.0.8078.47". */
export function kernelName(id: string): string {
  const build = kernelBuildLabel(id)
  return `${VENDOR_NAMES[kernelVendor(id)]} ${kernelChromiumVersion(id)}${build ? ` · ${build}` : ''}`
}

/** "Chromium 148" / "Clearcote 150" / "Prism 156". */
export function kernelShortName(id: string): string {
  const build = kernelBuildLabel(id)
  return `${VENDOR_NAMES[kernelVendor(id)]} ${kernelChromiumVersion(id).split('.')[0]}${build ? ` · ${build}` : ''}`
}
