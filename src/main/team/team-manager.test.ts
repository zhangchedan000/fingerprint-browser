import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../../shared/defaults'
import type { TeamSyncEvent } from '../../shared/team'
import type { PortableCookie } from '../cookie-file'
import type { CookieManager } from '../cookie-manager'
import { ProfileStore } from '../profile-store'
import { identitySecretCodec } from '../secret-codec'
import { TeamManager } from './team-manager'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface FakeRecord {
  id: string
  name: string
  note: string
  source_id: string
  config: unknown
  config_rev: number
  assignees: string[]
  data: string
  data_rev: number
  data_by: string
  data_sha256: string
  data_size: number
  updated: string
}

/**
 * The parts of the team server (server/team) the app uses, with the same rules: members see
 * assigned windows only, one holder at a time, uploads need the lock and the next revision.
 */
function fakeServer() {
  const users = [
    { id: 'owner1', username: 'boss', name: '老板', role: 'owner', disabled: false, created: '', password: 'ownerpass' },
    { id: 'member1', username: 'alice', name: '小A', role: 'member', disabled: false, created: '', password: 'alicepass' }
  ]
  const records = new Map<string, FakeRecord>()
  const files = new Map<string, Buffer>()
  const locks = new Map<string, { holder: string; expires: number; device: string }>()
  let sequence = 0
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const userOf = (request: Request) => users.find((user) => request.headers.get('authorization') === `token-${user.id}`)
  const visible = (record: FakeRecord, user: (typeof users)[number]) => user.role === 'owner' || record.assignees.includes(user.id)
  const publicUser = ({ password: _password, ...user }: (typeof users)[number]) => user

  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const path = url.pathname
    const user = userOf(request)
    if (path === '/api/collections/users/auth-with-password') {
      const body = await request.json() as { identity: string; password: string }
      const found = users.find((item) => item.username === body.identity && item.password === body.password)
      return found ? json(200, { token: `token-${found.id}`, record: publicUser(found) }) : json(400, { message: 'Failed to authenticate.' })
    }
    if (path === '/api/collections/users/auth-refresh') return user ? json(200, { token: `token-${user.id}`, record: publicUser(user) }) : json(401, {})
    if (path.startsWith('/api/files/team_profiles/')) {
      const [, , , , id, name] = path.split('/')
      if (url.searchParams.get('token') !== 'file-token') return json(404, {})
      const file = files.get(`${id}/${name}`)
      return new Response(file ? new Uint8Array(file) : null, { status: file ? 200 : 404 })
    }
    if (!user) return json(401, {})
    if (path === '/api/files/token') return json(200, { token: 'file-token' })
    if (path === '/api/collections/team_locks/records') {
      return json(200, { items: [...locks].map(([profile, lock]) => ({ id: profile, profile, ...lock })), page: 1, totalItems: locks.size })
    }
    const lockMatch = /^\/api\/team\/profiles\/(\w+)\/(lock|heartbeat|unlock)$/.exec(path)
    if (lockMatch) {
      const [, id, mode] = lockMatch
      const record = records.get(id)
      if (!record || !visible(record, user)) return json(404, {})
      const lock = locks.get(id)
      const live = lock && lock.expires > Date.now()
      if (mode === 'unlock') {
        if (lock && (lock.holder === user.id || !live)) locks.delete(id)
        return json(200, { released: true })
      }
      if (live && lock.holder !== user.id) return json(409, { message: `「${users.find((item) => item.id === lock.holder)!.name}」正在使用这个窗口.` })
      if (mode === 'heartbeat' && !lock) return json(409, { message: '占用已失效.' })
      locks.set(id, { holder: user.id, expires: Date.now() + 90_000, device: 'test' })
      return json(200, { expires: Date.now() + 90_000, lockMs: 90_000 })
    }
    const recordMatch = /^\/api\/collections\/team_profiles\/records(?:\/(\w+))?$/.exec(path)
    if (recordMatch) {
      const id = recordMatch[1]
      if (request.method === 'GET' && !id) {
        return json(200, { items: [...records.values()].filter((record) => visible(record, user)), page: 1, totalItems: records.size })
      }
      const existing = id ? records.get(id) : undefined
      if (id && (!existing || !visible(existing, user))) return json(404, {})
      if (request.method === 'GET') return json(200, existing)
      const form = await request.formData()
      const field = (name: string) => form.get(name) === null ? undefined : String(form.get(name))
      if (user.role !== 'owner' && ['name', 'note', 'config', 'assignees'].some((name) => form.has(name))) return json(404, {})
      const record: FakeRecord = existing ?? {
        id: `rec${++sequence}`, name: '', note: '', source_id: '', config: null, config_rev: 0, assignees: [],
        data: '', data_rev: 0, data_by: '', data_sha256: '', data_size: 0, updated: ''
      }
      if (field('name') !== undefined) record.name = field('name')!
      if (field('note') !== undefined) record.note = field('note')!
      if (field('source_id') !== undefined) record.source_id = field('source_id')!
      if (form.has('assignees')) record.assignees = form.getAll('assignees').map(String).filter(Boolean)
      if (field('config') !== undefined) {
        record.config = JSON.parse(field('config')!)
        record.config_rev += 1
      }
      if (field('data_rev') !== undefined) {
        if (existing) {
          const lock = locks.get(existing.id)
          if (!lock || lock.holder !== user.id) return json(409, { message: '没有占用这个窗口，不能上传登录态.' })
          if (Number(field('data_rev')) !== existing.data_rev + 1) return json(409, { message: '登录态已被别人更新过，请重新打开窗口.' })
        }
        const blob = form.get('data') as Blob
        record.data = `state_${record.data_rev + 1}.tgz`
        files.set(`${record.id}/${record.data}`, Buffer.from(await blob.arrayBuffer()))
        record.data_rev += 1
        record.data_by = user.id
        record.data_sha256 = field('data_sha256') ?? ''
        record.data_size = Number(field('data_size') ?? 0)
      }
      records.set(record.id, record)
      return json(200, record)
    }
    return json(404, { message: `fake server: ${request.method} ${path}` })
  }
  return { fetcher: fetcher as typeof fetch, records, locks }
}

