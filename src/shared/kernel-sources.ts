/**
 * Where "在线下载内核" looks for kernels: GitHub projects ("owner/repo") whose releases carry a
 * Windows x64 zip. The user adds and removes them; the official ones are the default.
 *
 * Prism kernels are published in their own repository. This app's repository carried them up to
 * prism8 and keeps those releases for older apps; this app runs prism21 and later only, so it no longer
 * asks that repository (one GitHub query less each time: GitHub allows 60 an hour per IP).
 */
export const OFFICIAL_KERNEL_SOURCE = 'zhangchedan000/prism-kernel-releases'
export const LEGACY_KERNEL_SOURCE = 'zhangchedan000/fingerprint-browser'
export const DEFAULT_KERNEL_SOURCES: readonly string[] = [OFFICIAL_KERNEL_SOURCE]

export function isOfficialKernelSource(source: string | undefined): boolean {
  const lower = source?.toLowerCase()
  return lower === OFFICIAL_KERNEL_SOURCE.toLowerCase() || lower === LEGACY_KERNEL_SOURCE.toLowerCase()
}

/** One key for both official repositories: a kernel installed from one is updated from the other. */
export function kernelSourceFamily(source: string): string {
  return isOfficialKernelSource(source) ? OFFICIAL_KERNEL_SOURCE.toLowerCase() : source.toLowerCase()
}

/**
 * Saved lists: the old official repository (kernels up to prism8, none this app runs) is replaced by the
 * kernel repository, in its place, once.
 */
export function withOfficialKernelSource(sources: string[]): string[] {
  const legacy = sources.findIndex((source) => source.toLowerCase() === LEGACY_KERNEL_SOURCE.toLowerCase())
  if (legacy < 0) return sources
  const hasOfficial = sources.some((source) => source.toLowerCase() === OFFICIAL_KERNEL_SOURCE.toLowerCase())
  return [...sources.slice(0, legacy), ...(hasOfficial ? [] : [OFFICIAL_KERNEL_SOURCE]), ...sources.slice(legacy + 1)]
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/

/** "https://github.com/a/b", "github.com/a/b/releases", "a/b.git" → "a/b"; undefined when not a GitHub project. */
export function normalizeKernelSource(input: string): string | undefined {
  let text = input.trim()
  if (!text) return undefined
  if (/^https?:\/\//i.test(text) || /^github\.com\//i.test(text)) {
    let url: URL
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
    } catch {
      return undefined
    }
    if (url.hostname.toLowerCase() !== 'github.com' && url.hostname.toLowerCase() !== 'www.github.com') return undefined
    text = url.pathname
  }
  const [owner, rawRepo] = text.replace(/^\/+/, '').split('/')
  const repo = rawRepo?.replace(/\.git$/i, '')
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return undefined
  return `${owner}/${repo}`
}

/** Valid, unique sources in order; anything unparsable is dropped. */
export function validKernelSources(input: unknown): string[] {
  if (!Array.isArray(input)) return [...DEFAULT_KERNEL_SOURCES]
  const seen = new Set<string>()
  const sources: string[] = []
  for (const item of input) {
    const source = typeof item === 'string' ? normalizeKernelSource(item) : undefined
    if (source && !seen.has(source.toLowerCase())) {
      seen.add(source.toLowerCase())
      sources.push(source)
    }
  }
  return sources
}
