import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packProfileState, unpackProfileState } from './team-archive'
import { PASSWORDS_DIR, type KeyProtector } from './saved-passwords'

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
  it('carries the login state, browser data, cookies and check records, and replaces just that on the other computer', async () => {
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
    await put(join(source, 'Default', 'Bookmarks'), '{"roots":{}}')
    await put(join(source, 'Default', 'Web Data'), 'autofill')
    await put(join(source, 'Default', 'Service Worker', 'ScriptCache', 'x'), 'scripts')
    await put(join(source, 'Default', 'Cache', 'Cache_Data', 'f_000001'), 'cache')
    await put(join(source, 'Default', 'Network', 'Cookies'), 'dpapi cookies')
    await put(join(source, 'Local State'), 'source key')
    const cookies = [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }]

    const records = { fingerprintCheck: { checkedAt: '2026-10-29T00:00:00.000Z' } }
    const packed = await packProfileState(source, cookies as never, join(root, 'state.tgz'), {}, { records })
    expect(packed.size).toBeGreaterThan(0)
    expect(packed.sha256).toMatch(/^[a-f\d]{64}$/)
    expect(existsSync(join(source, '.prism-team-cookies.json'))).toBe(false)
    expect(existsSync(join(source, '.prism-team-records.json'))).toBe(false)

    const target = join(root, '目标 ก user-data')
    await put(join(target, 'Local State'), 'target key')
    await put(join(target, 'Default', 'History'), 'target history')
    await put(join(target, 'Default', 'Session Storage', 'stale'), 'signed-out leftover')
    const restored = await unpackProfileState(packed.file, target)

    expect(restored).toEqual({ cookies, records })
    expect(await readFile(join(target, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('local storage')
    expect(await readFile(join(target, 'Default', 'IndexedDB', 'https_example.com_0.indexeddb.leveldb', 'LOG'), 'utf8')).toBe('indexeddb')
    expect(await readFile(join(target, 'Default', 'WebStorage', '1', 'IndexedDB', 'db'), 'utf8')).toBe('bucket')
    expect(await readFile(join(target, 'Default', 'Sessions', 'Tabs_1'), 'utf8')).toBe('tabs')
    expect(await readFile(join(target, 'Default', 'Preferences'), 'utf8')).toBe('{"profile":{}}')
    // Bookmarks, history and autofill come along (as on the first computer).
    expect(await readFile(join(target, 'Default', 'History'), 'utf8')).toBe('source history')
    expect(await readFile(join(target, 'Default', 'Bookmarks'), 'utf8')).toBe('{"roots":{}}')
    expect(await readFile(join(target, 'Default', 'Web Data'), 'utf8')).toBe('autofill')
    // Not the window's state: this computer's own copy stays.
    expect(await readFile(join(target, 'Local State'), 'utf8')).toBe('target key')
    for (const gone of [
      ['Default', 'Session Storage', 'stale'],
      ['Default', 'WebStorage', '1', 'CacheStorage'],
      ['Default', 'Service Worker'],
      ['Default', 'Cache'],
      ['Default', 'Network', 'Cookies'],
      ['.prism-team-cookies.json'],
      ['.prism-team-records.json']
    ]) expect(existsSync(join(target, ...gone)), gone.join('/')).toBe(false)
    expect((await readdir(root)).filter((name) => /incoming|previous/.test(name))).toEqual([])
  })

  it('takes saved passwords along, with their key locked again for the other computer', async () => {
    const root = await tempRoot()
    const source = join(root, 'a')
    const target = join(root, 'b')
    // A stand-in for DPAPI: each computer's user locks with its own byte.
    const lock = (user: number): KeyProtector => ({
      protect: async (data) => Buffer.from(data.map((byte) => byte ^ user)),
      unprotect: async (data) => Buffer.from(data.map((byte) => byte ^ user))
    })
    const key = Buffer.alloc(32, 7)
    const wrapped = (user: number) => Buffer.concat([Buffer.from('DPAPI'), Buffer.from(key.map((byte) => byte ^ user))]).toString('base64')
    await put(join(source, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: wrapped(0x11) }, other: 1 }))
    await put(join(source, 'Default', 'Login Data'), 'saved passwords')
    await put(join(target, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'b-own-key', app_bound_encrypted_key: 'keep' }, browser: { x: 1 } }))
    await put(join(target, 'Default', 'Login Data'), 'b passwords')
    const packed = await packProfileState(source, [], join(root, 'state.tgz'), { protector: lock(0x11) })
    expect(existsSync(join(source, PASSWORDS_DIR))).toBe(false)
    await unpackProfileState(packed.file, target, { protector: lock(0x22) })
    expect(await readFile(join(target, 'Default', 'Login Data'), 'utf8')).toBe('saved passwords')
    const state = JSON.parse(await readFile(join(target, 'Local State'), 'utf8'))
    expect(state.os_crypt).toEqual({ encrypted_key: wrapped(0x22), app_bound_encrypted_key: 'keep' })
    expect(state.browser).toEqual({ x: 1 })
  })

  it('leaves passwords out when the key cannot be unlocked, and still carries the rest', async () => {
    const root = await tempRoot()
    const source = join(root, 'a')
    await put(join(source, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIxx').toString('base64') } }))
    await put(join(source, 'Default', 'Login Data'), 'saved passwords')
    await put(join(source, 'Default', 'Preferences'), '{}')
    const errors: unknown[] = []
    const broken: KeyProtector = { protect: async () => { throw new Error('no') }, unprotect: async () => { throw new Error('locked') } }
    const packed = await packProfileState(source, [], join(root, 'state.tgz'), { protector: broken, onError: (error) => errors.push(error) })
    expect(errors).toHaveLength(1)
    const target = join(root, 'b')
    await unpackProfileState(packed.file, target, { protector: broken })
    expect(existsSync(join(target, 'Default', 'Preferences'))).toBe(true)
    expect(existsSync(join(target, 'Default', 'Login Data'))).toBe(false)
  })
})
