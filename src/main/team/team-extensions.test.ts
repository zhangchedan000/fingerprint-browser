import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionStore } from '../extension-store'
import { packProfileState, unpackProfileState } from './team-archive'
import { adoptWindowExtensions, windowExtensions } from './team-extensions'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text)
}

async function unpacked(name: string): Promise<string> {
  const folder = join(root, 'source-folders', name)
  await put(join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name, version: '1.0' }))
  await put(join(folder, 'background.js'), '// ' + name)
  return folder
}

describe('team window extensions', () => {
  it('go along with the window, with the same ID (keyed) or their data moved to this computer\'s ID (older, keyless)', async () => {
    root = await mkdtemp(join(tmpdir(), 'fb-team-ext-'))
    const storeA = new ExtensionStore(join(root, 'vault-a'))
    await storeA.initialize()
    const keyed = await storeA.importDirectory(await unpacked('Wallet'))
    // One imported before keys were added.
    const legacy = await storeA.importDirectory(await unpacked('Old'), { keepManifest: true })
    expect(JSON.parse(await readFile(join(keyed.path, 'manifest.json'), 'utf8')).key).toBeTruthy()
    const keyedId = (await storeA.identity(keyed.id)).chromeId
    const legacyIdA = (await storeA.identity(legacy.id)).chromeId

    const source = join(root, 'a-user-data')
    await put(join(source, 'Default', 'Local Extension Settings', keyedId, '000003.log'), 'wallet data')
    await put(join(source, 'Default', 'Local Extension Settings', legacyIdA, '000003.log'), 'old data')
    const profile = { extensionIds: [keyed.id, legacy.id] } as never
    const packed = await packProfileState(source, [], join(root, 'state.tgz'), {}, { extensions: await windowExtensions(storeA, profile) })
    expect(packed.size).toBeGreaterThan(0)

    const storeB = new ExtensionStore(join(root, 'vault-b'))
    await storeB.initialize()
    const target = join(root, 'b-user-data')
    await mkdir(target, { recursive: true })
    const folder = join(root, 'incoming-extensions')
    const { extensions } = await unpackProfileState(packed.file, target, {}, folder)
    expect(extensions?.map((item) => item.name)).toEqual(['Wallet', 'Old'])
    const ids = await adoptWindowExtensions(storeB, folder, extensions!, target)

    expect(storeB.list().map((item) => item.name).sort()).toEqual(['Old', 'Wallet'])
    expect(ids).toHaveLength(2)
    const walletB = storeB.list().find((item) => item.name === 'Wallet')!
    const oldB = storeB.list().find((item) => item.name === 'Old')!
    expect((await storeB.identity(walletB.id)).chromeId).toBe(keyedId)
    const legacyIdB = (await storeB.identity(oldB.id)).chromeId
    expect(legacyIdB).not.toBe(legacyIdA)
    expect(await readFile(join(target, 'Default', 'Local Extension Settings', keyedId, '000003.log'), 'utf8')).toBe('wallet data')
    expect(await readFile(join(target, 'Default', 'Local Extension Settings', legacyIdB, '000003.log'), 'utf8')).toBe('old data')

    // The next time it comes back, the copies already here are used.
    const again = await unpackProfileState(packed.file, target, {}, folder)
    expect(await adoptWindowExtensions(storeB, folder, again.extensions!, target)).toEqual(ids)
    expect(storeB.list()).toHaveLength(2)
  })
})
