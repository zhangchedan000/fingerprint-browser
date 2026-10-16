import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { ProfileDraft, ProxyCheckSummary } from '../shared/types'
import { ProfileStore } from './profile-store'
import type { SecretCodec } from './secret-codec'

const paths: string[] = []
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

/** Marks encrypted values so tests can see what was encrypted on disk. */
const codec: SecretCodec = {
  encode: (value) => value ? `enc:${value}` : '',
  decode: (value) => value.startsWith('enc:') ? value.slice(4) : value
}

async function vault(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'fb-library-'))
  paths.push(path)
  return path
}

async function open(path?: string): Promise<ProfileStore> {
  const store = new ProfileStore(path ?? await vault(), codec)
  await store.initialize()
  return store
}

const PROXY = { protocol: 'socks5' as const, host: '203.0.113.9', port: 1080, username: 'u1', password: 'secret' }
const check = (ip: string, checkedAt = '2026-10-01T00:00:00.000Z'): ProxyCheckSummary => ({ ok: true, ip, latencyMs: 100, checkedAt })

function draft(name: string, patch: Partial<ProfileDraft> = {}): ProfileDraft {
  return { ...defaultProfileDraft(), name, ...patch }
}

describe('windows refer to the proxy and group libraries', () => {
  it('stores a typed proxy and group once and lets windows share them', async () => {
    const store = await open()
    const [a, b] = await store.createMany([
      draft('A', { proxy: PROXY, group: 'TikTok 美区' }),
      draft('B', { proxy: { ...PROXY }, group: 'TikTok 美区' })
    ])
    expect(store.listProxies()).toHaveLength(1)
    expect(store.listGroups()).toHaveLength(1)
    expect(a.proxyId).toBe(b.proxyId)
    expect(a.groupId).toBe(b.groupId)
    expect(a.proxy).toMatchObject({ host: '203.0.113.9', password: 'secret' })
    expect(a.group).toBe('TikTok 美区')

    const saved = JSON.parse(await readFile(store.profilesPath, 'utf8'))
    expect(saved.profiles[0].proxy).toBeUndefined()
    expect(saved.profiles[0].group).toBeUndefined()
    expect(saved.proxies[0].password).toBe('enc:secret')
    expect(JSON.stringify(saved.profiles)).not.toContain('secret')
  })

  it('changes every window when a library proxy or group changes', async () => {
    const store = await open()
    const [a, b] = await store.createMany([draft('A', { proxy: PROXY, group: 'G1' }), draft('B', { proxy: PROXY, group: 'G1' })])
    const changed: string[] = []
    store.onProfilesChanged((profiles) => changed.push(...profiles.map((profile) => profile.id)))

    await store.updateProxy(a.proxyId, { ...PROXY, password: '', passwordStored: true, note: '备用' })
    expect(store.get(b.id).proxy.password).toBe('secret')
    await store.updateProxy(a.proxyId, { ...PROXY, host: '198.51.100.7', password: 'new', note: '备用' })
    expect(store.get(a.id).proxy.host).toBe('198.51.100.7')
    expect(store.get(b.id).proxy).toMatchObject({ host: '198.51.100.7', password: 'new' })

    await store.setProxyCheck(a.id, check('198.51.100.7'))
    expect(store.get(b.id).proxyCheck?.ip).toBe('198.51.100.7')

    await store.updateGroup(a.groupId, { name: 'G2' })
    expect(store.get(b.id).group).toBe('G2')
    expect(changed).toContain(b.id)
  })

  it('assigns windows to a proxy or group through one call', async () => {
    const store = await open()
    const [a, b] = await store.createMany([draft('A'), draft('B')])
    const proxy = await store.createProxy({ ...PROXY, note: '' })
    const group = await store.createGroup({ name: '店铺', note: '后台' })
    const assigned = await store.assignMany([a.id, b.id], { proxyId: proxy.id, groupId: group.id })
    expect(assigned.every((profile) => profile.proxyId === proxy.id && profile.group === '店铺')).toBe(true)
    expect(store.proxyUsers(proxy.id).map((profile) => profile.name).sort()).toEqual(['A', 'B'])
    await expect(store.assignMany([a.id], { proxyId: 'missing' })).rejects.toThrow('代理库')

    await store.setRuntime(a.id, { status: 'running' })
    await expect(store.assignMany([a.id], { proxyId: '' })).rejects.toThrow('正在运行')
    await expect(store.assignMany([a.id], { groupId: '' })).resolves.toHaveLength(1)
  })

  it('asks what windows switch to before a proxy in use is removed', async () => {
    const store = await open()
    const [a] = await store.createMany([draft('A', { proxy: PROXY })])
    const spare = await store.createProxy({ ...PROXY, host: '198.51.100.20', note: '' })
    await expect(store.removeProxy(a.proxyId)).rejects.toThrow('1 个窗口')
    await store.removeProxy(a.proxyId, spare.id)
    expect(store.get(a.id).proxyId).toBe(spare.id)
    await store.removeProxy(spare.id, '')
    expect(store.get(a.id).proxy.protocol).toBe('direct')
    expect(store.listProxies()).toHaveLength(0)
  })

  it('makes windows ungrouped when their group is removed', async () => {
    const store = await open()
    const [a] = await store.createMany([draft('A', { group: 'G' })])
    await store.removeGroup(a.groupId)
    expect(store.get(a.id)).toMatchObject({ groupId: '', group: '' })
  })

  it('keeps the window own proxy when an edit leaves the saved password empty', async () => {
    const store = await open()
    const a = await store.create(draft('A', { proxy: PROXY }))
    const edited = await store.update(a.id, draft('A', { proxy: { ...PROXY, password: '', passwordStored: true } }))
    expect(edited.proxyId).toBe(a.proxyId)
    const picked = await store.update(a.id, draft('A', { proxyId: a.proxyId }))
    expect(picked.proxyId).toBe(a.proxyId)
  })

  it('duplicates a window onto the same library proxy', async () => {
    const store = await open()
    const a = await store.create(draft('A', { proxy: PROXY }))
    const copy = await store.duplicate(a.id)
    expect(copy.proxyId).toBe(a.proxyId)
    expect(store.listProxies()).toHaveLength(1)
  })

  it('restores a window whose proxy was removed meanwhile by adding the saved proxy back', async () => {
    const store = await open()
    const a = await store.create(draft('A', { proxy: PROXY, group: 'G' }))
    await store.remove(a.id)
    await store.removeProxy(a.proxyId)
    await store.removeGroup(a.groupId)
    const [item] = await store.listTrash()
    const restored = await store.restore(item.trashId)
    expect(restored.proxy).toMatchObject({ host: '203.0.113.9', password: 'secret' })
    // The deleted group is not recreated; the window goes to Ungrouped.
    expect(restored.group).toBe('')
    expect(store.listProxies()).toHaveLength(1)
  })

  it('flags a window whose proxy reference points nowhere instead of going direct', async () => {
    const path = await vault()
    const base = draft('A')
    await writeFile(join(path, 'profiles.json'), JSON.stringify({
      schemaVersion: 12,
      proxies: [],
      groups: [],
      profiles: [{ ...base, proxy: undefined, group: undefined, id: 'p1', proxyId: 'gone', groupId: 'gone', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }]
    }))
    const store = await open(path)
    expect(store.get('p1')).toMatchObject({ proxyMissing: true, groupId: '' })
  })

  it('upgrades windows that stored their own proxy and group, keeping a copy of the old file', async () => {
    const path = await vault()
    const legacy = (id: string, patch: Record<string, unknown>) => ({
      ...defaultProfileDraft(), name: id, id, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', status: 'closed', ...patch
    })
    await writeFile(join(path, 'profiles.json'), JSON.stringify({
      schemaVersion: 11,
      nextSerialNumber: 4,
      profiles: [
        legacy('a', { serialNumber: 1, group: '美区', proxy: { ...PROXY, password: 'enc:secret' }, proxyCheck: check('203.0.113.9', '2026-09-01T00:00:00.000Z') }),
        legacy('b', { serialNumber: 2, group: '美区', proxy: { ...PROXY, password: 'enc:secret' }, proxyCheck: check('203.0.113.10', '2026-09-02T00:00:00.000Z') }),
        legacy('c', { serialNumber: 3, group: '', proxy: { protocol: 'direct', host: '', username: '', password: '' }, proxyCheck: check('192.0.2.1') })
      ]
    }))
    const store = await open(path)
    const [a, b, c] = ['a', 'b', 'c'].map((id) => store.get(id))
    expect(store.listProxies()).toHaveLength(1)
    expect(a.proxyId).toBe(b.proxyId)
    expect(a.proxy.password).toBe('secret')
    expect(a.proxyCheck?.ip).toBe('203.0.113.10')
    expect(store.listGroups().map((group) => group.name)).toEqual(['美区'])
    expect(c).toMatchObject({ proxyId: '', groupId: '', proxyCheck: { ip: '192.0.2.1' } })
    expect((await readdir(path)).some((name) => name === 'profiles.v11.before-upgrade.json')).toBe(true)

    const reopened = await open(path)
    expect(reopened.get('a').proxyId).toBe(a.proxyId)
    expect(reopened.listProxies()).toHaveLength(1)
  })
})

