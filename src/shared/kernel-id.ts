/**
 * A kernel is identified by its Chromium version ("148.0.7778.215", fingerprint-chromium) or, for
 * other builds, that version with the build's prefix ("clearcote-150.0.7871.114"). The id names
 * the kernel's folder and what windows store as their kernel; anything that needs the Chromium
 * version itself (UA, profile downgrade check) uses kernelChromiumVersion.
 *
 * A prefixed id has no measured GPU list or known-issue entry: those are keyed by the
 * fingerprint-chromium major version, which the prefix keeps them from matching.
 */
export const KERNEL_ID_PATTERN = /^(?:clearcote-)?\d+(?:\.\d+){3}$/

export type KernelVendor = 'fingerprint-chromium' | 'clearcote'

export function isKernelId(value: string): boolean {
  return KERNEL_ID_PATTERN.test(value)
}

export function kernelVendor(id: string | null | undefined): KernelVendor {
  return id?.startsWith('clearcote-') ? 'clearcote' : 'fingerprint-chromium'
}

export function kernelChromiumVersion(id: string): string
export function kernelChromiumVersion(id: string | null | undefined): string | undefined
export function kernelChromiumVersion(id: string | null | undefined): string | undefined {
  return id?.replace(/^clearcote-/, '')
}

/** "Chromium 148.0.7778.215" / "Clearcote 150.0.7871.114". */
export function kernelName(id: string): string {
  return `${kernelVendor(id) === 'clearcote' ? 'Clearcote' : 'Chromium'} ${kernelChromiumVersion(id)}`
}

/** "Chromium 148" / "Clearcote 150". */
export function kernelShortName(id: string): string {
  return `${kernelVendor(id) === 'clearcote' ? 'Clearcote' : 'Chromium'} ${kernelChromiumVersion(id).split('.')[0]}`
}
