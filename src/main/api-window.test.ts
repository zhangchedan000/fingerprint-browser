import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { ProxyConfig, ProxyTestResult } from '../shared/types'
import type { ApiProxyEndpoint } from './api-proxy'
import { apiProxyFor, draftLinkCheck } from './api-window'
import { ProfileStore } from './profile-store'
import type { SecretCodec } from './secret-codec'

const paths: string[] = []
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

const codec: SecretCodec = {
  encode: (value) => value ? `enc:${value}` : '',
  decode: (value) => value.startsWith('enc:') ? value.slice(4) : value
}

async function open(path: string): Promise<ProfileStore> {
  const store = new ProfileStore(path, codec)
  await store.initialize()
  return store
}

/** A provider handing out the given proxies in turn, and a check that places each port's exit. */
function provider(exits: Array<{ port: number; ip: string; countryCode: string; ok?: boolean; rotating?: boolean }>) {
  const fetched: number[] = []
  let next = 0
  const fetchProxy = async (): Promise<ApiProxyEndpoint> => {
    const exit = exits[next++]
    if (!exit) throw new Error('提取次数已用完')
    fetched.push(exit.port)
    return { protocol: 'socks5', host: '198.51.100.1', port: exit.port, username: 'u', password: `pw${exit.port}` }
  }
  const tested: Array<Pick<ProxyConfig, 'port' | 'password'>> = []
  const tester = async (config: ProxyConfig): Promise<ProxyTestResult> => {
    tested.push({ port: config.port, password: config.password })
    const exit = exits.find((item) => item.port === config.port)
    return exit?.ok === false || !exit
      ? { ok: false, latencyMs: 0, error: '连接超时' }
      : exit.rotating
        ? { ok: true, latencyMs: 10, ip: exit.ip, countryCode: exit.countryCode, geoConfidence: 'conflict', rotating: true, geoConflict: '轮换代理' }
        : { ok: true, latencyMs: 10, ip: exit.ip, countryCode: exit.countryCode, geoConfidence: 'consensus' }
  }
  return { fetchProxy, tester, fetched, tested }
}

async function apiWindow() {
  const path = await mkdtemp(join(tmpdir(), 'fb-api-window-'))
  paths.push(path)
  const store = await open(path)
  const draft = defaultProfileDraft()
  draft.proxy = { protocol: 'http', host: '', username: '', password: '', apiUrl: 'https://white.example.com/api?region=US&num=1' }
  const profile = await store.create(draft)
  return { path, store, id: profile.id }
}

