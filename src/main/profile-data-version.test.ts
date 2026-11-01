import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertKernelCanOpenProfileData, lastChromiumVersion } from './profile-data-version'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function dataFolder(lastVersion?: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'prism-data-version-'))
  folders.push(folder)
  if (lastVersion !== undefined) await writeFile(join(folder, 'Last Version'), lastVersion)
  return folder
}

describe('profile data version', () => {
  it('refuses an older kernel on a folder a newer kernel opened', async () => {
    const folder = await dataFolder('150.0.7871.186')
    await expect(assertKernelCanOpenProfileData(folder, '144.0.7559.132')).rejects.toThrow(/150\.0\.7871\.186.*144\.0\.7559\.132/)
  })

  it('allows the same or a newer kernel, a fresh folder and an unknown kernel version', async () => {
    const folder = await dataFolder('144.0.7559.132\n')
    expect(await lastChromiumVersion(folder)).toBe('144.0.7559.132')
    await expect(assertKernelCanOpenProfileData(folder, '144.0.7559.132')).resolves.toBeUndefined()
    await expect(assertKernelCanOpenProfileData(folder, '150.0.7871.186')).resolves.toBeUndefined()
    await expect(assertKernelCanOpenProfileData(await dataFolder(), '139.0.7258.154')).resolves.toBeUndefined()
    await expect(assertKernelCanOpenProfileData(folder, undefined)).resolves.toBeUndefined()
  })
})
