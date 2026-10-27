import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
  it('carries the login state and cookies only, and replaces just that on the other computer', async () => {
    const root = await tempRoot()
    // Outside every ANSI code page Windows tar could use for its arguments.
    const source = join(root, '源 ก user-data')
    await put(join(source, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'local storage')
    await put(join(source, 'Default', 'IndexedDB', 'https_example.com_0.indexeddb.leveldb', 'LOG'), 'indexeddb')
    await put(join(source, 'Default', 'WebStorage', '1', 'IndexedDB', 'db'), 'bucket')
    await put(join(source, 'Default', 'WebStorage', '1', 'CacheStorage', 'big'), 'bucket cache')
    await put(join(source, 'Default', 'Sessions', 'Tabs_1'), 'tabs')
    await put(join(source, 'Default', 'Preferences'), '{"profile":{}}')
    await put(join(source, 'Default', 'History'), 'source history')
    await put(join(source, 'Default', 'Service Worker', 'ScriptCache', 'x'), 'scripts')
    await put(join(source, 'Default', 'Cache', 'Cache_Data', 'f_000001'), 'cache')
    await put(join(source, 'Default', 'Network', 'Cookies'), 'dpapi cookies')
    await put(join(source, 'Local State'), 'source key')
    const cookies = [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }]

    const packed = await packProfileState(source, cookies as never, join(root, 'state.tgz'))
    expect(packed.size).toBeGreaterThan(0)
    expect(packed.sha256).toMatch(/^[a-f\d]{64}$/)
    expect(existsSync(join(source, '.prism-team-cookies.json'))).toBe(false)

    const target = join(root, '目标 ก user-data')
    await put(join(target, 'Local State'), 'target key')
    await put(join(target, 'Default', 'History'), 'target history')
    await put(join(target, 'Default', 'Session Storage', 'stale'), 'signed-out leftover')
    const restored = await unpackProfileState(packed.file, target)

    expect(restored).toEqual(cookies)
    expect(await readFile(join(target, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('local storage')
    expect(await readFile(join(target, 'Default', 'IndexedDB', 'https_example.com_0.indexeddb.leveldb', 'LOG'), 'utf8')).toBe('indexeddb')
    expect(await readFile(join(target, 'Default', 'WebStorage', '1', 'IndexedDB', 'db'), 'utf8')).toBe('bucket')
    expect(await readFile(join(target, 'Default', 'Sessions', 'Tabs_1'), 'utf8')).toBe('tabs')
    expect(await readFile(join(target, 'Default', 'Preferences'), 'utf8')).toBe('{"profile":{}}')
    // Not login state: this computer's own copy stays.
    expect(await readFile(join(target, 'Default', 'History'), 'utf8')).toBe('target history')
    expect(await readFile(join(target, 'Local State'), 'utf8')).toBe('target key')
    for (const gone of [
      ['Default', 'Session Storage', 'stale'],
      ['Default', 'WebStorage', '1', 'CacheStorage'],
      ['Default', 'Service Worker'],
      ['Default', 'Cache'],
      ['Default', 'Network', 'Cookies'],
      ['.prism-team-cookies.json']
    ]) expect(existsSync(join(target, ...gone)), gone.join('/')).toBe(false)
    expect((await readdir(root)).filter((name) => /incoming|previous/.test(name))).toEqual([])
  })
})