describe('adding proxies in bulk and following the proxy IP', () => {
  it('adds new proxies, counts ones already in the library and reports bad entries', async () => {
    const store = await open()
    await store.createProxy({ ...PROXY, note: '' })
    const result = await store.createProxies([
      { ...PROXY, note: '' },
      { ...PROXY, host: '198.51.100.1', note: '批量' },
      { ...PROXY, host: '', note: '' }
    ])
    expect(result.created.map((proxy) => proxy.host)).toEqual(['198.51.100.1'])
    expect(result.duplicates).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].index).toBe(2)
    expect(store.listProxies()).toHaveLength(2)
  })

  it('switches assigned windows to follow the proxy exit IP when asked', async () => {
    const store = await open()
    const base = defaultProfileDraft()
    const a = await store.create(draft('A', { fingerprint: { ...base.fingerprint, networkIdentityMode: 'manual' } }))
    const proxy = await store.createProxy({ ...PROXY, note: '' })
    await store.assignMany([a.id], { proxyId: proxy.id })
    expect(store.get(a.id).fingerprint.networkIdentityMode).toBe('manual')
    await store.assignMany([a.id], { proxyId: proxy.id, followProxyIdentity: true })
    expect(store.get(a.id).fingerprint.networkIdentityMode).toBe('proxy')
  })
})

