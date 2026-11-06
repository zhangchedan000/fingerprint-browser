import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultProfileDraft } from '../../shared/defaults'
import type { TeamSyncEvent } from '../../shared/team'
import type { PortableCookie } from '../cookie-file'
import type { CookieManager } from '../cookie-manager'
import { ExtensionStore } from '../extension-store'
import { fingerprintCheckStore } from '../fingerprint-check'
import { ProfileStore } from '../profile-store'
import { identitySecretCodec } from '../secret-codec'
import { TeamManager } from './team-manager'

const roots: string[] = []
afterEach(async () => {
  // A manager's background sync may still be writing team.json for a moment: retry instead of failing.
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })))
})

interface FakeRecord {
  id: string
  name: string
  note: string
  source_id: string
  owner: string
  config: unknown
  config_rev: number
  assignees: string[]
  data: string
  data_rev: number
  data_by: string
  data_sha256: string
  data_size: number
  data_device?: string
  data_device_name?: string
  updated: string
}

interface FakeDeviceState {
  id: string
  profile: string
  user: string
  device: string
  device_name: string
  device_os?: string
  data: string
  data_rev: number
  data_sha256: string
  data_size: number
  updated: string
}

/**
 * The parts of the team server (server/team) the app uses, with the same rules: members see
 * assigned windows only, one holder (account and computer) at a time, uploads need the lock and the
 * next revision, a cloud window is deleted only once it is in the recycle bins.
 */
function fakeServer() {
  const users = [
    { id: 'owner1', username: 'boss', name: '老板', role: 'owner', disabled: false, created: '', password: 'ownerpass' },
    { id: 'member1', username: 'alice', name: '小A', role: 'member', disabled: false, created: '', password: 'alicepass' }
  ]
  const records = new Map<string, FakeRecord>()
  const files = new Map<string, Buffer>()
  const locks = new Map<string, { holder: string; expires: number; device: string; device_id: string }>()
  const deviceStates = new Map<string, FakeDeviceState>()
  // team_workspaces: one per account; updated is a new time on every write.
  const workspaces = new Map<string, { id: string; user: string; data: unknown; updated: string }>()
  let clock = 0
  let sequence = 0
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const userOf = (request: Request) => users.find((user) => request.headers.get('authorization') === `token-${user.id}`)
  const visible = (record: FakeRecord, user: (typeof users)[number]) => user.role === 'owner' || record.owner === user.id || record.assignees.includes(user.id)
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
    if (path.startsWith('/api/files/team_profiles/') || path.startsWith('/api/files/team_device_states/')) {
      const [, , , , id, name] = path.split('/')
      if (url.searchParams.get('token') !== 'file-token') return json(404, {})
      const file = files.get(`${id}/${name}`)
      return new Response(file ? new Uint8Array(file) : null, { status: file ? 200 : 404 })
    }
    if (!user) return json(401, {})
    if (path === '/api/files/token') return json(200, { token: 'file-token' })
    const workspaceMatch = /^\/api\/collections\/team_workspaces\/records(?:\/(\w+))?$/.exec(path)
    if (workspaceMatch) {
      const own = [...workspaces.values()].find((item) => item.user === user.id)
      if (request.method === 'GET') {
        const items = own ? [url.searchParams.get('fields') === 'id,updated' ? { id: own.id, updated: own.updated } : own] : []
        return json(200, { items, page: 1, totalItems: items.length })
      }
      const body = await request.json() as { data: unknown }
      const record = own ?? { id: `ws${++sequence}`, user: user.id, data: null, updated: '' }
      record.data = body.data
      record.updated = `2026-11-04 00:00:${String(++clock).padStart(2, '0')}.000Z`
      workspaces.set(record.id, record)
      return json(200, record)
    }
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
      const body = await request.json().catch(() => ({})) as { deviceId?: string; device?: string; force?: boolean }
      const deviceId = String(body.deviceId ?? '')
      const sameAccount = lock?.holder === user.id
      const mine = sameAccount && lock!.device_id === deviceId
      if (mode === 'unlock') {
        if (lock && live && !mine && !(user.role === 'owner' && body.force)) {
          return json(sameAccount ? 409 : 403, { message: sameAccount ? `这个窗口正在另一台电脑「${lock.device}」上使用，请先在那台电脑上关闭.` : '这个窗口正在被别人使用.' })
        }
        if (lock) locks.delete(id)
        return json(200, { released: true })
      }
      if (live && !mine) {
        if (sameAccount) return json(409, { message: `这个窗口正在另一台电脑「${lock.device}」上使用，请先在那台电脑上关闭.` })
        return json(409, { message: `「${users.find((item) => item.id === lock.holder)!.name}」正在使用这个窗口.` })
      }
      if (mode === 'heartbeat' && !mine) return json(409, { message: '占用已失效.' })
      locks.set(id, { holder: user.id, expires: Date.now() + 90_000, device: mode === 'lock' ? String(body.device ?? '') : lock!.device, device_id: deviceId })
      return json(200, { expires: Date.now() + 90_000, lockMs: 90_000 })
    }
    // Per-computer copies (1761600008_device_states.js): own ones (the owner: all), writes need the lock.
    const stateMatch = /^\/api\/collections\/team_device_states\/records(?:\/(\w+))?$/.exec(path)
    if (stateMatch) {
      const id = stateMatch[1]
      if (request.method === 'GET') {
        const profile = /profile = "(\w+)"/.exec(url.searchParams.get('filter') ?? '')?.[1]
        const items = [...deviceStates.values()]
          .filter((state) => state.profile === profile && (user.role === 'owner' || state.user === user.id))
          .map((state) => ({ ...state, expand: { user: publicUser(users.find((item) => item.id === state.user)!) } }))
        return json(200, { items, page: 1, totalItems: items.length })
      }
      if (request.method === 'DELETE') {
        // 1761600009: the owner deletes any copy, a member their own.
        const state = id ? deviceStates.get(id) : undefined
        if (!state || (user.role !== 'owner' && state.user !== user.id)) return json(404, {})
        deviceStates.delete(state.id)
        return new Response(null, { status: 204 })
      }
      const form = await request.formData()
      const existing = id ? deviceStates.get(id) : undefined
      if (id && (!existing || existing.user !== user.id)) return json(404, {})
      const profile = existing?.profile ?? String(form.get('profile'))
      const lock = locks.get(profile)
      if (!lock || lock.holder !== user.id) return json(409, { message: '没有占用这个窗口，不能上传登录态.' })
      if (!existing && String(form.get('user')) !== user.id) return json(400, {})
      const state: FakeDeviceState = existing ?? {
        id: `dev${++sequence}`, profile, user: user.id, device: String(form.get('device')), device_name: '',
        data: '', data_rev: 0, data_sha256: '', data_size: 0, updated: ''
      }
      state.device_name = String(form.get('device_name') ?? '')
      if (form.get('device_os')) state.device_os = String(form.get('device_os'))
      state.data_rev += 1
      state.data = `device_${state.data_rev}.tgz`
      state.data_sha256 = String(form.get('data_sha256') ?? '')
      state.data_size = Number(form.get('data_size') ?? 0)
      state.updated = new Date().toISOString()
      files.set(`${state.id}/${state.data}`, Buffer.from(await (form.get('data') as Blob).arrayBuffer()))
      deviceStates.set(state.id, state)
      return json(200, state)
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
      if (request.method === 'DELETE') {
        if (user.role !== 'owner') return json(404, {})
        if (!(existing!.config as { deletedAt?: string } | undefined)?.deletedAt) return json(400, { message: '先在窗口列表里删除（移到回收站），才能删除云端备份.' })
        records.delete(id!)
        return new Response(null, { status: 204 })
      }
      const form = await request.formData()
      const field = (name: string) => form.get(name) === null ? undefined : String(form.get(name))
      // Members change only their own windows, and never who may use them.
      if (user.role !== 'owner' && (form.has('assignees') || (existing && existing.owner !== user.id && ['name', 'note', 'config'].some((name) => form.has(name))))) return json(404, {})
      const record: FakeRecord = existing ?? {
        id: `rec${++sequence}`, name: '', note: '', source_id: '', owner: user.id, config: null, config_rev: 0, assignees: [],
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
        record.data_device = field('data_device') ?? ''
        record.data_device_name = field('data_device_name') ?? ''
      }
      records.set(record.id, record)
      return json(200, record)
    }
    return json(404, { message: `fake server: ${request.method} ${path}` })
  }
  return { fetcher: fetcher as typeof fetch, records, locks, deviceStates, workspaces }
}

