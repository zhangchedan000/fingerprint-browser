import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { executableSupported, kernelSupported, prismRevision, supportedReleases } from './kernel-features'

it('reads the prism revision from release tags', () => {
  expect(prismRevision('kernel-156.0.8078.47-prism5')).toBe(5)
  expect(prismRevision('155.0.8059.84-prism12')).toBe(12)
  expect(prismRevision('prism11')).toBe(11)
  expect(prismRevision('v0.2.0')).toBeUndefined()
  expect(prismRevision('ungoogled-chromium_156.0.8078.47-prism5_windows_x64.zip')).toBe(5)
})

it('runs prism21 and later kernels only, by release tag, zip name or what an import recorded', () => {
  expect(kernelSupported({ releaseTag: 'prism21', assetName: 'ungoogled-chromium_156.0.8078.47-prism21_windows_x64.zip' })).toBe(true)
  expect(kernelSupported({ releaseTag: '155.0.8059.84-prism21' })).toBe(true)
  expect(kernelSupported({ releaseTag: 'v0.6.0', assetName: 'ungoogled-chromium_156.0.8078.47-prism22_windows_x64.zip' })).toBe(true)
  expect(kernelSupported({ releaseTag: 'prism20' })).toBe(false)
  expect(kernelSupported({ releaseTag: 'prism9', assetName: 'ungoogled-chromium_156.0.8078.47-prism9_windows_x64.zip' })).toBe(false)
  expect(kernelSupported({})).toBe(false)
  expect(kernelSupported({ assetName: 'local-build-win32-x64', supported: true })).toBe(true)
  expect(kernelSupported({ assetName: 'local-build-win32-x64', supported: false })).toBe(false)
})

it('tells an installed kernel by its manifest and a local build by the prism-stages folder of Google\'s source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prism-supported-'))
  const installed = (version: string, releaseTag: string) => {
    const folder = join(root, 'kernels', version)
    return mkdir(join(folder, 'browser'), { recursive: true })
      .then(() => writeFile(join(folder, 'manifest.json'), JSON.stringify({ version, executableRelative: 'browser\\chrome.exe', releaseTag })))
      .then(() => join(folder, 'browser', 'chrome.exe'))
  }
  expect(await executableSupported(await installed('prism-156.0.8078.47', 'prism21'))).toBe(true)
  expect(await executableSupported(await installed('prism-155.0.8059.84', 'prism20'))).toBe(false)

  const build = join(root, 'ungoogled-chromium-windows', 'build')
  await mkdir(join(build, 'src', 'out', 'Default'), { recursive: true })
  const exe = join(build, 'src', 'out', 'Default', 'chrome.exe')
  expect(await executableSupported(exe)).toBe(false)
  await mkdir(join(build, 'prism-stages'))
  expect(await executableSupported(exe)).toBe(true)
})

it('lists prism21 and later downloads only', () => {
  const release = (tag: string, name: string) => ({ tag, asset: { name } })
  const listed = [
    release('prism21', 'ungoogled-chromium_156.0.8078.47-prism21_windows_x64.zip'),
    release('prism21', 'ungoogled-chromium_155.0.8059.84-prism21_windows_x64.zip'),
    release('prism20', 'ungoogled-chromium_156.0.8078.47-prism20_windows_x64.zip'),
    release('v0.4.0', 'ungoogled-chromium_156.0.8078.47-prism9_windows_x64.zip')
  ]
  expect(supportedReleases(listed).map((item) => item.asset.name)).toEqual([
    'ungoogled-chromium_156.0.8078.47-prism21_windows_x64.zip',
    'ungoogled-chromium_155.0.8059.84-prism21_windows_x64.zip'
  ])
})
