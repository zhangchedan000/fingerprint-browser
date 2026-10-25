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
export const KERNEL_ID_PATTERN = /^(?:(?:clearcote|prism)-)?\d+(?:\.\d+){3}$/

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
  return id?.replace(/^(?:clearcote|prism)-/, '')
}

const VENDOR_NAMES: Record<KernelVendor, string> = { 'fingerprint-chromium': 'Chromium', clearcote: 'Clearcote', prism: 'Prism' }

/** "Chromium 148.0.7778.215" / "Clearcote 150.0.7871.114" / "Prism 156.0.8078.47". */
export function kernelName(id: string): string {
  return `${VENDOR_NAMES[kernelVendor(id)]} ${kernelChromiumVersion(id)}`
}

/** "Chromium 148" / "Clearcote 150" / "Prism 156". */
export function kernelShortName(id: string): string {
  return `${VENDOR_NAMES[kernelVendor(id)]} ${kernelChromiumVersion(id).split('.')[0]}`
}