/** One computer: its vault, windows, and the cookie jar of each window's browser. */
async function computer(server: ReturnType<typeof fakeServer>, existingVault?: string) {
  const vault = existingVault ?? await mkdtemp(join(tmpdir(), 'team-manager-'))
  if (!existingVault) roots.push(vault)
  const profiles = new ProfileStore(vault)
  await profiles.initialize()
  const jars = new Map<string, PortableCookie[]>()
  const cookies = {
    exportCookies: async (id: string) => jars.get(id) ?? [],
    importCookies: async (id: string, list: PortableCookie[]) => { jars.set(id, list); return list.length }
  } as unknown as CookieManager
  const events: TeamSyncEvent[] = []
  const team = new TeamManager(vault, profiles, cookies, identitySecretCodec, (event) => events.push(event), undefined, server.fetcher)
  team.syncDelayMs = -1
  const extensions = new ExtensionStore(vault)
  await extensions.initialize()
  team.extensions = extensions
  await team.initialize()
  return { vault, profiles, jars, team, events, extensions }
}

const cookie = (value: string) => ({ name: 'sid', value, domain: '.example.com', path: '/' }) as PortableCookie


/** beforeLaunch and the login state it brings (the launcher waits for both before the browser starts). */
async function opened(team: { beforeLaunch(id: string): Promise<void | { loginState?: Promise<void> }> }, id: string): Promise<void> {
  const prepared = await team.beforeLaunch(id)
  if (prepared) await prepared.loginState
}

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

    // Every window goes up by itself; the owner then assigns it.
    expect(await owner.team.sync()).toEqual({ added: 0, uploaded: 1 })
    const teamId = owner.team.links()[0].teamId
    const [shared] = await owner.team.share([teamId], ['member1'])
    expect(shared).toMatchObject({ name: '店铺 1', assignees: ['member1'], dataRev: 1, localId: local.id, ownerId: 'owner1' })

    // The member sees it, puts it on their computer and opens it: config and state come down.
    const visible = await member.team.listProfiles()
    expect(visible.map((item) => item.id)).toEqual([shared.id])
    expect(await member.team.sync()).toEqual({ added: 1, uploaded: 0 })
    const copyId = member.team.links()[0].profileId
    const copy = member.profiles.get(copyId)
    expect(copy.proxy.password).toBe('proxy-secret')
    expect(copy.account.password).toBe('account-secret')
    expect(copy.fingerprint.seed).toBe(local.fingerprint.seed)
    expect(member.team.links()).toEqual([{ profileId: copyId, teamId: shared.id, readOnly: true, pendingUpload: false }])
    expect(() => member.team.assertEditable(copyId)).toThrow('只有主账号可以修改或导出')

    await opened(member.team, copyId)
    expect(await readFile(join(member.profiles.profileDataPath(copyId), 'Default', 'Preferences'), 'utf8')).toBe('from owner')
    expect(member.jars.get(copyId)).toEqual([cookie('owner-session')])
    expect(server.locks.get(shared.id)?.holder).toBe('member1')

    // While the member has it, the owner cannot open it.
    await expect(opened(owner.team, local.id)).rejects.toThrow('小A」正在使用')

    // The member's session changes the state; closing uploads it and frees the window.
    await writeFile(join(member.profiles.profileDataPath(copyId), 'Default', 'Preferences'), 'from member')
    member.jars.set(copyId, [cookie('member-session')])
    await member.team.afterExit(copyId)
    expect(server.records.get(shared.id)).toMatchObject({ data_rev: 2, data_by: 'member1' })
    expect(server.locks.has(shared.id)).toBe(false)
    expect(member.events.map((event) => event.phase)).toEqual(['pulling', 'done', 'pushing', 'done'])

    // The owner opens it next and continues from the member's state.
    await opened(owner.team, local.id)
    expect(await readFile(join(owner.profiles.profileDataPath(local.id), 'Default', 'Preferences'), 'utf8')).toBe('from member')
    expect(owner.jars.get(local.id)).toEqual([cookie('member-session')])
    await owner.team.afterExit(local.id)
    expect(server.records.get(shared.id)?.data_rev).toBe(3)
  })

  it('opens the latest login state on every computer, whoever closed it last; none uploaded in 测试模式', async () => {
    const server = fakeServer()
    const a = await computer(server)
    const b = await computer(server)
    const member = await computer(server)
    await a.team.login('http://team.test', 'boss', 'ownerpass')
    await b.team.login('http://team.test', 'boss', 'ownerpass')
    await member.team.login('http://team.test', 'alice', 'alicepass')
    const local = await a.profiles.create({ ...defaultProfileDraft(), name: '店铺' })
    a.jars.set(local.id, [cookie('a-1')])
    await a.team.sync()
    const teamId = a.team.links()[0].teamId
    await b.team.sync()
    const onB = b.team.links()[0].profileId

    // A uses it and closes: one login state in the cloud, nothing per computer.
    await opened(a.team, local.id)
    a.jars.set(local.id, [cookie('a-2')])
    await a.team.afterExit(local.id)
    expect(server.records.get(teamId)?.data_rev).toBe(2)
    expect(server.deviceStates.size).toBe(0)

    // B (the same account on another computer) opens A's latest, and its close goes over it.
    await opened(b.team, onB)
    expect(b.jars.get(onB)).toEqual([cookie('a-2')])
    b.jars.set(onB, [cookie('b-1')])
    await b.team.afterExit(onB)
    expect(server.records.get(teamId)?.data_rev).toBe(3)

    // Back on A: B's latest.
    await opened(a.team, local.id)
    expect(a.jars.get(local.id)).toEqual([cookie('b-1')])
    await a.team.launchFailed(local.id)

    // A window 0.5.55–0.5.57 left on this computer's own older copy (deviceRev set, the latest from the
    // other computer at the same revision): the next open brings the latest once.
    const links = (a.team as unknown as { file: { links: Record<string, { deviceRev?: number; dataRev: number }> } }).file.links
    a.jars.set(local.id, [cookie('a-own-old')])
    links[local.id].deviceRev = 1
    await opened(a.team, local.id)
    expect(a.jars.get(local.id)).toEqual([cookie('b-1')])
    expect(links[local.id].deviceRev).toBeUndefined()
    await a.team.launchFailed(local.id)
    // Already the latest: nothing comes down again.
    a.jars.set(local.id, [cookie('kept-here')])
    await opened(a.team, local.id)
    expect(a.jars.get(local.id)).toEqual([cookie('kept-here')])
    await a.team.launchFailed(local.id)

    // Another member takes the latest too.
    await a.team.share([teamId], ['member1'])
    await member.team.sync()
    const onMember = member.team.links()[0].profileId
    await opened(member.team, onMember)
    expect(member.jars.get(onMember)).toEqual([cookie('b-1')])
    await member.team.launchFailed(onMember)
    expect(server.locks.has(teamId)).toBe(false)

    // 测试模式 on B: closing uploads nothing and the next open keeps what is here.
    await b.team.setTestMode(onB, true)
    await opened(b.team, onB)
    b.jars.set(onB, [cookie('b-test')])
    await b.team.afterExit(onB)
    expect(server.records.get(teamId)?.data_rev).toBe(3)
    expect(server.locks.has(teamId)).toBe(false)
    await opened(b.team, onB)
    expect(b.jars.get(onB)).toEqual([cookie('b-test')])
    await b.team.launchFailed(onB)
    // Cookies edited in 测试模式 stay here too.
    await b.team.pushLoginState(onB)
    expect(server.records.get(teamId)?.data_rev).toBe(3)
    // Turning it off backs up first, over the cloud one.
    expect((await b.team.setTestMode(onB, false)).testMode).toBeUndefined()
    expect(server.records.get(teamId)).toMatchObject({ data_rev: 4 })
    expect(server.deviceStates.size).toBe(0)
  })

  it('lets one computer at a time open a window, even for the same account; the owner can force it free', async () => {
    const server = fakeServer()
    const a = await computer(server)
    const b = await computer(server)
    await a.team.login('http://team.test', 'boss', 'ownerpass')
    await b.team.login('http://team.test', 'boss', 'ownerpass')
    const local = await a.profiles.create({ ...defaultProfileDraft(), name: '店铺' })
    await a.team.sync()
    const teamId = a.team.links()[0].teamId
    await b.team.sync()
    const onB = b.team.links()[0].profileId

    // Open on A: the same account on B cannot open it, and A's lock is untouched.
    await opened(a.team, local.id)
    await expect(opened(b.team, onB)).rejects.toThrow(/另一台电脑/)
    expect(server.locks.get(teamId)?.holder).toBe('owner1')
    // A opens it again later (same computer, after a restart of the app): still its own.
    await expect(opened(a.team, local.id)).resolves.toBeUndefined()

    // Closed on A: B can open it now.
    await a.team.afterExit(local.id)
    await opened(b.team, onB)
    await b.team.launchFailed(onB)

    // The owner's 强制释放 still frees a window held on another computer.
    await opened(a.team, local.id)
    await b.team.forceUnlock(teamId)
    expect(server.locks.has(teamId)).toBe(false)
  })

  it('applies the owner’s config changes on the member’s next open', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    const member = await computer(server)
    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    await member.team.login('http://team.test', 'alice', 'alicepass')
    const local = await owner.profiles.create({ ...defaultProfileDraft(), name: '旧名字' })
    await owner.team.sync()
    const [shared] = await owner.team.share([owner.team.links()[0].teamId], ['member1'])
    const copyId = await member.team.addToComputer(shared.id)

    await owner.profiles.update(local.id, { ...owner.profiles.get(local.id), name: '新名字', startUrls: ['https://example.com/'] })
    await owner.team.afterLocalEdit(local.id)
    await opened(member.team, copyId)
    expect(member.profiles.get(copyId)).toMatchObject({ name: '新名字', startUrls: ['https://example.com/'] })
    await member.team.launchFailed(copyId)
    expect(server.locks.has(shared.id)).toBe(false)
  })

  it('never overwrites a config changed elsewhere while the window was open here', async () => {
    const server = fakeServer()
    const a = await computer(server)
    const b = await computer(server)
    await a.team.login('http://team.test', 'boss', 'ownerpass')
    await b.team.login('http://team.test', 'boss', 'ownerpass')
    const local = await a.profiles.create({ ...defaultProfileDraft(), name: '原名字' })
    await a.team.sync()
    await b.team.sync()
    const copyId = b.team.links()[0].profileId
    await opened(b.team, copyId)
    // Edited on A while B has it open.
    await a.profiles.update(local.id, { ...a.profiles.get(local.id), name: 'A 改的名字' })
    await a.team.afterLocalEdit(local.id)
    b.jars.set(copyId, [cookie('from-b')])
    await b.team.afterExit(copyId)
    const record = [...server.records.values()][0]
    expect((record.config as { name: string }).name).toBe('A 改的名字')
    expect(record.data_rev).toBeGreaterThan(0)
    // B takes A's change at its next open.
    await opened(b.team, copyId)
    expect(b.profiles.get(copyId).name).toBe('A 改的名字')
    await b.team.launchFailed(copyId)
  })

  it('opens no window at all until signed in, and stays locked while the server is unreachable', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    const local = await owner.profiles.create(defaultProfileDraft())
    await expect(opened(owner.team, local.id)).rejects.toThrow('请先登录')
    expect(await owner.team.status()).toMatchObject({ server: 'https://temu.orenge.ccwu.cc', user: undefined })

    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    await opened(owner.team, local.id)

    // Next start: the saved sign-in cannot be checked, so the app stays on the sign-in page.
    let tries = 0
    const restarted = new TeamManager(owner.vault, owner.profiles, {} as CookieManager, identitySecretCodec, () => undefined, undefined,
      (async (input: string | URL | Request) => {
        // The team's built-in servers are asked too when it is down (none of them answer here).
        if (String(input instanceof Request ? input.url : input).startsWith('http://team.test')) tries += 1
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND team.test'), { code: 'ENOTFOUND' }) })
      }) as unknown as typeof fetch)
    restarted.syncDelayMs = -1
    restarted.restoreRetryMs = [0, 0, 0]
    await restarted.initialize()
    const status = await restarted.status()
    expect(tries).toBe(4)
    expect(status.user).toBeUndefined()
    expect(status.offline).toBe('连不上团队服务器（fetch failed: ENOTFOUND）')
    await expect(restarted.beforeLaunch(local.id)).rejects.toThrow('请先登录')
  })

  it('with the team feature off, never reaches the server: no sign-in, windows open and edit as local ones', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    const local = await owner.profiles.create({ ...defaultProfileDraft(), name: 'shop' })
    await owner.team.sync()
    expect(owner.team.links().length).toBe(1)

    // Next start with the feature off: the saved sign-in and the link stay, nothing is fetched.
    let calls = 0
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => { calls += 1; return server.fetcher(input, init) }) as typeof fetch
    const off = new TeamManager(owner.vault, owner.profiles, {} as CookieManager, identitySecretCodec, () => undefined, undefined, counting)
    off.syncDelayMs = -1
    off.enabled = false
    await off.initialize()
    const status = await off.status()
    expect(status.disabled).toBe(true)
    expect(status.user).toBeUndefined()
    await off.beforeLaunch(local.id)
    off.assertEditable(local.id)
    await off.afterLocalEdit(local.id)
    await off.pushLoginState(local.id)
    await off.afterExit(local.id)
    await off.launchFailed(local.id)
    expect(await off.sync()).toEqual({ added: 0, uploaded: 0 })
    await expect(off.login('http://team.test', 'boss', 'ownerpass')).rejects.toThrow('团队功能已停用')
    await expect(off.probe('http://team.test')).rejects.toThrow('团队功能已停用')
    await expect(off.listMembers()).rejects.toThrow('团队功能已停用')
    expect(calls).toBe(0)
    expect(off.links().length).toBe(1)
  })

  it('tries an unreachable server again at start, so a network blip does not stop the app', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    await owner.team.login('http://team.test', 'boss', 'ownerpass')

    let tries = 0
    const blip = (async (input: RequestInfo | URL, init?: RequestInit) => {
      tries += 1
      if (tries <= 2) throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
      return server.fetcher(input, init)
    }) as typeof fetch
    const restarted = new TeamManager(owner.vault, owner.profiles, {} as CookieManager, identitySecretCodec, () => undefined, undefined, blip)
    restarted.syncDelayMs = -1
    restarted.restoreRetryMs = [0, 0, 0]
    await restarted.initialize()
    const status = await restarted.status()
    expect(tries).toBeGreaterThanOrEqual(3)
    expect(status.user).toMatchObject({ username: 'boss' })
    expect(status.offline).toBeUndefined()
  })

  it('puts members’ own windows in the cloud too; deleting is for the account and restoring brings it back', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    const member = await computer(server)
    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    await member.team.login('http://team.test', 'alice', 'alicepass')

    // A member's own window: it goes up, and the member may still change it.
    const own = await member.profiles.create({ ...defaultProfileDraft(), name: '小A 自己的' })
    expect(await member.team.sync()).toEqual({ added: 0, uploaded: 1 })
    expect(member.team.links()).toMatchObject([{ profileId: own.id, readOnly: false }])
    expect(() => member.team.assertEditable(own.id)).not.toThrow()
    await member.profiles.update(own.id, { ...member.profiles.get(own.id), name: '小A 改过的' })
    await member.team.afterLocalEdit(own.id)

    // The owner sees it (and gets it on this computer); members do not see each other's.
    expect(await owner.team.sync()).toEqual({ added: 1, uploaded: 0 })
    expect((await owner.team.listProfiles()).map((item) => [item.name, item.ownerId])).toEqual([['小A 改过的', 'member1']])

    // Deleted here: deleted for the account (marked in the cloud, restorable), the next sync does not bring it back.
    const ownerCopy = owner.team.links()[0].profileId
    const teamId = owner.team.links()[0].teamId
    await owner.profiles.remove(ownerCopy)
    await owner.team.forget(ownerCopy)
    expect(await owner.team.sync()).toEqual({ added: 0, uploaded: 0 })
    expect(await owner.team.listProfiles()).toMatchObject([{ id: teamId, localId: undefined, removedHere: true, deletedAt: expect.any(String) }])
    // The member's computer moves its copy to the recycle bin.
    await member.team.sync()
    expect(member.profiles.list()).toEqual([])
    expect((await member.profiles.listTrash()).map((item) => item.profileId)).toEqual([own.id])

    // Restored from the recycle bin: linked again, not uploaded as a second window.
    const trashed = (await owner.profiles.listTrash()).find((item) => item.profileId === ownerCopy)!
    await owner.profiles.restore(trashed.trashId)
    expect(await owner.team.sync()).toEqual({ added: 0, uploaded: 0 })
    expect(owner.team.links()).toMatchObject([{ profileId: ownerCopy, teamId }])
    expect(server.records.size).toBe(1)
    expect((server.records.get(teamId)!.config as { deletedAt?: string }).deletedAt).toBeUndefined()
    // …and on the member's computer it comes back from its recycle bin.
    await member.team.sync()
    expect(member.profiles.list().map((profile) => profile.id)).toEqual([own.id])
  })

  it('keeps one state on every computer of an account: edits, 收藏, deleting, restoring, deleting for good', async () => {
    const server = fakeServer()
    const a = await computer(server)
    const b = await computer(server)
    await a.team.login('http://team.test', 'boss', 'ownerpass')
    await b.team.login('http://team.test', 'boss', 'ownerpass')
    const window1 = await a.profiles.create({ ...defaultProfileDraft(), name: '窗口一' })
    const window2 = await a.profiles.create({ ...defaultProfileDraft(), name: '窗口二' })
    await a.team.sync()
    await b.team.sync()
    const onB = (name: string) => b.profiles.list().find((profile) => profile.name === name)
    expect(b.profiles.list().map((profile) => profile.name).sort()).toEqual(['窗口一', '窗口二'])

    // Renamed, regrouped and starred on A: B shows it without opening the window.
    const changed = vi.fn()
    b.team.onProfilesChanged = changed
    await a.profiles.update(window1.id, { ...a.profiles.get(window1.id), name: '窗口一改', group: '美国', note: '备注' })
    await a.profiles.setFavorite(window1.id, true)
    await a.team.afterLocalEdit(window1.id)
    await b.team.sync()
    expect(onB('窗口一改')).toMatchObject({ group: '美国', note: '备注', favorite: true })
    expect(changed).toHaveBeenCalled()

    // Deleted on A: in both recycle bins; a new computer does not get it.
    await a.profiles.remove(window2.id)
    await a.team.forget(window2.id)
    await b.team.sync()
    expect(onB('窗口二')).toBeUndefined()
    expect((await b.profiles.listTrash()).map((item) => item.name)).toEqual(['窗口二'])
    const c = await computer(server)
    await c.team.login('http://team.test', 'boss', 'ownerpass')
    await c.team.sync()
    expect(c.profiles.list().map((profile) => profile.name)).toEqual(['窗口一改'])
    expect((await c.team.listProfiles()).find((item) => item.name === '窗口二')).toMatchObject({ deletedAt: expect.any(String), localId: undefined })

    // Restored on B: back on A too (from A's recycle bin, the same window).
    const trashedOnB = (await b.profiles.listTrash()).find((item) => item.name === '窗口二')!
    await b.profiles.restore(trashedOnB.trashId)
    await b.team.sync()
    await a.team.sync()
    expect(a.profiles.list().map((profile) => profile.id)).toContain(window2.id)
    expect(await a.profiles.listTrash()).toEqual([])

    // Deleted again on B and deleted for good from B's recycle bin: only B's copy goes; the cloud keeps
    // it (marked deleted), A's recycle bin keeps its copy, and B does not get it back at the next sync.
    const window2OnB = onB('窗口二')!
    await b.profiles.remove(window2OnB.id)
    await b.team.forget(window2OnB.id)
    await a.team.sync()
    expect((await a.profiles.listTrash()).map((item) => item.profileId)).toEqual([window2.id])
    const trashId = (await b.profiles.listTrash())[0].trashId
    await b.team.purged([await b.profiles.purgeTrash(trashId)])
    expect([...server.records.values()].map((record) => record.name).sort()).toEqual(['窗口一改', '窗口二'])
    await a.team.sync()
    await b.team.sync()
    expect((await a.profiles.listTrash()).map((item) => item.profileId)).toEqual([window2.id])
    expect(await b.profiles.listTrash()).toEqual([])
    expect(onB('窗口二')).toBeUndefined()
    const teamId2 = (await b.team.listProfiles()).find((item) => item.name === '窗口二')!
    expect(teamId2).toMatchObject({ deletedAt: expect.any(String), localId: undefined })

    // Emptying the recycle bin on A too: still in the cloud.
    await a.team.purged(await a.profiles.emptyTrash())
    await a.team.sync()
    expect(server.records.has(teamId2.id)).toBe(true)
    expect(a.profiles.list().map((profile) => profile.name)).toEqual(['窗口一改'])

    // Added back from the Team page on B: a window again on every computer (from the cloud: no copy left).
    await b.team.restoreToComputer(teamId2.id)
    await a.team.sync()
    expect(onB('窗口二')).toBeDefined()
    expect(a.profiles.list().map((profile) => profile.name).sort()).toEqual(['窗口一改', '窗口二'])

    // Its cloud backup cannot go while the window is in the window list (user, 2026-11-07).
    await expect(b.team.unshare(teamId2.id)).rejects.toThrow('先在窗口列表里删除（移到回收站），才能删除云端备份')
    expect(server.records.has(teamId2.id)).toBe(true)

    // Deleted in the window list first (recycle bins), then deleted for good by hand on the Team page:
    // gone from the cloud; the recycle-bin copies stay.
    const onBId = onB('窗口二')!.id
    await b.profiles.remove(onBId)
    await b.team.forget(onBId)
    await a.team.sync()
    await b.team.unshare(teamId2.id)
    await a.team.sync()
    expect([...server.records.values()].map((record) => record.name)).toEqual(['窗口一改'])
    expect(a.profiles.list().map((profile) => profile.name)).toEqual(['窗口一改'])
  })

  it('keeps one recycle-bin copy per window, however often it was deleted and restored, and restores that copy', async () => {
    const server = fakeServer()
    const a = await computer(server)
    const b = await computer(server)
    await a.team.login('http://team.test', 'boss', 'ownerpass')
    await b.team.login('http://team.test', 'boss', 'ownerpass')
    const window = await a.profiles.create({ ...defaultProfileDraft(), name: '窗口' })
    await a.team.sync()
    await b.team.sync()
    const teamId = (await a.team.listProfiles())[0].id

    // Deleted on A, restored on B, deleted on B again, restored again, deleted again: one copy on A.
    for (let round = 0; round < 3; round += 1) {
      const onA = a.profiles.list().find((profile) => profile.name === '窗口')
      if (onA) {
        await a.profiles.remove(onA.id)
        await a.team.forget(onA.id)
      }
      await b.team.sync()
      await b.team.restoreToComputer(teamId)
      await a.team.sync()
      const onB = b.profiles.list().find((profile) => profile.name === '窗口')!
      await b.profiles.remove(onB.id)
      await b.team.forget(onB.id)
      await a.team.sync()
      await a.team.restoreToComputer(teamId)
    }
    const onA = a.profiles.list().find((profile) => profile.name === '窗口')!
    expect(onA.id).toBe(window.id)
    await a.profiles.remove(onA.id)
    await a.team.forget(onA.id)
    await b.team.sync()
    expect((await a.profiles.listTrash()).map((item) => item.profileId)).toEqual([window.id])
    expect((await b.profiles.listTrash()).length).toBe(1)

    // A local window deleted and restored again and again: one copy as well.
    const local = await b.profiles.create({ ...defaultProfileDraft(), name: '本机' })
    for (let round = 0; round < 2; round += 1) {
      await b.profiles.remove(local.id)
      await b.profiles.restore((await b.profiles.listTrash()).find((item) => item.profileId === local.id)!.trashId)
    }
    await b.profiles.remove(local.id)
    expect((await b.profiles.listTrash()).filter((item) => item.profileId === local.id).length).toBe(1)

    // Back from the Team page: this computer's recycle-bin copy (same window), not a new one.
    const trashedOnB = (await b.profiles.listTrash()).find((item) => item.name === '窗口')!
    const backOnB = await b.team.restoreToComputer(teamId)
    expect(backOnB).toBe(trashedOnB.profileId)
    expect((await b.profiles.listTrash()).map((item) => item.name)).toEqual(['本机'])
  })

  it('keeps one proxy library and one group list for the account: added, changed and removed anywhere', async () => {
    const server = fakeServer()
    const wire = (pc: Awaited<ReturnType<typeof computer>>) => {
      pc.team.workspaceExport = async () => ({
        proxies: pc.profiles.listProxies().map(({ protocol, host, port, username, password, note, apiUrl, tunnel }) => ({ protocol, host, port, username, password, note, apiUrl, tunnel })),
        groups: pc.profiles.listGroups().map(({ name, color, note }) => ({ name, color, note }))
      })
      pc.team.workspaceImport = async (data, mode) => {
        const value = data as { proxies: unknown[]; groups: Array<{ name: string; color: string; note: string }> }
        if (mode === 'mirror') {
          await pc.profiles.mirrorProxies(value.proxies)
          await pc.profiles.mirrorGroups(value.groups)
        } else {
          if (value.proxies.length) await pc.profiles.createProxies(value.proxies as never)
          for (const group of value.groups) if (!pc.profiles.listGroups().some((item) => item.name === group.name)) await pc.profiles.createGroup(group)
        }
      }
      return pc
    }
    const a = wire(await computer(server))
    const b = wire(await computer(server))
    const proxy = (host: string, note = '') => ({ protocol: 'socks5' as const, host, port: 1080, username: 'u', password: 'p', note })
    // B already has a proxy of its own before it ever signs in: the first sync merges, nothing is lost.
    await b.profiles.createProxy(proxy('b-own.example'))
    await a.team.login('http://team.test', 'boss', 'ownerpass')
    await a.profiles.createProxy(proxy('a-one.example'))
    await a.profiles.createGroup({ name: '美国', color: '#ff0000', note: '' })
    await a.team.sync()
    await b.team.login('http://team.test', 'boss', 'ownerpass')
    await b.team.sync()
    await a.team.sync()
    const hosts = (pc: typeof a) => pc.profiles.listProxies().map((item) => item.host).sort()
    expect(hosts(a)).toEqual(['a-one.example', 'b-own.example'])
    expect(hosts(b)).toEqual(['a-one.example', 'b-own.example'])
    expect(b.profiles.listGroups().map((group) => group.name)).toEqual(['美国'])

    // Changed on B (a note, a new group, one proxy removed): A becomes the same.
    const one = b.profiles.listProxies().find((item) => item.host === 'a-one.example')!
    await b.profiles.updateProxy(one.id, { ...proxy('a-one.example', '主力'), passwordStored: true, password: '' } as never)
    await b.profiles.removeProxy(b.profiles.listProxies().find((item) => item.host === 'b-own.example')!.id)
    await b.profiles.createGroup({ name: '日本', color: '#00ff00', note: '' })
    await b.team.sync()
    await a.team.sync()
    expect(a.profiles.listProxies().map((item) => [item.host, item.note])).toEqual([['a-one.example', '主力']])
    expect(a.profiles.listGroups().map((group) => group.name).sort()).toEqual(['日本', '美国'])

    // Removed on A: B drops it too; a group a window here still uses stays until the window moves.
    await a.profiles.removeGroup(a.profiles.listGroups().find((group) => group.name === '美国')!.id)
    await a.team.sync()
    await b.team.sync()
    expect(b.profiles.listGroups().map((group) => group.name)).toEqual(['日本'])
    // Nothing changed anywhere: nothing more is sent.
    const before = [...server.workspaces.values()][0].updated
    await a.team.sync()
    await b.team.sync()
    expect([...server.workspaces.values()][0].updated).toBe(before)
  })

  it('handles windows deleted here by an older version: deleted for the account unless used elsewhere since', async () => {
    const server = fakeServer()
    const a = await computer(server)
    const b = await computer(server)
    await a.team.login('http://team.test', 'boss', 'ownerpass')
    await b.team.login('http://team.test', 'boss', 'ownerpass')
    const idle = await a.profiles.create({ ...defaultProfileDraft(), name: '没人再用' })
    const used = await a.profiles.create({ ...defaultProfileDraft(), name: '别处还在用' })
    await a.team.sync()
    await b.team.sync()
    // An older version on A: deleted here only (the removed list without a mark).
    const teamFile = join(a.vault, 'team.json')
    for (const profile of [idle, used]) await a.profiles.remove(profile.id)
    const file = JSON.parse(await readFile(teamFile, 'utf8'))
    for (const profile of [idle, used]) {
      file.removed = { ...(file.removed ?? {}), [profile.id]: file.links[profile.id] }
      delete file.links[profile.id]
    }
    await writeFile(teamFile, JSON.stringify(file))
    // B kept using one of them (its config changed since).
    const usedOnB = b.profiles.list().find((profile) => profile.name === '别处还在用')!
    await b.profiles.update(usedOnB.id, { ...b.profiles.get(usedOnB.id), note: '还在用' })
    await b.team.afterLocalEdit(usedOnB.id)
    // A starts the new version.
    const a2 = await computer(server, a.vault)
    await a2.team.sync()
    expect(a2.profiles.list().map((profile) => profile.name)).toEqual(['别处还在用'])
    expect(a2.profiles.get(used.id).note).toBe('还在用')
    await b.team.sync()
    expect(b.profiles.list().map((profile) => profile.name)).toEqual(['别处还在用'])
    expect((await b.profiles.listTrash()).map((item) => item.name)).toEqual(['没人再用'])
  })

  it('keeps a failed upload and sends it on the next open', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    const local = await owner.profiles.create(defaultProfileDraft())
    await owner.team.sync()
    await opened(owner.team, local.id)

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
    await opened(owner.team, local.id)
    expect(owner.team.links()[0].pendingUpload).toBe(false)
    expect([...server.records.values()][0].data_rev).toBe(2)
    expect(existsSync(join(owner.vault, 'team.json'))).toBe(true)
  })

  it('brings bookmarks, history, extensions with their data and the check records along', async () => {
    const server = fakeServer()
    const owner = await computer(server)
    const member = await computer(server)
    await owner.team.login('http://team.test', 'boss', 'ownerpass')
    await member.team.login('http://team.test', 'alice', 'alicepass')

    const folder = join(owner.vault, 'unpacked-wallet')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Wallet', version: '2.1' }))
    const wallet = await owner.extensions.importDirectory(folder)
    const walletId = (await owner.extensions.identity(wallet.id)).chromeId
    const local = await owner.profiles.create({ ...defaultProfileDraft(), name: '店铺 2', extensionIds: [wallet.id] })
    const data = owner.profiles.profileDataPath(local.id)
    await mkdir(join(data, 'Default', 'Local Extension Settings', walletId), { recursive: true })
    await writeFile(join(data, 'Default', 'Local Extension Settings', walletId, 'CURRENT'), 'wallet vault')
    await writeFile(join(data, 'Default', 'Bookmarks'), '{"roots":{"bookmark_bar":{}}}')
    await writeFile(join(data, 'Default', 'History'), 'owner history')
    await fingerprintCheckStore(join(owner.vault, 'fingerprint-checks.json')).set(local.id, { checkedAt: '2026-10-29T08:00:00.000Z' } as never)

    await owner.team.sync()
    const teamId = owner.team.links()[0].teamId
    await owner.team.share([teamId], ['member1'])
    await member.team.sync()
    const copyId = member.team.links()[0].profileId
    await opened(member.team, copyId)

    const copyData = member.profiles.profileDataPath(copyId)
    const [installed] = member.extensions.list()
    expect(installed).toMatchObject({ name: 'Wallet', version: '2.1' })
    expect(member.profiles.get(copyId).extensionIds).toEqual([installed.id])
    // The same browser ID as on the owner's computer, so its data is its own again.
    expect((await member.extensions.identity(installed.id)).chromeId).toBe(walletId)
    expect(await readFile(join(copyData, 'Default', 'Local Extension Settings', walletId, 'CURRENT'), 'utf8')).toBe('wallet vault')
    expect(await readFile(join(copyData, 'Default', 'Bookmarks'), 'utf8')).toBe('{"roots":{"bookmark_bar":{}}}')
    expect(await readFile(join(copyData, 'Default', 'History'), 'utf8')).toBe('owner history')
    expect(await fingerprintCheckStore(join(member.vault, 'fingerprint-checks.json')).get(copyId)).toEqual({ checkedAt: '2026-10-29T08:00:00.000Z' })
    await member.team.afterExit(copyId)
    // Coming back, the owner's own copy of the extension is used.
    await opened(owner.team, local.id)
    expect(owner.extensions.list()).toHaveLength(1)
    expect(owner.profiles.get(local.id).extensionIds).toEqual([wallet.id])
  })
})

