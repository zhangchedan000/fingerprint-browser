import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))

const { locateBrowserForProfile, locateExactBrowserForProfile, sameChromiumKernelIds } = await import('./browser-locator')
const { collectKernelIntegrity } = await import('./kernel-integrity')

const settings = { get: () => ({ browserExecutable: '', fingerprintKernel: false }) } as never
const roots: string[] = []

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prism-locator-'))
  roots.push(root)
  return root
}

async function installKernel(vaultPath: string, id: string): Promise<void> {
  const root = join(vaultPath, 'kernels', id)
  await mkdir(join(root, 'bin'), { recursive: true })
  const executableRelative = 'bin/chrome'
  await writeFile(join(root, executableRelative), `kernel ${id}`)
  await chmod(join(root, executableRelative), 0o755)
  const integrity = await collectKernelIntegrity(root, executableRelative)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, version: id, executableRelative, ...integrity }))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('locateBrowserForProfile', () => {
  it('opens a window pinned to another computer\'s id of the same kernel', async () => {
    const vaultPath = await vault()
    await installKernel(vaultPath, 'prism-155.0.8059.84')
    const engine = await locateBrowserForProfile(settings, vaultPath, 'prism-155.0.8059.84-202610261927', { resourcesPath: vaultPath })
    expect(engine.executable).toBe(join(vaultPath, 'kernels', 'prism-155.0.8059.84', 'bin', 'chrome'))
    expect(engine.version).toBe('prism-155.0.8059.84')
    const exact = await locateExactBrowserForProfile(settings, vaultPath, 'prism-155.0.8059.84-202610261927', { resourcesPath: vaultPath })
    expect(exact.executable).toBeNull()
  })

  it('also goes the other way, preferring the newest import', async () => {
    const vaultPath = await vault()
    await installKernel(vaultPath, 'prism-155.0.8059.84-202610261927')
    await installKernel(vaultPath, 'prism-155.0.8059.84-202611011200')
    const engine = await locateBrowserForProfile(settings, vaultPath, 'prism-155.0.8059.84', { resourcesPath: vaultPath })
    expect(engine.version).toBe('prism-155.0.8059.84-202611011200')
  })

  it('never uses another Chromium version or build family', async () => {
    const vaultPath = await vault()
    await installKernel(vaultPath, 'prism-155.0.8059.85')
    await installKernel(vaultPath, 'clearcote-155.0.8059.84')
    await installKernel(vaultPath, '155.0.8059.84')
    expect(await sameChromiumKernelIds(vaultPath, 'prism-155.0.8059.84')).toEqual([])
    const engine = await locateBrowserForProfile(settings, vaultPath, 'prism-155.0.8059.84', { resourcesPath: vaultPath })
    expect(engine.executable).toBeNull()
    expect(engine.source).toBe('missing')
  })
})
