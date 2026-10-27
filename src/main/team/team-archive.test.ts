import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packProfileState, unpackProfileState } from './team-archive'

const roots: string[] = []
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'team-archive-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

describe('team login state archive', () => {
  it('carries site data and cookies, leaves caches and computer-bound files behind', async () => {
    const root = await tempRoot()
    // Outside every ANSI code page Windows tar could use for its arguments.
    const source = join(root, '源 ก user-data')
    await put(join(source, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'local storage')
    await put(join(source, 'Default', 'Preferences'), '{}')
    await put(join(source, 'Default', 'Cache', 'Cache_Data', 'f_000001'), 'cache')
    await put(join(source, 'Default', 'Network', 'Cookies'), 'dpapi cookies')
    await put(join(source, 'Default', 'Login Data'), 'dpapi passwords')
    await put(join(source, 'Local State'), 'source key')
    await put(join(source, 'SingletonLock'), 'lock')
    const cookies = [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }]

    const packed = await packProfileState(source, cookies as never, join(root, 'state.tgz'))
    expect(packed.size).toBeGreaterThan(0)
    expect(packed.sha256).toMatch(/^[a-f\d]{64}$/)

    const target = join(root, '目标 ก user-data')
    await put(join(target, 'Local State'), 'target key')
    await put(join(target, 'Default', 'Old'), 'replaced')
    const restored = await unpackProfileState(packed.file, target)

    expect(restored).toEqual(cookies)
    expect(await readFile(join(target, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('local storage')
    expect(await readFile(join(target, 'Default', 'Preferences'), 'utf8')).toBe('{}')
    // This computer's key stays, everything else is the shared copy.
    expect(await readFile(join(target, 'Local State'), 'utf8')).toBe('target key')
    for (const gone of [
      ['Default', 'Old'],
      ['Default', 'Cache'],
      ['Default', 'Network', 'Cookies'],
      ['Default', 'Login Data'],
      ['SingletonLock'],
      ['.prism-team-cookies.json']
    ]) expect(existsSync(join(target, ...gone)), gone.join('/')).toBe(false)
    expect((await import('node:fs/promises')).readdir(root)).resolves.not.toContainEqual(expect.stringMatching(/incoming|previous/))
  })
})
