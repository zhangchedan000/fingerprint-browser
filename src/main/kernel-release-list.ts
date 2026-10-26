/**
 * Picks the Windows x64 kernel zips out of a GitHub project's releases. Prism releases name them
 * "ungoogled-chromium_<version>-1.1_windows_x64.zip", and one app release ("v0.2.0") carries a
 * zip for each Chromium version it ships; other projects use their own names, so any zip naming
 * Windows and x64 counts, and the Chromium version comes from the asset or the tag.
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
  tag: string
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

/** One zip per Chromium version: Prism's own names first, then any Windows x64 zip. */
export function windowsKernelAssets(assets: readonly GithubAsset[], tag: string): Array<{ asset: GithubAsset; chromium: string }> {
  const prism = assets.filter((asset) => /^ungoogled-chromium_.+_windows_x64\.zip$/.test(asset.name))
  const zips = prism.length ? prism : assets.filter((asset) => isWindowsX64Zip(asset.name))
  const byVersion = new Map<string, GithubAsset>()
  for (const asset of zips) {
    const chromium = asset.name.match(VERSION)?.[0] ?? (zips.length === 1 ? tag.match(VERSION)?.[0] : undefined)
    if (chromium && !byVersion.has(chromium)) byVersion.set(chromium, asset)
  }
  return [...byVersion].map(([chromium, asset]) => ({ asset, chromium }))
}

export function releaseCandidates(source: string, releases: readonly GithubRelease[]): ReleaseCandidate[] {
  return releases
    .filter((release) => !release.draft && !release.prerelease)
    .flatMap((release) => {
      const checksums = release.assets.find((item) => /sha256sums?(\.txt)?$|\.sha256$/i.test(item.name))
      return windowsKernelAssets(release.assets, release.tag_name).map(({ asset, chromium }) => {
        const sha256 = asset.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length).toLowerCase() : ''
        return { source, tag: release.tag_name, chromium, publishedAt: release.published_at, asset, sha256, ...(sha256 ? {} : { checksumAsset: checksums }) }
      })
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

/** An installed kernel as the update check sees it. */
export interface InstalledKernel {
  version: string
  chromium: string
  sha256: string
  /** "owner/repo" when it was downloaded from a source; unset for local imports. */
  sourceRepo?: string
  /** When the installed build was published (downloads) or imported (local builds). */
  builtAt: string
}

export type PlannedRow<R extends ReleaseCandidate> =
  | { kind: 'installed'; installed: InstalledKernel; release: R }
  | { kind: 'update'; installed: InstalledKernel; release: R }
  | { kind: 'new'; release: R }

/**
 * One row per installed kernel that a source still publishes (installed, or an update when the
 * same Chromium version has a newer build there), then one "new" row per Chromium version no
 * installed kernel covers. Only the newest build of each version per source is offered.
 */
export function planKernelRows<R extends ReleaseCandidate>(installed: readonly InstalledKernel[], releases: readonly R[]): PlannedRow<R>[] {
  const newest = new Map<string, R>()
  for (const release of [...releases].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
    const key = `${release.source.toLowerCase()}|${release.chromium}`
    if (!newest.has(key)) newest.set(key, release)
  }
  const latest = [...newest.values()]
  const rows: PlannedRow<R>[] = []
  const covered = new Set<string>()
  for (const kernel of installed) {
    const same = latest
      .filter((release) => release.chromium === kernel.chromium)
      .filter((release) => !kernel.sourceRepo || release.source.toLowerCase() === kernel.sourceRepo.toLowerCase())
    const release = same[0]
    if (!release) continue
    covered.add(release.chromium)
    if (release.sha256 === kernel.sha256) rows.push({ kind: 'installed', installed: kernel, release })
    else if (release.publishedAt > kernel.builtAt) rows.push({ kind: 'update', installed: kernel, release })
    else rows.push({ kind: 'installed', installed: kernel, release })
  }
  const installedShas = new Set(installed.map((kernel) => kernel.sha256))
  for (const release of latest) {
    if (covered.has(release.chromium) || installedShas.has(release.sha256)) continue
    rows.push({ kind: 'new', release })
  }
  return rows
}

/** The builds planKernelRows leaves out (older builds of each version), newest first, for rolling back. */
export function olderBuilds<R extends ReleaseCandidate>(releases: readonly R[], rows: readonly PlannedRow<R>[]): R[] {
  const shown = new Set(rows.map((row) => row.release))
  return releases.filter((release) => !shown.has(release)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
}
