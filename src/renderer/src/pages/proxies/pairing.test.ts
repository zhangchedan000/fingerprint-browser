import { describe, expect, it } from 'vitest'
import { groupPairs, pairProxies } from './pairing'

const windows = [{ id: 'a', proxyId: '' }, { id: 'b', proxyId: 'old' }, { id: 'c', proxyId: '' }, { id: 'd', proxyId: '' }]

describe('pairing proxies with windows', () => {
  it('skips windows that already have a proxy unless asked to overwrite', () => {
    expect(pairProxies(['p1', 'p2'], windows, { cycle: false, overwrite: false }))
      .toEqual([{ windowId: 'a', proxyId: 'p1' }, { windowId: 'c', proxyId: 'p2' }])
    expect(pairProxies(['p1', 'p2'], windows, { cycle: false, overwrite: true }).map((pair) => pair.windowId)).toEqual(['a', 'b'])
  })

  it('reuses proxies from the start only when cycling', () => {
    expect(pairProxies(['p1', 'p2'], windows, { cycle: true, overwrite: false }).map((pair) => pair.proxyId)).toEqual(['p1', 'p2', 'p1'])
    expect(pairProxies([], windows, { cycle: true, overwrite: true })).toEqual([])
  })

  it('groups pairs by proxy for the assign call', () => {
    const grouped = groupPairs(pairProxies(['p1', 'p2'], windows, { cycle: true, overwrite: false }))
    expect([...grouped]).toEqual([['p1', ['a', 'd']], ['p2', ['c']]])
  })
})
