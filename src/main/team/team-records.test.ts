import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyCheckRecords, collectCheckRecords } from './team-records'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

function fakeStores(runtime: string) {
  const checks = new Map<string, unknown>()
  const restored: unknown[] = []
  const profiles = {
    profileRuntimePath: () => runtime,
    get: () => ({ proxyCheck: restored.at(-1) }),
    restoreProxyCheck: async (_id: string, input: unknown) => { restored.push(input) }
  }
  const store = {
    get: async (id: string) => checks.get(id),
    set: async (id: string, report: unknown) => { checks.set(id, report) }
  }
  return { profiles: profiles as never, checks: store as never, restored, map: checks }
}

describe('check records', () => {
  it('carry the proxy, fingerprint, deep check and IP score records to the other computer', async () => {
    root = await mkdtemp(join(tmpdir(), 'fb-records-'))
    const target = fakeStores(join(root, 'target'))
    const records = {
      proxyCheck: { ok: true, ip: '203.0.113.7' },
      fingerprintCheck: { checkedAt: '2026-10-29T00:00:00.000Z' },
      deepCheck: { sites: [] },
      ipSites: { checkedAt: '2026-10-29T00:00:00.000Z' }
    }
    await applyCheckRecords(target.profiles, target.checks, 'w1', records)
    expect(target.restored).toEqual([records.proxyCheck])
    expect(target.map.get('w1')).toEqual(records.fingerprintCheck)
    expect(JSON.parse(await readFile(join(root, 'target', 'deep-check.json'), 'utf8'))).toEqual(records.deepCheck)
    expect(JSON.parse(await readFile(join(root, 'target', 'ip-sites.json'), 'utf8'))).toEqual(records.ipSites)
    // And they come back out the same way.
    expect(await collectCheckRecords(target.profiles, target.checks, 'w1')).toEqual(records)
  })

  it('leaves what is not in the records alone and ignores junk', async () => {
    root = await mkdtemp(join(tmpdir(), 'fb-records-'))
    const target = fakeStores(join(root, 'target'))
    await applyCheckRecords(target.profiles, target.checks, 'w1', 'junk')
    await applyCheckRecords(target.profiles, target.checks, 'w1', { fingerprintCheck: { checkedAt: 5 } })
    expect(target.map.size).toBe(0)
    expect(target.restored).toEqual([])
    expect(await collectCheckRecords(target.profiles, target.checks, 'w1')).toEqual({})
  })
})
