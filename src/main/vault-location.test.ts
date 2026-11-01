import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkTarget, deletePreviousVault, relocateVault, resolveVaultLocation, revertVault, rewritePaths } from './vault-location'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const exists = (path: string) => access(path).then(() => true, () => false)

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fb-vault-'))
  roots.push(root)
  const userData = join(root, 'userData')
  const vault = join(userData, 'vault')
  await mkdir(join(vault, 'kernels', '144.0.7559.132', 'browser'), { recursive: true })
  await mkdir(join(vault, 'profiles', 'a', 'user-data', 'Default'), { recursive: true })
  await mkdir(join(vault, 'tunnel-runtime'), { recursive: true })
  const exe = join(vault, 'kernels', '144.0.7559.132', 'browser', 'chrome.exe')
  await writeFile(exe, 'binary')
  await writeFile(join(vault, 'profiles.json'), JSON.stringify({ schemaVersion: 12 }))
  await writeFile(join(vault, 'settings.json'), JSON.stringify({ browserExecutable: exe, other: '/elsewhere/x' }))
  await writeFile(join(vault, 'profiles', 'a', 'user-data', 'Default', 'Cookies'), 'cookies')
  await writeFile(join(vault, 'tunnel-runtime', 'config.yaml'), 'rebuilt on start')
  return { root, userData, vault }
}

describe('data folder location', () => {
  it('defaults to userData/vault', async () => {
    const { userData, vault } = await setup()
    expect(await resolveVaultLocation(userData)).toEqual({ path: vault, defaultPath: vault })
  })

  it('copies everything, rewrites the kernel path and points the app at the new folder, keeping the old one', async () => {
    const { root, userData, vault } = await setup()
    const target = join(root, 'D-drive', 'fb-data')
    const progress: number[] = []
    await relocateVault(userData, vault, target, (step) => progress.push(step.copiedFiles))
    expect(await readFile(join(target, 'profiles', 'a', 'user-data', 'Default', 'Cookies'), 'utf8')).toBe('cookies')
    expect(await exists(join(target, 'tunnel-runtime'))).toBe(false)
    const settings = JSON.parse(await readFile(join(target, 'settings.json'), 'utf8'))
    expect(settings.browserExecutable).toBe(join(target, 'kernels', '144.0.7559.132', 'browser', 'chrome.exe'))
    expect(settings.other).toBe('/elsewhere/x')
    expect(progress.at(-1)).toBe(4)
    expect(await resolveVaultLocation(userData)).toEqual({ path: target, defaultPath: vault, previous: vault })
    expect(await exists(join(vault, 'profiles.json'))).toBe(true)

    await revertVault(userData)
    expect((await resolveVaultLocation(userData)).path).toBe(vault)
    await revertVault(userData)
    await deletePreviousVault(userData)
    expect(await exists(vault)).toBe(false)
    expect(await resolveVaultLocation(userData)).toEqual({ path: target, defaultPath: vault })
  })

  it('refuses unsafe targets', async () => {
    const { root, vault } = await setup()
    await expect(checkTarget(vault, vault)).rejects.toThrow('就是当前')
    await expect(checkTarget(vault, join(vault, 'inner'))).rejects.toThrow('里面')
    await expect(checkTarget(vault, join(vault, '..'))).rejects.toThrow('上级')
    const full = join(root, 'full')
    await mkdir(full)
    await writeFile(join(full, 'x.txt'), 'x')
    await expect(checkTarget(vault, full)).rejects.toThrow('空文件夹')
  })

  it('falls back to the default folder when the chosen one is gone', async () => {
    const { root, userData, vault } = await setup()
    const target = join(root, 'moved')
    await relocateVault(userData, vault, target)
    await rm(target, { recursive: true })
    expect(await resolveVaultLocation(userData)).toMatchObject({ path: vault, missing: target })
  })

  it('rewrites only whole leading folder names', () => {
    expect(rewritePaths({ a: '/v/x', b: '/vault2/x', c: ['/v'] }, '/v', '/n')).toEqual({ a: '/n/x', b: '/vault2/x', c: ['/n'] })
  })
})

describe('the key 0.5.5 and 0.5.6 kept in app-cache', () => {
  it('is taken back only when userData has none', async () => {
    const { adoptAppCacheKey } = await import('./vault-location')
    const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'fb-key-'))
    const userData = join(root, 'userData')
    const appCache = join(root, 'vault', 'app-cache')
    mkdirSync(appCache, { recursive: true })
    writeFileSync(join(appCache, 'Local State'), 'moved')
    adoptAppCacheKey(userData, appCache)
    expect(readFileSync(join(userData, 'Local State'), 'utf8')).toBe('moved')
    writeFileSync(join(userData, 'Local State'), 'original')
    adoptAppCacheKey(userData, appCache)
    expect(readFileSync(join(userData, 'Local State'), 'utf8')).toBe('original')
  })
})
