import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { validateProxyConfig } from '../shared/validation'
import { ProfileStore } from './profile-store'
import { portableDraft } from './profile-portable'
import { setSubscriptionResolver, subscriptionEndpoint } from './proxy-bridge'

const roots: string[] = []
afterEach(async () => {
  setSubscriptionResolver(undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('subscription nodes (订阅) as window proxies', () => {
  it('keeps only which node; through 网络加速 always the fastest acceleration node', () => {
    expect(validateProxyConfig({ protocol: 'socks5', host: 'x', port: 1, username: 'u', password: 'p', subscription: { source: ' 机场 ', node: '香港 01' } }))
      .toEqual({ protocol: 'http', host: '', username: '', password: '', subscription: { source: '机场', node: '香港 01' } })
    expect(validateProxyConfig({ protocol: 'http', host: '', username: '', password: '', subscription: { source: '机场', node: 'n' }, tunnel: { enabled: true, mode: 'manual', node: 'US · v' } }).tunnel)
      .toEqual({ enabled: true, mode: 'auto' })
    expect(() => validateProxyConfig({ protocol: 'http', host: '', username: '', password: '', subscription: { source: '', node: 'n' } })).toThrow('订阅节点无效')
  })

  it('is one library entry per node, used by windows like a library proxy and carried to other computers', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'subscription-proxy-'))
    roots.push(vault)
    const store = new ProfileStore(vault)
    await store.initialize()
    const node = { protocol: 'http' as const, host: '', username: '', password: '', subscription: { source: '机场', node: '香港 01' }, note: '' }
    const entry = await store.createProxy(node)
    await expect(store.createProxy(node)).rejects.toThrow('已有相同的代理')
    const other = await store.createProxy({ ...node, subscription: { source: '机场', node: '美国 02' } })
    expect(other.id).not.toBe(entry.id)
    expect(store.findLibraryProxy(validateProxyConfig(node))?.id).toBe(entry.id)

    const window = await store.create({ ...defaultProfileDraft(), proxyId: entry.id })
    expect(store.get(window.id).proxy.subscription).toEqual({ source: '机场', node: '香港 01' })
    const draft = portableDraft(store.get(window.id), { passwords: 'keep', extensions: false })
    expect(draft.proxy).toMatchObject({ subscription: { source: '机场', node: '香港 01' } })

    // Renamed subscription: the entries (and the windows on them) follow.
    expect(await store.renameSubscription('机场', '机场A')).toEqual([window.id])
    expect(store.get(window.id).proxy.subscription).toEqual({ source: '机场A', node: '香港 01' })
    const reopened = new ProfileStore(vault)
    await reopened.initialize()
    expect(reopened.get(window.id).proxy.subscription).toEqual({ source: '机场A', node: '香港 01' })
  })

  it('becomes the node’s local port for each connection, chained when 网络加速 is on, never direct', async () => {
    const config = validateProxyConfig({ protocol: 'http', host: '', username: '', password: '', subscription: { source: '机场', node: 'n' }, tunnel: { enabled: true, mode: 'auto' } })
    await expect(subscriptionEndpoint(config)).rejects.toThrow('订阅节点没有运行')
    const asked: Array<[string, boolean]> = []
    setSubscriptionResolver(async (ref, chained) => {
      asked.push([`${ref.source}/${ref.node}`, chained])
      return { type: 'http', host: '127.0.0.1', port: 7001 }
    })
    expect(await subscriptionEndpoint(config)).toEqual({ protocol: 'http', host: '127.0.0.1', port: 7001, username: '', password: '' })
    expect(asked).toEqual([['机场/n', true]])
  })
})