describe('group colour and note', () => {
  it('gives new groups a colour in turn, keeps a chosen one and updates name, colour and note together', async () => {
    const store = await open()
    const first = await store.createGroup({ name: 'A' })
    const second = await store.createGroup({ name: 'B', color: '#43a047', note: '备注' })
    expect(first.color).toMatch(/^#[\da-f]{6}$/i)
    expect(second).toMatchObject({ color: '#43a047', note: '备注' })
    const typed = await store.create(draft('W', { group: 'C' }))
    expect(store.listGroups().find((group) => group.id === typed.groupId)?.color).toMatch(/^#/)
    await expect(store.createGroup({ name: 'X', color: 'red' })).rejects.toThrow('颜色')
    await expect(store.updateGroup(first.id, { name: 'B' })).rejects.toThrow('同名')
    const updated = await store.updateGroup(first.id, { name: 'A2', color: '#1e88e5', note: '新' })
    expect(updated).toMatchObject({ name: 'A2', color: '#1e88e5', note: '新' })
  })

  it('reads groups saved before they had a colour', async () => {
    const path = await vault()
    await writeFile(join(path, 'profiles.json'), JSON.stringify({
      schemaVersion: 12, proxies: [], groups: [{ id: 'g1', name: '旧分组', createdAt: '2026-10-01T00:00:00.000Z' }], profiles: []
    }))
    const store = await open(path)
    expect(store.listGroups()[0]).toMatchObject({ name: '旧分组', note: '' })
    expect(store.listGroups()[0].color).toMatch(/^#/)
  })
})
