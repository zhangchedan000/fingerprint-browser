import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Prism patch 015 (window-screen) keeps the browser window inside the screen a window claims, so
 * such kernels may claim a screen smaller than the real one. It first shipped in the prism5 builds.
 */
const WINDOW_SCREEN_REVISION = 5
const WINDOW_SCREEN_PATCH = '015-window-screen'

/** "kernel-156.0.8078.47-prism5" / "156.0.8078.47-prism5" → 5. */
export function prismRevision(tag: string | undefined): number | undefined {
  const match = tag?.match(/-prism(\d+)$/)
  return match ? Number(match[1]) : undefined
}

export function kernelFitsWindowToScreen(manifest: { windowScreen?: boolean; releaseTag?: string }): boolean {
  return manifest.windowScreen ?? (prismRevision(manifest.releaseTag) ?? 0) >= WINDOW_SCREEN_REVISION
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
