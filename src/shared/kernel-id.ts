/**
 * A kernel is identified by its Chromium version ("148.0.7778.215", fingerprint-chromium) or, for
 * other builds, that version with the build's prefix ("clearcote-150.0.7871.114",
 * "prism-156.0.8078.47"). The id names the kernel's folder and what windows store as their
 * kernel; anything that needs the Chromium version itself (UA, profile downgrade check) uses
 * kernelChromiumVersion.
 *
 * Prism kernels are our own builds (patches and build kits in the private prism-kernel repo). fingerprint-chromium
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
/** What a kernel is shown as: our Prism builds are Chrome to the user. */
const BRAND_NAMES: Record<KernelVendor, string> = { 'fingerprint-chromium': 'Chromium', clearcote: 'Clearcote', prism: 'Chrome' }

const majorOf = (id: string) => kernelChromiumVersion(id).split('.')[0]

/** The full name, for the kernel page: "Prism 156.0.8078.47" / "Prism 155.0.8059.84 · 10-26 19:27". */
export function kernelFullName(id: string): string {
  const build = kernelBuildLabel(id)
  return `${VENDOR_NAMES[kernelVendor(id)]} ${kernelChromiumVersion(id)}${build ? ` · ${build}` : ''}`
}

/**
 * "Chrome 156" / "Chrome 155". Given the kernels it is listed with (`among`), one that shares its
 * name with another also shows what tells them apart: its build time, else its full version.
 */
export function kernelName(id: string, among: readonly string[] = []): string {
  const name = `${BRAND_NAMES[kernelVendor(id)]} ${majorOf(id)}`
  const twins = among.filter((other) => other !== id && kernelVendor(other) === kernelVendor(id) && majorOf(other) === majorOf(id))
  if (!twins.length) return name
  const build = kernelBuildLabel(id)
  if (build) return `${name} · ${build}`
  return twins.some((other) => kernelChromiumVersion(other) !== kernelChromiumVersion(id)) ? `${name} · ${kernelChromiumVersion(id)}` : name
}

/** Same as kernelName (kept for the window list). */
export function kernelShortName(id: string, among: readonly string[] = []): string {
  return kernelName(id, among)
}

/**
 * "kernel-156.0.8078.47-prism5" / "156.0.8078.47-prism5" → 5, prism-kernel-releases tags ("prism11")
 * → 11; app releases (v0.2.0) carry it in the zip name instead
 * ("ungoogled-chromium_156.0.8078.47-prism5_windows_x64.zip").
 */
export function prismRevision(name: string | undefined): number | undefined {
  const match = name?.match(/(?:^|-)prism(\d+)(?:_|$)/)
  return match ? Number(match[1]) : undefined
}