describe('API 提取 windows keep their proxy while it works', () => {
  it('takes a proxy once, then keeps using it; history gets new IPs only', async () => {
    const { store, id } = await apiWindow()
    const api = provider([{ port: 31001, ip: '203.0.113.1', countryCode: 'US' }])
    const first = await apiProxyFor(store, id, api.tester, { region: 'US', attempts: 3 }, api.fetchProxy)
    expect(first).toMatchObject({ fetched: 1, mismatch: false, check: { ip: '203.0.113.1' } })
    const again = await apiProxyFor(store, id, api.tester, { region: 'US', attempts: 3 }, api.fetchProxy)
    expect(again).toMatchObject({ fetched: 0, mismatch: false })
    expect(api.fetched).toEqual([31001])
    expect(store.get(id).apiProxy?.history?.map((entry) => entry.ip)).toEqual(['203.0.113.1'])
    expect(store.get(id).apiProxy?.endpoint).toMatchObject({ port: 31001, fetchedAt: expect.any(String) })
  })

  it('takes a new proxy when the current one stops working, or on 换一个 IP', async () => {
    const { store, id } = await apiWindow()
    const api = provider([
      { port: 31001, ip: '203.0.113.1', countryCode: 'US' },
      { port: 31002, ip: '203.0.113.2', countryCode: 'US' },
      { port: 31003, ip: '203.0.113.3', countryCode: 'US' }
    ])
    await apiProxyFor(store, id, api.tester, {}, api.fetchProxy)
    // 换一个 IP: a new one even though the first works.
    await apiProxyFor(store, id, api.tester, { refresh: true }, api.fetchProxy)
    expect(store.get(id).proxy.port).toBe(31002)
    // The second stops working: the next launch takes the third.
    const dead = { ...api, tester: async (config: ProxyConfig) => config.port === 31002 ? { ok: false, latencyMs: 0, error: '连接超时' } : api.tester(config) }
    const outcome = await apiProxyFor(store, id, dead.tester, {}, api.fetchProxy)
    expect(outcome).toMatchObject({ fetched: 1, check: { ip: '203.0.113.3' } })
    expect(store.get(id).apiProxy?.history?.map((entry) => entry.ip)).toEqual(['203.0.113.3', '203.0.113.2', '203.0.113.1'])
  })

  it('replaces a proxy in another country up to three times, then reports the mismatch', async () => {
    const { store, id } = await apiWindow()
    const api = provider([
      { port: 31001, ip: '187.189.167.137', countryCode: 'MX' },
      { port: 31002, ip: '203.56.25.217', countryCode: 'MY' },
      { port: 31003, ip: '203.0.113.3', countryCode: 'US' }
    ])
    const found = await apiProxyFor(store, id, api.tester, { region: 'US', attempts: 3 }, api.fetchProxy)
    expect(found).toMatchObject({ fetched: 3, mismatch: false, check: { countryCode: 'US' } })

    const elsewhere = provider([1, 2, 3].map((n) => ({ port: 32000 + n, ip: `187.189.167.${n}`, countryCode: 'MX' })))
    const missed = await apiProxyFor(store, id, elsewhere.tester, { region: 'US', attempts: 3, refresh: true }, elsewhere.fetchProxy)
    expect(missed).toMatchObject({ fetched: 3, mismatch: true, check: { countryCode: 'MX' } })
    // Confirmed by the user: the proxy in use is kept as it is, nothing more is taken.
    const kept = await apiProxyFor(store, id, elsewhere.tester, { attempts: 3 }, elsewhere.fetchProxy)
    expect(kept).toMatchObject({ fetched: 0, mismatch: false })
  })

  it('勾选: a launch keeps the working proxy wherever its IP is; 取消勾选: the next one takes a new proxy', async () => {
    const { path, store, id } = await apiWindow()
    const api = provider([
      { port: 31001, ip: '203.0.113.1', countryCode: 'US' },
      { port: 31002, ip: '203.0.113.2', countryCode: 'US' }
    ])
    await apiProxyFor(store, id, api.tester, {}, api.fetchProxy)
    // The same proxy now exits in Mexico: kept, pointed out, nothing new taken.
    const moved = { ...api, tester: async (config: ProxyConfig): Promise<ProxyTestResult> => ({ ...await api.tester(config), countryCode: 'MX' }) }
    const kept = await apiProxyFor(store, id, moved.tester, { region: 'US', attempts: 3, keepWorking: true }, api.fetchProxy)
    expect(kept).toMatchObject({ fetched: 0, mismatch: true, check: { countryCode: 'MX' } })
    expect(api.fetched).toEqual([31001])

    await store.setApiReleased(id, true)
    expect(store.get(id).apiProxy?.released).toBe(true)
    // Survives a restart (the window list and cloud keep it too).
    expect((await open(path)).get(id).apiProxy?.released).toBe(true)
    const fresh = await apiProxyFor(store, id, api.tester, { region: 'US', attempts: 3, keepWorking: true }, api.fetchProxy)
    expect(fresh).toMatchObject({ fetched: 1, mismatch: false, check: { ip: '203.0.113.2' } })
    // The new proxy is the one in use: ticked again.
    expect(store.get(id).apiProxy?.released).toBeUndefined()
    expect(store.get(id).proxy.port).toBe(31002)
  })

  it('keeps the proxy password across a restart, encrypted in the file', async () => {
    const { path, store, id } = await apiWindow()
    const api = provider([{ port: 31001, ip: '203.0.113.1', countryCode: 'US' }])
    await apiProxyFor(store, id, api.tester, {}, api.fetchProxy)
    const file = await readFile(join(path, 'profiles.json'), 'utf8')
    expect(file).toContain('"password": "enc:pw31001"')
    expect(file).not.toContain('"pw31001"')
    const reopened = await open(path)
    expect(reopened.get(id).proxy).toMatchObject({ host: '198.51.100.1', port: 31001, password: 'pw31001' })
    expect(reopened.get(id).apiProxy?.endpoint).not.toHaveProperty('password')
  })
})

describe('API 提取 windows never end on a dead proxy when one worked', () => {
  it('puts the working proxy (in another country) back when the new ones all fail', async () => {
    const { store, id } = await apiWindow()
    const api = provider([
      { port: 31001, ip: '187.189.167.137', countryCode: 'MX' },
      { port: 31002, ip: '203.0.113.2', countryCode: 'US', ok: false },
      { port: 31003, ip: '203.0.113.3', countryCode: 'US', ok: false }
    ])
    await apiProxyFor(store, id, api.tester, {}, api.fetchProxy)
    const outcome = await apiProxyFor(store, id, api.tester, { region: 'US', attempts: 2 }, api.fetchProxy)
    expect(outcome).toMatchObject({ mismatch: true, check: { ok: true, countryCode: 'MX' } })
    expect(store.get(id).proxy).toMatchObject({ port: 31001, password: 'pw31001' })
  })
})

