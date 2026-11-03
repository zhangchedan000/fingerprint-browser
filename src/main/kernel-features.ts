import { prismRevision, SUPPORTED_PRISM_REVISION } from '../shared/kernel-id'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export { prismRevision, SUPPORTED_PRISM_REVISION }

/**
 * This launcher runs prism21 and later kernels only: Google's own Chromium source with the 15 Prism
 * patches (private repo official-base/). Older kernels (ungoogled-chromium base, prism20 and before)
 * belong to the launchers released before it (v0.5.59 and earlier), which stay downloadable.
 */
/** What a window on an older kernel is told when it is opened or checked. */
export const UNSUPPORTED_KERNEL = '这个内核不是 prism21，新版启动器只能用 prism21 及以后的内核，请在「内核管理」里更新内核'

type KernelNames = { releaseTag?: string; assetName?: string; supported?: boolean }

/**
 * A kernel by its manifest (a local build records `supported` when imported) or by its release tag or
 * zip name ("prism21", "…-prism21_windows_x64.zip").
 */
export function kernelSupported(names: KernelNames): boolean {
  return names.supported ?? (prismRevision(names.releaseTag) ?? prismRevision(names.assetName) ?? 0) >= SUPPORTED_PRISM_REVISION
}

/** The listed kernel downloads this launcher offers: prism21 and later (older ones are not shown at all). */
export function supportedReleases<R extends { tag: string; asset: { name: string } }>(releases: readonly R[]): R[] {
  return releases.filter((release) => kernelSupported({ releaseTag: release.tag, assetName: release.asset.name }))
}

/** A local build of Google's source was prepared in stages: build\prism-stages next to its src folder. */
const OFFICIAL_BASE_STAGES = 'prism-stages'

/**
 * Whether this kernel executable (installed, with manifest.json a folder or two above it, or a local
 * build's out\Default\chrome.exe) is one this launcher runs.
 */
export async function executableSupported(executable: string): Promise<boolean> {
  const manifest = await installedManifestOf(executable)
  return manifest ? kernelSupported(manifest) : localBuildHasFolder(executable, OFFICIAL_BASE_STAGES)
}

async function installedManifestOf(executable: string): Promise<KernelNames | undefined> {
  let folder = dirname(executable)
  for (let level = 0; level < 3; level++) {
    try {
      const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as Record<string, unknown>
      if (typeof manifest.executableRelative === 'string') return manifest as KernelNames
    } catch { /* not a kernel folder */ }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return undefined
}

/** A folder of this name sits next to a local build's source tree (src\out\Default\chrome.exe → build). */
async function localBuildHasFolder(executable: string, name: string): Promise<boolean> {
  let folder = dirname(executable)
  for (let level = 0; level < 5; level++) {
    try {
      if ((await stat(join(folder, name))).isDirectory()) return true
    } catch { /* not here */ }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return false
}
