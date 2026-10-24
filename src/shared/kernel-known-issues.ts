/**
 * Upstream kernel bugs found with tools/kernel-smoke. Values are catalog keys for t().
 * 150: with fingerprinting on, most seeds crash the renderer on some sites (Baidu) through the
 * Canvas/WebGL spoofing; 144 and 148 with the same seeds are fine, and the 150 source is closed.
 */
const KNOWN_ISSUES: Record<string, string> = {
  '150': '开启指纹后部分网站（如百度）会崩溃，建议使用 148 内核'
}

export function kernelKnownIssue(version: string | null | undefined): string | undefined {
  const major = version?.match(/^(\d+)\./)?.[1]
  return major ? KNOWN_ISSUES[major] : undefined
}