/** One computer: its vault, windows, and the cookie jar of each window's browser. */
async function computer(server: ReturnType<typeof fakeServer>) {
  const vault = await mkdtemp(join(tmpdir(), 'team-manager-'))
  roots.push(vault)
  const profiles = new ProfileStore(vault)
  await profiles.initialize()
  const jars = new Map<string, PortableCookie[]>()
  const cookies = {
    exportCookies: async (id: string) => jars.get(id) ?? [],
    importCookies: async (id: string, list: PortableCookie[]) => { jars.set(id, list); return list.length }
  } as unknown as CookieManager
  const events: TeamSyncEvent[] = []
  const team = new TeamManager(vault, profiles, cookies, identitySecretCodec, (event) => events.push(event), undefined, server.fetcher)
  await team.initialize()
  return { vault, profiles, jars, team, events }
}

const cookie = (value: string) => ({ name: 'sid', value, domain: '.example.com', path: '/' }) as PortableCookie

describe('TeamManager', () => {
  it('hands a window and its login state from the owner to a member and back', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    const member = await computer(server)
    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    await member.team.login('team.test', 'alice', 'alicepass').catch(() => undefined)
    await member.team.login('http://team.test', 'alice', 'alicepass')

    const draft = defaultProfileDraft()
    const local = await owner.profiles.create({
      ...draft,
      name: '店铺 1',
      proxy: { protocol: 'http', host: '10.0.0.1', port: 8080, username: 'u', password: 'proxy-secret' },
      account: { platform: 'TikTok', username: 'shop1', password: 'account-secret' }
    })
    await mkdir(join(owner.profiles.profileDataPath(local.id), 'Default'), { recursive: true })
    await writeFile(join(owner.profiles.profileDataPath(local.id), 'Default', 'Preferences'), 'from owner')
    owner.jars.set(local.id, [cookie('owner-session')])

    const [shared] = await owner.team.share([local.id], ['member1'])
    expect(shared).toMatchObject({ name: '店铺 1', assignees: ['member1'], dataRev: 1, localId: local.id })

    // The member sees it, puts it on their computer and opens it: config and state come down.
    const visible = await member.team.listProfiles()
    expect(visible.map((item) => item.id)).toEqual([shared.id])
    const copyId = await member.team.addToComputer(shared.id)
    const copy = member.profiles.get(copyId)
    expect(copy.proxy.password).toBe('proxy-secret')
    expect(copy.account.password).toBe('account-secret')
    expect(copy.fingerprint.seed).toBe(local.fingerprint.seed)
    expect(member.team.links()).toEqual([{ profileId: copyId, teamId: shared.id, readOnly: true, pendingUpload: false }])
    expect(() => member.team.assertEditable(copyId)).toThrow('只有主账号可以修改或导出')

    await member.team.beforeLaunch(copyId)
    expect(await readFile(join(member.profiles.profileDataPath(copyId), 'Default', 'Preferences'), 'utf8')).toBe('from owner')
    expect(member.jars.get(copyId)).toEqual([cookie('owner-session')])
    expect(server.locks.get(shared.id)?.holder).toBe('member1')

    // While the member has it, the owner cannot open it.
    await expect(owner.team.beforeLaunch(local.id)).rejects.toThrow('小A」正在使用')

    // The member's session changes the state; closing uploads it and frees the window.
    await writeFile(join(member.profiles.profileDataPath(copyId), 'Default', 'Preferences'), 'from member')
    member.jars.set(copyId, [cookie('member-session')])
    await member.team.afterExit(copyId)
    expect(server.records.get(shared.id)).toMatchObject({ data_rev: 2, data_by: 'member1' })
    expect(server.locks.has(shared.id)).toBe(false)
    expect(member.events.map((event) => event.phase)).toEqual(['pulling', 'done', 'pushing', 'done'])

    // The owner opens it next and continues from the member's state.
    await owner.team.beforeLaunch(local.id)
    expect(await readFile(join(owner.profiles.profileDataPath(local.id), 'Default', 'Preferences'), 'utf8')).toBe('from member')
    expect(owner.jars.get(local.id)).toEqual([cookie('member-session')])
    await owner.team.afterExit(local.id)
    expect(server.records.get(shared.id)?.data_rev).toBe(3)
  })

  it('applies the owner’s config changes on the member’s next open', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    const member = await computer(server)
    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    await member.team.login('http://team.test', 'alice', 'alicepass')
    const local = await owner.profiles.create({ ...defaultProfileDraft(), name: '旧名字' })
    const [shared] = await owner.team.share([local.id], ['member1'])
    const copyId = await member.team.addToComputer(shared.id)

    await owner.profiles.update(local.id, { ...owner.profiles.get(local.id), name: '新名字', startUrls: ['https://example.com/'] })
    await owner.team.afterLocalEdit(local.id)
    await member.team.beforeLaunch(copyId)
    expect(member.profiles.get(copyId)).toMatchObject({ name: '新名字', startUrls: ['https://example.com/'] })
    await member.team.launchFailed(copyId)
    expect(server.locks.has(shared.id)).toBe(false)
  })

  it('opens no window at all until signed in, and stays locked while the server is unreachable', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    const local = await owner.profiles.create(defaultProfileDraft())
    await expect(owner.team.beforeLaunch(local.id)).rejects.toThrow('请先登录')
    expect(await owner.team.status()).toMatchObject({ server: 'https://temu.orenge.ccwu.cc', user: undefined })

    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    await owner.team.beforeLaunch(local.id)

    // Next start: the saved sign-in cannot be checked, so the app stays on the sign-in page.
    const restarted = new TeamManager(owner.vault, owner.profiles, {} as CookieManager, identitySecretCodec, () => undefined, undefined,
      (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as unknown as typeof fetch)
    await restarted.initialize()
    const status = await restarted.status()
    expect(status.user).toBeUndefined()
    expect(status.offline).toContain('ENOTFOUND')
    await expect(restarted.beforeLaunch(local.id)).rejects.toThrow('请先登录')
  })

  it('keeps a failed upload and sends it on the next open', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    const local = await owner.profiles.create(defaultProfileDraft())
    await owner.team.share([local.id], [])
    await owner.team.beforeLaunch(local.id)

    const original = server.fetcher
    const failing = async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw new Error('network down')
      return original(input, init)
    }
    ;(owner.team as unknown as { api: { fetcher: typeof fetch } }).api.fetcher = failing as typeof fetch
    await owner.team.afterExit(local.id)
    expect(owner.team.links()[0].pendingUpload).toBe(true)
    expect(owner.events.at(-1)).toMatchObject({ phase: 'error' })

    ;(owner.team as unknown as { api: { fetcher: typeof fetch } }).api.fetcher = original
    await owner.team.beforeLaunch(local.id)
    expect(owner.team.links()[0].pendingUpload).toBe(false)
    expect([...server.records.values()][0].data_rev).toBe(2)
    expect(existsSync(join(owner.vault, 'team.json'))).toBe(true)
  })
})
