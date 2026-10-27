import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Prism patch 015 (window-screen) keeps the browser window inside the screen a window claims, so
 * such kernels may claim a screen smaller than the real one. It first shipped in the prism5 builds.
 */
const WINDOW_SCREEN_REVISION = 5
const WINDOW_SCREEN_PATCH = '015-window-screen'

/**
 * "kernel-156.0.8078.47-prism5" / "156.0.8078.47-prism5" → 5; app releases (v0.2.0) carry it in the
 * zip name instead ("ungoogled-chromium_156.0.8078.47-prism5_windows_x64.zip").
 */
export function prismRevision(name: string | undefined): number | undefined {
  const match = name?.match(/-prism(\d+)(?:_|$)/)
  return match ? Number(match[1]) : undefined
}

export function kernelFitsWindowToScreen(manifest: { windowScreen?: boolean; releaseTag?: string; assetName?: string }): boolean {
  const revision = prismRevision(manifest.releaseTag) ?? prismRevision(manifest.assetName) ?? 0
  return manifest.windowScreen ?? revision >= WINDOW_SCREEN_REVISION
}

/**
 * The kernel chosen as default is stored by its executable path: an installed kernel
 * (kernels\<version>\browser\chrome.exe) has its manifest.json a folder or two above it,
 * a local build is checked through its source tree.
 */
export async function executableFitsWindowToScreen(executable: string): Promise<boolean> {
  let folder = dirname(executable)
  for (let level = 0; level < 3; level++) {
    try {
      const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as Record<string, unknown>
      if (typeof manifest.executableRelative === 'string') return kernelFitsWindowToScreen(manifest)
    } catch { /* not a kernel folder */ }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return localBuildFitsWindowToScreen(executable)
}

/**
 * A local build (out\Default\chrome.exe) carries the patches it was built with in the source
 * tree's prism-build-lock.json, a few folders above the executable.
 */
export async function localBuildFitsWindowToScreen(executable: string): Promise<boolean> {
  let folder = dirname(executable)
  for (let level = 0; level < 4; level++) {
    try {
      return (await readFile(join(folder, 'prism-build-lock.json'), 'utf8')).includes(WINDOW_SCREEN_PATCH)
    } catch { /* not in this folder */ }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return false
}