describe('API 提取 windows log every extraction and check', () => {
  it('does not take more proxies when the link gives a rotating one', async () => {
    const { store, id } = await apiWindow()
    const api = provider([
      { port: 31001, ip: '78.179.144.99', countryCode: 'TR', rotating: true },
      { port: 31002, ip: '203.0.113.2', countryCode: 'US' }
    ])
    const outcome = await apiProxyFor(store, id, api.tester, { region: 'US', attempts: 3, trigger: 'launch' }, api.fetchProxy)
    expect(outcome).toMatchObject({ fetched: 1, mismatch: true, check: { rotating: true } })
    expect(api.fetched).toEqual([31001])
    // The kept proxy still rotates at the next launch: checked, nothing taken.
    const again = await apiProxyFor(store, id, api.tester, { region: 'US', attempts: 3, trigger: 'launch' }, api.fetchProxy)
    expect(again).toMatchObject({ fetched: 0, mismatch: true })
    expect(api.fetched).toEqual([31001])
    expect(store.get(id).apiProxy?.log?.map((entry) => [entry.trigger, entry.fetched ?? false, entry.rotating ?? false])).toEqual([
      ['launch', false, true],
      ['launch', true, true]
    ])
  })

  it('keeps where the address the link gave is, and failures too, newest first', async () => {
    const { path, store, id } = await apiWindow()
    const api = provider([{ port: 31001, ip: '203.0.113.1', countryCode: 'US' }])
    const located: string[] = []
    const locate = async (host: string) => { located.push(host); return { countryCode: 'US', city: 'Los Angeles' } }
    await apiProxyFor(store, id, api.tester, { locate }, api.fetchProxy)
    await expect(apiProxyFor(store, id, api.tester, { refresh: true, locate }, api.fetchProxy)).rejects.toThrow('提取次数已用完')
    const log = store.get(id).apiProxy?.log ?? []
    expect(log[0]).toMatchObject({ trigger: 'refresh', fetched: true, ok: false, error: '提取次数已用完' })
    expect(log[1]).toMatchObject({ trigger: 'check', fetched: true, ok: true, address: '198.51.100.1:31001', addressPlace: { countryCode: 'US', city: 'Los Angeles' }, ip: '203.0.113.1', countryCode: 'US' })
    expect(store.get(id).apiProxy?.endpoint?.place).toEqual({ countryCode: 'US', city: 'Los Angeles' })
    // Checking the kept proxy again does not look its server up again.
    await apiProxyFor(store, id, api.tester, { locate }, api.fetchProxy)
    expect(located).toEqual(['198.51.100.1'])
    const reopened = await open(path)
    expect(reopened.get(id).apiProxy?.log).toHaveLength(3)
    expect(reopened.get(id).apiProxy?.endpoint?.place).toEqual({ countryCode: 'US', city: 'Los Angeles' })
  })

  it('a link checked in a new window: the same proxy again while it answers, a new one when asked or dead', async () => {
    const kept: ApiProxyEndpoint = { protocol: 'socks5', host: '198.51.100.1', port: 31001, username: 'u', password: 'p' }
    const ok = (ip: string) => ({ result: { ok: true, latencyMs: 10, ip } as ProxyTestResult })
    let fetches = 0
    const fetchNew = async () => { fetches += 1; return ok(`203.0.113.${100 + fetches}`) }
    const same = await draftLinkCheck(kept, false, async () => ok('203.0.113.1'), fetchNew)
    expect(same).toMatchObject({ fetched: false, checked: { result: { ip: '203.0.113.1' } } })
    expect(fetches).toBe(0)
    // 换一个 IP / 取消勾选.
    expect(await draftLinkCheck(kept, true, async () => ok('203.0.113.1'), fetchNew)).toMatchObject({ fetched: true, checked: { result: { ip: '203.0.113.101' } } })
    // The kept one stopped answering: a new one, and why.
    const dead = await draftLinkCheck(kept, false, async () => ({ result: { ok: false, latencyMs: 0, error: '连接超时' } as ProxyTestResult }), fetchNew)
    expect(dead).toMatchObject({ fetched: true, failedKept: { error: '连接超时' }, checked: { result: { ip: '203.0.113.102' } } })
    // Nothing kept yet: the link gives one.
    expect(await draftLinkCheck(undefined, false, async () => ok('x'), fetchNew)).toMatchObject({ fetched: true })
  })
})
