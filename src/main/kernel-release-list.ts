/**
 * Picks the Windows x64 kernel zip out of a GitHub project's releases. Prism releases name it
 * "ungoogled-chromium_<version>-1.1_windows_x64.zip"; other projects use their own names, so any
 * zip naming Windows and x64 counts, and the Chromium version comes from the asset or the tag.
 */
export interface GithubAsset {
  name: string
  size: number
  browser_download_url: string
  digest: string | null
}

export interface GithubRelease {
  tag_name: string
  published_at: string
  draft: boolean
  prerelease: boolean
  assets: GithubAsset[]
}

export interface ReleaseCandidate {
  source: string
  chromium: string
  publishedAt: string
  asset: GithubAsset
  /** From the asset's GitHub digest; empty until a checksum file supplies it. */
  sha256: string
  /** A checksum file in the same release to read when GitHub gave no digest. */
  checksumAsset?: GithubAsset
}

const VERSION = /\d{2,3}\.\d+\.\d+\.\d+/

function isWindowsX64Zip(name: string): boolean {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.zip') || /arm64|aarch64|x86(?!_64)|win32|ia32/.test(lower.replace('x86_64', ''))) return false
  return /win/.test(lower) && /x64|amd64|x86_64|win64/.test(lower)
}

export function windowsKernelAsset(assets: readonly GithubAsset[]): GithubAsset | undefined {
  return assets.find((asset) => /^ungoogled-chromium_.+_windows_x64\.zip$/.test(asset.name))
    ?? assets.find((asset) => isWindowsX64Zip(asset.name))
}

export function releaseCandidates(source: string, releases: readonly GithubRelease[]): ReleaseCandidate[] {
  return releases
    .filter((release) => !release.draft && !release.prerelease)
    .flatMap((release) => {
      const asset = windowsKernelAsset(release.assets)
      const chromium = asset?.name.match(VERSION)?.[0] ?? release.tag_name.match(VERSION)?.[0]
      if (!asset || !chromium) return []
      const sha256 = asset.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length).toLowerCase() : ''
      const checksumAsset = sha256 ? undefined : release.assets.find((item) => /sha256sums?\.txt$|\.sha256$/i.test(item.name))
      return [{ source, chromium, publishedAt: release.published_at, asset, sha256, checksumAsset }]
    })
    .sort((first, second) => second.publishedAt.localeCompare(first.publishedAt))
}

/** The hash a checksum file lists for `fileName` ("<hash>  <name>" lines, or a bare hash). */
export function checksumFor(text: string, fileName: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    const [hash, ...rest] = line.split(/\s+/)
    if (/^[a-f\d]{64}$/i.test(hash) && rest.join(' ').replace(/^\*/, '') === fileName) return hash.toLowerCase()
  }
  return lines.length === 1 && /^[a-f\d]{64}$/i.test(lines[0]) ? lines[0].toLowerCase() : undefined
}

/** Downloads are only taken from a listed project's own release files on github.com. */
export function isSourceDownloadUrl(url: string, sources: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return false
  const path = parsed.pathname.toLowerCase()
  return sources.some((source) => path.startsWith(`/${source.toLowerCase()}/releases/download/`))
}
