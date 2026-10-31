import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { executableFitsWindowToScreen, kernelFitsWindowToScreen, kernelHasOwnFonts, kernelRelaysWebRtc, localBuildFitsWindowToScreen, localBuildRelaysWebRtc, prismRevision } from './kernel-features'

it('reads the prism revision from release tags', () => {
  expect(prismRevision('kernel-156.0.8078.47-prism5')).toBe(5)
  expect(prismRevision('155.0.8059.84-prism12')).toBe(12)
  expect(prismRevision('prism11')).toBe(11)
  expect(prismRevision('v0.2.0')).toBeUndefined()
  expect(prismRevision('ungoogled-chromium_156.0.8078.47-prism5_windows_x64.zip')).toBe(5)
})

it('lets prism5 and later kernels claim a smaller screen', () => {
  expect(kernelFitsWindowToScreen({ releaseTag: 'kernel-156.0.8078.47-prism4' })).toBe(false)
  expect(kernelFitsWindowToScreen({ releaseTag: '156.0.8078.47-prism5' })).toBe(true)
  expect(kernelFitsWindowToScreen({})).toBe(false)
  expect(kernelFitsWindowToScreen({ windowScreen: true })).toBe(true)
  expect(kernelFitsWindowToScreen({ releaseTag: 'v0.2.0', assetName: 'ungoogled-chromium_155.0.8059.84-prism5_windows_x64.zip' })).toBe(true)
})

it('reads the default kernel from the manifest next to its executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prism-kernels-'))
  const kernel = (version: string, assetName: string) => {
    const folder = join(root, 'kernels', version)
    return mkdir(join(folder, 'browser'), { recursive: true })
      .then(() => writeFile(join(folder, 'manifest.json'), JSON.stringify({ version, executableRelative: 'browser\\chrome.exe', assetName, releaseTag: 'v0.2.0' })))
      .then(() => join(folder, 'browser', 'chrome.exe'))
  }
  expect(await executableFitsWindowToScreen(await kernel('prism-156.0.8078.47', 'ungoogled-chromium_156.0.8078.47-prism5_windows_x64.zip'))).toBe(true)
  expect(await executableFitsWindowToScreen(await kernel('prism-155.0.8059.84', 'ungoogled-chromium_155.0.8059.84-prism4_windows_x64.zip'))).toBe(false)
  expect(await executableFitsWindowToScreen(join(root, 'elsewhere', 'chrome.exe'))).toBe(false)
})

it('finds the window-screen patch in a local build lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prism-lock-'))
  await mkdir(join(root, 'out', 'Default'), { recursive: true })
  const exe = join(root, 'out', 'Default', 'chrome.exe')
  expect(await localBuildFitsWindowToScreen(exe)).toBe(false)
  await writeFile(join(root, 'prism-build-lock.json'), '{"seriesPath":"extra/fingerprint/015-window-screen.patch"}')
  expect(await localBuildFitsWindowToScreen(exe)).toBe(true)
})

it('claims the WebRTC relay only for prism7 and later (prism6 only changed media devices)', () => {
  expect(kernelRelaysWebRtc({ releaseTag: '156.0.8078.47-prism6' })).toBe(false)
  expect(kernelRelaysWebRtc({ releaseTag: 'kernel-155.0.8059.84-prism6' })).toBe(false)
  expect(kernelRelaysWebRtc({ releaseTag: '156.0.8078.47-prism7' })).toBe(true)
  expect(kernelRelaysWebRtc({ releaseTag: 'v0.5.0', assetName: 'ungoogled-chromium_156.0.8078.47-prism7_windows_x64.zip' })).toBe(true)
  expect(kernelRelaysWebRtc({ releaseTag: 'v0.5.0', assetName: 'ungoogled-chromium_156.0.8078.47-prism6_windows_x64.zip' })).toBe(false)
  expect(kernelRelaysWebRtc({ webrtcRelay: true })).toBe(true)
})

it('finds the WebRTC relay in a local build\'s source', async () => {
  const src = await mkdtemp(join(tmpdir(), 'prism-src-'))
  await mkdir(join(src, 'out', 'Default'), { recursive: true })
  await mkdir(join(src, 'services', 'network', 'p2p'), { recursive: true })
  const exe = join(src, 'out', 'Default', 'chrome.exe')
  await writeFile(join(src, 'services', 'network', 'p2p', 'socket_udp.cc'), 'void P2PSocketUdp::Send() {}')
  expect(await localBuildRelaysWebRtc(exe)).toBe(false)
  await writeFile(join(src, 'services', 'network', 'p2p', 'socket_udp.cc'), 'std::string FingerprintUdpRelay() {}')
  expect(await localBuildRelaysWebRtc(exe)).toBe(true)
})

it('knows the kernels with their own Windows fonts (prism16+) by release tag or asset name, not by kernel id', () => {
  expect(kernelHasOwnFonts({ releaseTag: 'prism16', assetName: 'ungoogled-chromium_156.0.8078.47-prism16_windows_x64.zip' })).toBe(true)
  expect(kernelHasOwnFonts({ releaseTag: '155.0.8059.84-prism16' })).toBe(true)
  expect(kernelHasOwnFonts({ releaseTag: 'prism15', assetName: 'ungoogled-chromium_156.0.8078.47-prism15_windows_x64.zip' })).toBe(false)
  expect(kernelHasOwnFonts({ releaseTag: 'prism17' })).toBe(true)
  expect(kernelHasOwnFonts({ assetName: 'local-build-win32-x64', builtInFonts: true })).toBe(true)
  expect(kernelHasOwnFonts({})).toBe(false)
})
