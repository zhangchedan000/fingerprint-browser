import { prismRevision } from '../shared/kernel-id'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Prism patch 015 (window-screen) keeps the browser window inside the screen a window claims, so
 * such kernels may claim a screen smaller than the real one. It first shipped in the prism5 builds.
 */
const WINDOW_SCREEN_REVISION = 5
const WINDOW_SCREEN_PATCH = '015-window-screen'
/**
 * WebRTC UDP through the launcher's relay and the "禁止" mode (patch 013), released with fonts by
 * system language (007) and per-window audio and rects (006, 008). First shipped in prism7: the
 * prism6 builds only changed 014. Older kernels ignore the switches and would send WebRTC UDP
 * directly, so this must never be claimed for them.
 */
const WEBRTC_RELAY_REVISION = 7
/** Where a local build's source shows the relay is in (patch 013 in prism7). */
const WEBRTC_RELAY_SOURCE = { file: 'services/network/p2p/socket_udp.cc', marker: 'FingerprintUdpRelay' }
/**
 * Windows fonts of its own (patch 007, prism16): the kernel reads `prism-system-fonts` next to chrome.exe
 * and never this computer's fonts, so nothing is installed into Windows (kernel-fonts.ts links the shared
 * font package there).
 */
const BUILT_IN_FONTS_REVISION = 16
/** Where a local build's source shows its own fonts (patch 007 in prism16). */
const BUILT_IN_FONTS_SOURCE = { file: 'components/services/font_data/font_data_service_impl.cc', marker: 'PrismFontManager' }

export { prismRevision }

type ManifestFeatures = { windowScreen?: boolean; webrtcRelay?: boolean; builtInFonts?: boolean; releaseTag?: string; assetName?: string }

const revisionOf = (manifest: ManifestFeatures) => prismRevision(manifest.releaseTag) ?? prismRevision(manifest.assetName) ?? 0

export function kernelFitsWindowToScreen(manifest: ManifestFeatures): boolean {
  return manifest.windowScreen ?? revisionOf(manifest) >= WINDOW_SCREEN_REVISION
}

export function kernelRelaysWebRtc(manifest: ManifestFeatures): boolean {
  return manifest.webrtcRelay ?? revisionOf(manifest) >= WEBRTC_RELAY_REVISION
}

export function kernelHasOwnFonts(manifest: ManifestFeatures): boolean {
  return manifest.builtInFonts ?? revisionOf(manifest) >= BUILT_IN_FONTS_REVISION
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
  return manifest ? kernelRelaysWebRtc(manifest) : localBuildRelaysWebRtc(executable)
}

export async function executableHasOwnFonts(executable: string): Promise<boolean> {
  const manifest = await installedManifestOf(executable)
  return manifest ? kernelHasOwnFonts(manifest) : localBuildHasOwnFonts(executable)
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
  return localBuildSourceHas(executable, WEBRTC_RELAY_SOURCE.file, WEBRTC_RELAY_SOURCE.marker)
}

export async function localBuildHasOwnFonts(executable: string): Promise<boolean> {
  return localBuildSourceHas(executable, BUILT_IN_FONTS_SOURCE.file, BUILT_IN_FONTS_SOURCE.marker)
}

/** A local build's own source tree (src\out\Default\chrome.exe → src) contains the marker. */
async function localBuildSourceHas(executable: string, file: string, marker: string): Promise<boolean> {
  let folder = dirname(executable)
  for (let level = 0; level < 4; level++) {
    try {
      return (await readFile(join(folder, ...file.split('/')), 'utf8')).includes(marker)
    } catch { /* not the source root */ }
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return false
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
