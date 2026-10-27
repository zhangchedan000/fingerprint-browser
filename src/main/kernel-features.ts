import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Prism patch 015 (window-screen) keeps the browser window inside the screen a window claims, so
 * such kernels may claim a screen smaller than the real one. It first shipped in the prism5 builds.
 */
const WINDOW_SCREEN_REVISION = 5
const WINDOW_SCREEN_PATCH = '015-window-screen'
/**
 * Prism patch 016 (webrtc-relay): WebRTC UDP through the launcher's relay and the "禁止" mode.
 * First shipped in prism6. Older kernels ignore the switches and would send WebRTC UDP directly.
 */
const WEBRTC_RELAY_REVISION = 6
const WEBRTC_RELAY_PATCH = '016-webrtc-relay'

/**
 * "kernel-156.0.8078.47-prism5" / "156.0.8078.47-prism5" → 5; app releases (v0.2.0) carry it in the
 * zip name instead ("ungoogled-chromium_156.0.8078.47-prism5_windows_x64.zip").
 */
export function prismRevision(name: string | undefined): number | undefined {
  const match = name?.match(/-prism(\d+)(?:_|$)/)
  return match ? Number(match[1]) : undefined
}

type ManifestFeatures = { windowScreen?: boolean; webrtcRelay?: boolean; releaseTag?: string; assetName?: string }

const revisionOf = (manifest: ManifestFeatures) => prismRevision(manifest.releaseTag) ?? prismRevision(manifest.assetName) ?? 0

export function kernelFitsWindowToScreen(manifest: ManifestFeatures): boolean {
  return manifest.windowScreen ?? revisionOf(manifest) >= WINDOW_SCREEN_REVISION
}

export function kernelRelaysWebRtc(manifest: ManifestFeatures): boolean {
  return manifest.webrtcRelay ?? revisionOf(manifest) >= WEBRTC_RELAY_REVISION
}

/**
 * The kernel chosen as default is stored by its executable path: an installed kernel
 * (kernels\<version>\browser\chrome.exe) has its manifest.json a folder or two above it,
 * a local build is checked through its source tree.
 */
export async function executableFitsWindowToScreen(executable: string): Promise<boolean> {
  const manifest = await installedManifestOf(executable)
  return manifest ? kernelFitsWindowToScreen(manifest) : localBuildFitsWindowToScreen(executable)
}

export async function executableRelaysWebRtc(executable: string): Promise<boolean> {
  const manifest = await installedManifestOf(executable)
  return manifest ? kernelRelaysWebRtc(manifest) : localBuildHasPatch(executable, WEBRTC_RELAY_PATCH)
}

async function installedManifestOf(executable: string): Promise<ManifestFeatures | undefined> {
  let folder = dirname(executable)
  for (let level = 0; level < 3; level++) {
    try {
      const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as Record<string, unknown>
      if (typeof manifest.executableRelative === 'string') return manifest as ManifestFeatures
    } catch { /* not a kernel folder */ }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return undefined
}

/**
 * A local build (out\Default\chrome.exe) carries the patches it was built with in the source
 * tree's prism-build-lock.json, a few folders above the executable.
 */
export async function localBuildFitsWindowToScreen(executable: string): Promise<boolean> {
  return localBuildHasPatch(executable, WINDOW_SCREEN_PATCH)
}

export async function localBuildRelaysWebRtc(executable: string): Promise<boolean> {
  return localBuildHasPatch(executable, WEBRTC_RELAY_PATCH)
}

async function localBuildHasPatch(executable: string, patch: string): Promise<boolean> {
  let folder = dirname(executable)
  for (let level = 0; level < 4; level++) {
    try {
      return (await readFile(join(folder, 'prism-build-lock.json'), 'utf8')).includes(patch)
    } catch { /* not in this folder */ }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return false
}