/**
 * Two servers of one team sharing the data (as after a takeover from R2): each is up and active,
 * up and standby (409 movedTo for everything but status), or down. Activation and handover flip them.
 */
function serverPair(data = fakeServer()) {
  const A = 'https://a.team.test'
  const B = 'https://b.team.test'
  const state: Record<string, 'active' | 'standby' | 'down'> = { [A]: 'active', [B]: 'standby' }
  const calls: string[] = []
  const codes: Record<string, string> = {}
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const activeOne = () => Object.keys(state).find((url) => state[url] === 'active') ?? ''
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const origin = url.origin
    calls.push(`${origin} ${request.method} ${url.pathname}`)
    if (state[origin] === 'down' || !(origin in state)) throw new TypeError('fetch failed')
    if (url.pathname === '/api/team/status') {
      return json(200, { ready: true, lockMs: 90_000, role: state[origin], self: origin, active: activeOne(), servers: Object.keys(state) })
    }
    if (url.pathname === '/api/team/activate') {
      const body = await request.json() as { code: string }
      if (body.code !== 'CODE-' + origin) return json(403, { message: '这台服务器的激活码不对' })
      for (const key of Object.keys(state)) if (state[key] === 'active') state[key] = 'standby'
      state[origin] = 'active'
      return json(200, { ok: true, restarting: true, role: 'active' })
    }
    if (url.pathname === '/api/team/standby/setup') return json(200, { role: 'standby', self: origin, active: activeOne(), servers: [A, B] })
    if (state[origin] === 'standby') {
      const target = activeOne()
      return json(409, { status: 409, message: 'moved', movedTo: target === origin ? '' : target, data: {} })
    }
    if (url.pathname === '/api/team/handover') {
      state[origin] = 'standby'
      return json(200, { ok: true })
    }
    if (url.pathname === '/api/team/offsite/key') return json(200, { url: 'https://x.r2.cloudflarestorage.com/bucket', accessKeyId: 'AAAAAAAAAAAAAAAA', secretAccessKey: 'BBBBBBBBBBBBBBBB' })
    if (url.pathname === '/api/team/servers') {
      const body = await request.json() as { add?: string; remove?: string }
      if (body.remove) delete state[body.remove]
      else if (body.add && !(body.add in state)) state[body.add] = 'standby'
      return json(200, { role: 'active', self: origin, active: origin, servers: Object.keys(state) })
    }
    if (url.pathname === '/api/team/server-codes') {
      // The active server adds its own code; the owner's apps add the others.
      if (request.method === 'GET') return json(200, { codes: { ...codes, [origin]: 'CODE-' + origin } })
      const body = await request.json() as { url: string; code: string }
      codes[body.url] = body.code
      return json(200, { ok: true })
    }
    if (url.pathname.startsWith('/api/collections/team_workspaces/records')) {
      return request.method === 'GET' ? json(200, { items: [], page: 1, totalItems: 0 }) : json(200, { id: 'ws1' })
    }
    return data.fetcher(request)
  }
  return { A, B, state, calls, codes, data, fetcher: fetcher as typeof fetch }
}

