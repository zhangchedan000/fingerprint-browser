import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { kernelFitsWindowToScreen, localBuildFitsWindowToScreen, prismRevision } from './kernel-features'

it('reads the prism revision from release tags', () => {
  expect(prismRevision('kernel-156.0.8078.47-prism5')).toBe(5)
  expect(prismRevision('155.0.8059.84-prism12')).toBe(12)
  expect(prismRevision('v0.2.0')).toBeUndefined()
})

it('lets prism5 and later kernels claim a smaller screen', () => {
  expect(kernelFitsWindowToScreen({ releaseTag: 'kernel-156.0.8078.47-prism4' })).toBe(false)
  expect(kernelFitsWindowToScreen({ releaseTag: '156.0.8078.47-prism5' })).toBe(true)
  expect(kernelFitsWindowToScreen({})).toBe(false)
  expect(kernelFitsWindowToScreen({ windowScreen: true })).toBe(true)
})

it('finds the window-screen patch in a local build lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prism-lock-'))
  await mkdir(join(root, 'out', 'Default'), { recursive: true })
  const exe = join(root, 'out', 'Default', 'chrome.exe')
  expect(await localBuildFitsWindowToScreen(exe)).toBe(false)
  await writeFile(join(root, 'prism-build-lock.json'), '{"seriesPath":"extra/fingerprint/015-window-screen.patch"}')
  expect(await localBuildFitsWindowToScreen(exe)).toBe(true)
})
