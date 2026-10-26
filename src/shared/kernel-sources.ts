/**
 * Where "在线下载内核" looks for kernels: GitHub projects ("owner/repo") whose releases carry a
 * Windows x64 zip. The user adds and removes them; this app's own repository is the default.
 */
export const OFFICIAL_KERNEL_SOURCE = 'zhangchedan000/fingerprint-browser'
export const DEFAULT_KERNEL_SOURCES: readonly string[] = [OFFICIAL_KERNEL_SOURCE]

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