describe('TeamManager with a standby server', () => {
  async function owned(pair: ReturnType<typeof serverPair>) {
    const pc = await computer({ fetcher: pair.fetcher } as ReturnType<typeof fakeServer>)
    pc.team.takeoverPollMs = 1
    await pc.team.login(pair.A, 'boss', 'ownerpass')
    // login learns the pair in the background (afterOnline)
    await pc.team.flush()
    return pc
  }

  it('follows the team to the other server when the one in use is down or points elsewhere', async () => {
    const pair = serverPair()
    const pc = await owned(pair)
    expect((await pc.team.status()).servers).toEqual([pair.A, pair.B])
    const local = await pc.profiles.create({ ...defaultProfileDraft(), name: 'shop' })
    await pc.team.sync()

    // A goes down and B took over: the next launch check moves to B by itself.
    pair.state[pair.A] = 'down'
    pair.state[pair.B] = 'active'
    ;(pc.team as unknown as { verifiedAt: number }).verifiedAt = 0
    await opened(pc.team, local.id)
    expect((await pc.team.status()).server).toBe(pair.B)
    await pc.team.launchFailed(local.id)

    // B hands back to A (A answers again, B says movedTo A): a restart finds A.
    pair.state[pair.A] = 'active'
    pair.state[pair.B] = 'standby'
    const restarted = new TeamManager(pc.vault, pc.profiles, {} as CookieManager, identitySecretCodec, () => undefined, undefined, pair.fetcher)
    restarted.syncDelayMs = -1
    restarted.restoreRetryMs = []
    await restarted.initialize()
    const status = await restarted.status()
    expect(status.server).toBe(pair.A)
    expect(status.user?.username).toBe('boss')
    await restarted.flush()
  })

  it('works in local mode while no server answers and sends the windows used there once one is back', async () => {
    const pair = serverPair()
    const pc = await owned(pair)
    const local = await pc.profiles.create({ ...defaultProfileDraft(), name: 'shop' })
    await mkdir(join(pc.profiles.profileDataPath(local.id), 'Default'), { recursive: true })
    await pc.team.sync()
    const teamId = pc.team.links()[0].teamId
    expect(pair.data.records.get(teamId)!.data_rev).toBe(1)

    pair.state[pair.A] = 'down'
    pair.state[pair.B] = 'down'
    const offline = new TeamManager(pc.vault, pc.profiles, { exportCookies: async () => [] } as unknown as CookieManager, identitySecretCodec, () => undefined, undefined, pair.fetcher)
    offline.syncDelayMs = -1
    offline.restoreRetryMs = []
    await offline.initialize()
    const down = await offline.status()
    expect(down.user).toBeUndefined()
    expect(down.canLocal).toBe(true)

    const local1 = await offline.enterLocalMode()
    expect(local1).toMatchObject({ localMode: true, user: { username: 'boss', role: 'owner' } })
    const before = pair.calls.length
    await offline.beforeLaunch(local.id)
    await offline.afterExit(local.id)
    expect(pair.calls.length).toBe(before)

    // B takes over; "重试" finds it, leaves local mode and uploads the window used meanwhile.
    pair.state[pair.B] = 'active'
    const back = await offline.retry()
    expect(back.localMode).toBeFalsy()
    expect((await offline.status()).server).toBe(pair.B)
    // The upload runs in the background (packing takes longer on Windows).
    await vi.waitFor(() => expect(pair.data.records.get(teamId)!.data_rev).toBe(2), { timeout: 10_000, interval: 50 })
    await offline.flush()
  })

  it('lets the owner name the standby and move the whole team to it', async () => {
    const pair = serverPair()
    const pc = await owned(pair)
    const view = await pc.team.setStandby(pair.B, 'CODE-' + pair.B)
    expect(view.servers.map((server) => [server.url, server.role, server.codeSaved])).toEqual([[pair.A, 'active', true], [pair.B, 'standby', true]])
    expect(pair.calls).toContain(`${pair.B} POST /api/team/standby/setup`)

    // 批量切换 with the kept code: A hands over, B takes over, this computer follows.
    const status = await pc.team.switchServer(pair.B)
    expect(status.server).toBe(pair.B)
    expect(pair.calls).toContain(`${pair.A} POST /api/team/handover`)
    expect(pair.state).toEqual({ [pair.A]: 'standby', [pair.B]: 'active' })
    await expect(pc.team.connectServer(pair.A, 'wrong')).rejects.toThrow('激活码不对')
  })

  it('keeps both activation codes on the server, so any owner computer switches both ways with one click', async () => {
    const pair = serverPair()
    const pc = await owned(pair)
    await pc.team.setStandby(pair.B, 'CODE-' + pair.B)
    expect(pair.codes[pair.B]).toBe('CODE-' + pair.B)

    // Another computer of the owner: nothing typed there, both codes come from the server.
    const other = await owned(pair)
    const view = await other.team.serverPair()
    expect(view.servers.map((server) => [server.url, server.codeSaved])).toEqual([[pair.A, true], [pair.B, true]])
    expect((await other.team.switchServer(pair.B)).server).toBe(pair.B)
    expect((await other.team.switchServer(pair.A)).server).toBe(pair.A)
    expect(pair.state).toEqual({ [pair.A]: 'active', [pair.B]: 'standby' })
  })

  it('follows the team in every request, also while a switch is under way', async () => {
    const pair = serverPair()
    const pc = await owned(pair)
    ;(pc.team as unknown as { api: { switchPollMs: number } }).api.switchPollMs = 10
    await pc.team.listProfiles()

    // A hands over (no new server yet): requests wait instead of failing...
    pair.state[pair.A] = 'standby'
    const listing = pc.team.listProfiles()
    await new Promise((resolve) => setTimeout(resolve, 40))
    // ...and go to B once it took over; this computer keeps working with B.
    pair.state[pair.B] = 'active'
    await expect(listing).resolves.toBeDefined()
    expect((await pc.team.status()).server).toBe(pair.B)
    expect(pair.calls.filter((call) => call.startsWith(pair.B)).length).toBeGreaterThan(0)
  })

  it('signs in where the team is now when the server asked says it moved', async () => {
    const pair = serverPair()
    pair.state[pair.A] = 'standby'
    pair.state[pair.B] = 'active'
    const pc = await computer({ fetcher: pair.fetcher } as ReturnType<typeof fakeServer>)
    const status = await pc.team.login(pair.A, 'boss', 'ownerpass')
    expect(status.server).toBe(pair.B)
    expect(status.user?.username).toBe('boss')
    // login learns the pair in the background (afterOnline)
    await pc.team.flush()
  })

  it('lets a computer that never signed in pick the team\'s other server while the default one is down', async () => {
    const pair = serverPair()
    pair.state[pair.A] = 'down'
    pair.state[pair.B] = 'active'
    const pc = await computer({ fetcher: pair.fetcher } as ReturnType<typeof fakeServer>)
    await expect(pc.team.login(pair.A, 'boss', 'ownerpass')).rejects.toThrow('连不上')
    expect((await pc.team.connectServer(pair.B)).server).toBe(pair.B)
    const status = await pc.team.login(pair.B, 'boss', 'ownerpass')
    expect(status.user?.username).toBe('boss')
    await pc.team.flush()
  })

  it('keeps any number of servers: adds a third, switches to it, removes one', async () => {
    const pair = serverPair()
    const C = 'https://c.team.test'
    const pc = await owned(pair)
    await pc.team.setStandby(pair.B, 'CODE-' + pair.B)
    await pc.team.setStandby(C, 'CODE-' + C)
    let view = await pc.team.serverPair()
    expect(view.servers.map((server) => [server.url, server.codeSaved])).toEqual([[pair.A, true], [pair.B, true], [C, true]])

    expect((await pc.team.switchServer(C)).server).toBe(C)
    expect(pair.state).toEqual({ [pair.A]: 'standby', [pair.B]: 'standby', [C]: 'active' })

    view = await pc.team.removeServer(pair.B)
    expect(view.servers.map((server) => server.url)).toEqual([C, pair.A])
    await expect(pc.team.removeServer(C)).rejects.toThrow('正在用的这台不能移除')
  })
})
