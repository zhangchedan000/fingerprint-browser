import { hostname } from 'node:os'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  TeamLinkView,
  TeamLogPage,
  TeamLogQuery,
  TeamMemberDraft,
  TeamProfilePatch,
  TeamProfileView,
  TeamStatus,
  TeamSyncEvent,
  TeamRole,
  TeamUser
} from '../../shared/team'
import type { ProfileDraft } from '../../shared/types'
import { validateProfileDraft } from '../../shared/validation'
import type { Logger } from '../app-logger'
import type { CookieManager } from '../cookie-manager'
import type { ProfileStore } from '../profile-store'
import { portableDraft } from '../profile-portable'
import type { SecretCodec } from '../secret-codec'
import { normalizeServer, TeamApi, TeamApiError, type Fetch, type RemoteProfile } from './team-api'
import { packProfileState, sha256File, unpackProfileState } from './team-archive'

interface TeamLink {
  teamId: string
  /** Login state revision this computer has. */
  dataRev: number
  /** Config revision this computer has. */
  configRev: number
  /** Closing could not upload; the next open uploads first. */
  pendingUpload?: boolean
}

interface TeamFile {
  schemaVersion: 1
  server: string
  /** Encrypted with the system credential store. */
  token: string
  /** Role of the account last signed in here; decides what linked windows allow offline. */
  role?: TeamRole
  links: Record<string, TeamLink>
}

const HEARTBEAT_MS = 30_000

/** The team server this build signs in to unless another address is entered. */
export const DEFAULT_TEAM_SERVER = 'https://temu.orenge.ccwu.cc'

function configDraft(config: unknown, name: string): ProfileDraft {
  if (!config || typeof config !== 'object') throw new Error('团队窗口的配置无效')
  const candidate = config as ProfileDraft
  return validateProfileDraft({
    ...candidate,
    name,
    group: typeof candidate.group === 'string' ? candidate.group : '',
    tags: Array.isArray(candidate.tags) ? candidate.tags : [],
    // Extensions are installed per computer.
    extensionIds: [],
    kernelVersion: typeof candidate.kernelVersion === 'string' ? candidate.kernelVersion : ''
  })
}

/**
 * Windows shared through the team server. A linked window takes the server's lock before it
 * opens (pulling a newer config and login state first) and uploads its login state when it
 * closes, so whoever opens it next continues where the last person stopped.
 */
export class TeamManager {
  private api?: TeamApi
  private user?: TeamUser
  private file: TeamFile = { schemaVersion: 1, server: '', token: '', links: {} }
  private readonly heartbeats = new Map<string, NodeJS.Timeout>()
  private readonly pushes = new Map<string, Promise<void>>()
  private readonly locked = new Set<string>()

  constructor(
    private readonly vaultPath: string,
    private readonly profiles: ProfileStore,
    private readonly cookies: CookieManager,
    private readonly secrets: SecretCodec,
    private readonly onSync: (event: TeamSyncEvent) => void,
    private readonly logger?: Logger,
    private readonly fetcher: Fetch = fetch
  ) {}

  private get filePath(): string {
    return join(this.vaultPath, 'team.json')
  }

  private get workPath(): string {
    return join(this.vaultPath, 'team-transfer')
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as TeamFile
      if (parsed.schemaVersion === 1) this.file = { ...parsed, links: parsed.links ?? {} }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger?.error('团队设置读取失败', error)
    }
    // Windows deleted while signed out lose their link.
    for (const id of Object.keys(this.file.links)) {
      if (!this.profiles.list().some((profile) => profile.id === id)) delete this.file.links[id]
    }
    await rm(this.workPath, { recursive: true, force: true })
    if (this.file.server && this.file.token) {
      const api = new TeamApi(this.file.server, this.fetcher)
      try {
        api.token = this.secrets.decode(this.file.token)
        this.api = api
      } catch (error) {
        this.logger?.error('团队登录凭据无法读取', error)
        return
      }
      // In the background: the app must not wait for the server to start.
      this.restoring = this.restoreSession(api)
    }
  }

  private restoring?: Promise<void>
  /** Why the saved sign-in could not be checked (server unreachable); the app stays locked. */
  private offline?: string
  private verifiedAt = 0

  private async restoreSession(api: TeamApi): Promise<void> {
    this.offline = undefined
    try {
      this.user = await api.refresh()
      this.verifiedAt = Date.now()
      this.file.role = this.user.role
      this.file.token = this.secrets.encode(api.token)
      await this.save()
    } catch (error) {
      // Unreachable: keep the token so "retry" can try again; rejected (expired, disabled): sign out.
      this.user = undefined
      if (error instanceof TeamApiError && error.status > 0) {
        this.api = undefined
        this.file.token = ''
        await this.save().catch(() => undefined)
      } else {
        this.offline = error instanceof Error ? error.message : String(error)
      }
      this.logger?.error('团队登录恢复失败', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Checks the saved sign-in with the server again (the "retry" on the sign-in page). */
  async retry(): Promise<TeamStatus> {
    if (this.api && this.file.token) {
      this.restoring = this.restoreSession(this.api)
      await this.restoring
    }
    return this.status()
  }

  /**
   * The app is used signed in and online. Every window launch checks the sign-in with the server
   * (at most once a minute), so a disabled member cannot open anything from then on.
   */
  private async verifySession(): Promise<void> {
    await this.restoring
    const api = this.requireApi()
    if (!this.user) throw new Error('请先登录')
    if (Date.now() - this.verifiedAt < 60_000) return
    try {
      this.user = await api.refresh()
      this.verifiedAt = Date.now()
      this.file.token = this.secrets.encode(api.token)
      await this.save()
    } catch (error) {
      if (error instanceof TeamApiError && error.status > 0) {
        this.api = undefined
        this.user = undefined
        this.file.token = ''
        await this.save().catch(() => undefined)
        throw new Error('登录已失效（账号可能已被停用），请重新登录')
      }
      throw new Error(`连不上团队服务器，暂时不能打开窗口（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.vaultPath, { recursive: true })
    const temp = `${this.filePath}.tmp`
    await writeFile(temp, JSON.stringify(this.file, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.filePath)
  }

  async status(): Promise<TeamStatus> {
    await this.restoring
    return { server: this.file.server || DEFAULT_TEAM_SERVER, user: this.user, offline: this.offline }
  }

  private requireApi(): TeamApi {
    if (!this.api || !this.file.token) throw new Error('请先登录')
    return this.api
  }

  private async requireOwner(): Promise<TeamApi> {
    await this.restoring
    const api = this.requireApi()
    if (this.user?.role !== 'owner') throw new Error('只有主账号可以管理团队')
    return api
  }

  /** Whether the server is reachable and already has an owner. */
  async probe(server: string): Promise<{ server: string; ready: boolean }> {
    const normalized = normalizeServer(server)
    const status = await new TeamApi(normalized, this.fetcher).status()
    return { server: normalized, ready: status.ready }
  }

  async setup(server: string, code: string, username: string, name: string, password: string): Promise<TeamStatus> {
    const normalized = normalizeServer(server)
    await new TeamApi(normalized, this.fetcher).setup(code.trim(), username.trim(), name.trim(), password)
    return this.login(normalized, username, password)
  }

  async login(server: string, username: string, password: string): Promise<TeamStatus> {
    const normalized = normalizeServer(server)
    if (this.file.server && normalized !== this.file.server && Object.keys(this.file.links).length) {
      throw new Error('这台电脑上还有其他团队服务器的窗口，请先在窗口管理里删除它们再换服务器')
    }
    const api = new TeamApi(normalized, this.fetcher)
    const user = await api.login(username.trim(), password)
    if (this.user && this.user.id !== user.id && this.locked.size) throw new Error('还有团队窗口在运行，请先关闭再切换账号')
    this.api = api
    this.user = user
    this.offline = undefined
    this.verifiedAt = Date.now()
    this.file.server = normalized
    this.file.token = this.secrets.encode(api.token)
    this.file.role = user.role
    await this.save()
    this.logger?.info('团队已登录', { server: normalized, user: user.username, role: user.role })
    return this.status()
  }

  async logout(): Promise<TeamStatus> {
    if (this.locked.size) throw new Error('还有团队窗口在运行，请先关闭')
    await Promise.allSettled(this.pushes.values())
    this.api = undefined
    this.user = undefined
    this.file.token = ''
    await this.save()
    return this.status()
  }

  // ---- members (owner) ------------------------------------------------------------------

  async listMembers(): Promise<TeamUser[]> {
    return (await this.requireOwner()).listUsers()
  }

  async createMember(draft: TeamMemberDraft): Promise<TeamUser> {
    if (!draft.username?.trim()) throw new Error('请填写用户名')
    if (!draft.password || draft.password.length < 8) throw new Error('密码至少 8 位')
    return (await this.requireOwner()).createMember({ ...draft, username: draft.username.trim(), password: draft.password })
  }

  async updateMember(id: string, draft: TeamMemberDraft): Promise<TeamUser> {
    if (draft.password !== undefined && draft.password !== '' && draft.password.length < 8) throw new Error('密码至少 8 位')
    return (await this.requireOwner()).updateMember(id, draft)
  }

  async removeMember(id: string): Promise<void> {
    return (await this.requireOwner()).removeMember(id)
  }

  async logs(query: TeamLogQuery): Promise<TeamLogPage> {
    return (await this.requireOwner()).logs(query)
  }

  // ---- shared windows ------------------------------------------------------------------

  private localIdOf(teamId: string): string | undefined {
    return Object.entries(this.file.links).find(([, link]) => link.teamId === teamId)?.[0]
  }

  links(): TeamLinkView[] {
    // Until an owner signs in here, linked windows stay read-only (also while offline).
    const member = this.file.role !== 'owner'
    return Object.entries(this.file.links).map(([profileId, link]) => ({
      profileId,
      teamId: link.teamId,
      readOnly: member,
      pendingUpload: Boolean(link.pendingUpload)
    }))
  }

  async listProfiles(): Promise<TeamProfileView[]> {
    const api = this.requireApi()
    const [records, locks] = await Promise.all([api.listProfiles(), api.listLocks()])
    const now = Date.now()
    return records.map((record) => {
      const lock = locks.find((item) => item.profile === record.id && item.expires > now)
      const holder = lock?.expand?.holder
      return {
        id: record.id,
        name: record.name,
        note: record.note,
        assignees: record.assignees ?? [],
        configRev: record.config_rev,
        dataRev: record.data_rev,
        dataByName: record.expand?.data_by?.name || record.expand?.data_by?.username || '',
        dataSize: Number((record as RemoteProfile & { data_size?: number }).data_size ?? 0),
        updated: record.updated,
        sourceId: record.source_id,
        localId: this.localIdOf(record.id),
        lock: lock
          ? { holderId: lock.holder, holderName: holder?.name || holder?.username || '', device: lock.device, expires: lock.expires }
          : undefined
      }
    })
  }

  private assertClosed(id: string): void {
    const profile = this.profiles.get(id)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error(`请先关闭窗口「${profile.name}」`)
  }

  private async packLocal(id: string): Promise<{ file: string; size: number; sha256: string }> {
    await mkdir(this.workPath, { recursive: true })
    const cookies = await this.cookies.exportCookies(id)
    return packProfileState(this.profiles.profileDataPath(id), cookies, join(this.workPath, `${id}-${Date.now()}.tgz`))
  }

  /** Owner: shares local windows (config and current login state) with these members. */
  async share(ids: string[], assignees: string[]): Promise<TeamProfileView[]> {
    const api = await this.requireOwner()
    for (const id of ids) this.assertClosed(id)
    for (const id of ids) {
      const profile = this.profiles.get(id)
      const config = portableDraft(profile, { passwords: 'keep', extensions: false })
      const existing = this.file.links[id]
      if (existing) {
        // Already shared: the login state moves only through open and close.
        const record = await api.saveProfile(existing.teamId, { name: profile.name, note: profile.note, config, assignees })
        existing.configRev = record.config_rev
        await this.save()
        continue
      }
      const packed = await this.packLocal(id)
      try {
        const record = await api.saveProfile(undefined, {
          name: profile.name,
          note: profile.note,
          source_id: id,
          config,
          assignees
        }, { ...packed, rev: 1 })
        this.file.links[id] = { teamId: record.id, dataRev: record.data_rev, configRev: record.config_rev }
        await this.save()
        this.logger?.info('窗口已共享到团队', { profileId: id, teamId: record.id, bytes: packed.size })
      } finally {
        await rm(packed.file, { force: true })
      }
    }
    return this.listProfiles()
  }

  async updateProfile(teamId: string, patch: TeamProfilePatch): Promise<unknown> {
    return (await this.requireOwner()).updateProfile(teamId, patch)
  }

  /** Owner: stops sharing. Members lose access; local windows stay as normal windows. */
  async unshare(teamId: string): Promise<void> {
    await (await this.requireOwner()).removeProfile(teamId)
    const localId = this.localIdOf(teamId)
    if (localId) {
      delete this.file.links[localId]
      await this.save()
    }
  }

  async forceUnlock(teamId: string): Promise<void> {
    return (await this.requireOwner()).unlock(teamId, true)
  }

  /** Member: puts a shared window on this computer; its login state comes down on first open. */
  async addToComputer(teamId: string): Promise<string> {
    const existing = this.localIdOf(teamId)
    if (existing) return existing
    const record = await this.requireApi().getProfile(teamId)
    const created = await this.profiles.create(configDraft(record.config, record.name))
    this.file.links[created.id] = { teamId, dataRev: 0, configRev: record.config_rev }
    await this.save()
    return created.id
  }

  /** Owner edited a linked window here: send the new config to the server. */
  async afterLocalEdit(id: string): Promise<void> {
    const link = this.file.links[id]
    if (!link || this.user?.role !== 'owner' || !this.api) return
    const profile = this.profiles.get(id)
    try {
      const record = await this.api.saveProfile(link.teamId, {
        name: profile.name,
        note: profile.note,
        config: portableDraft(profile, { passwords: 'keep', extensions: false })
      })
      link.configRev = record.config_rev
      await this.save()
    } catch (error) {
      this.logger?.error('团队窗口配置同步失败', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      throw new Error(`本机已保存，但同步到团队失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Members only use team windows; changing or copying them out is the owner's call. */
  assertEditable(id: string): void {
    if (this.file.links[id] && this.file.role !== 'owner') throw new Error('这是团队分配的窗口，只有主账号可以修改或导出')
  }

  // ---- open and close ------------------------------------------------------------------

  /** Before a linked window starts: take the lock, then bring config and login state up to date. */
  async beforeLaunch(id: string): Promise<void> {
    await this.verifySession()
    const link = this.file.links[id]
    if (!link) return
    const pending = this.pushes.get(id)
    if (pending) await pending
    const api = this.requireApi()
    await api.lock(link.teamId, hostname())
    this.locked.add(id)
    try {
      let record: RemoteProfile
      try {
        record = await api.getProfile(link.teamId)
      } catch (error) {
        if (error instanceof TeamApiError && error.status === 404) throw new Error('这个团队窗口已被收回或删除')
        throw error
      }
      if (link.pendingUpload && record.data_rev === link.dataRev) {
        // Last close could not upload and nobody has changed it since.
        await this.upload(id, link)
      } else if (link.pendingUpload) {
        this.logger?.error('上次未上传的登录态已被更新的版本取代', { profileId: id, local: link.dataRev, remote: record.data_rev })
        link.pendingUpload = false
      }
      if (record.config_rev > link.configRev) {
        const current = this.profiles.get(id)
        const draft = configDraft(record.config, record.name)
        await this.profiles.update(id, { ...draft, extensionIds: current.extensionIds })
        link.configRev = record.config_rev
      }
      if (record.data_rev > link.dataRev && record.data) {
        this.onSync({ profileId: id, phase: 'pulling' })
        await mkdir(this.workPath, { recursive: true })
        const archive = join(this.workPath, `${id}-pull-${Date.now()}.tgz`)
        try {
          await api.downloadData(record, archive)
          const expected = (record as RemoteProfile & { data_sha256?: string }).data_sha256
          if (expected && await sha256File(archive) !== expected) throw new Error('下载的登录态校验失败，请重试')
          const cookies = await unpackProfileState(archive, this.profiles.profileDataPath(id))
          if (cookies.length) await this.cookies.importCookies(id, cookies)
          link.dataRev = record.data_rev
          this.logger?.info('团队窗口登录态已拉取', { profileId: id, rev: record.data_rev, cookies: cookies.length })
        } finally {
          await rm(archive, { force: true })
        }
        this.onSync({ profileId: id, phase: 'done' })
      }
      await this.save()
      this.startHeartbeat(id, link.teamId)
    } catch (error) {
      this.onSync({ profileId: id, phase: 'error', message: error instanceof Error ? error.message : String(error) })
      await this.release(id)
      throw error
    }
  }

  /** The launch failed after beforeLaunch: give the lock back without uploading. */
  async launchFailed(id: string): Promise<void> {
    // A browser that started and died uploads through afterExit, which releases by itself.
    if (this.file.links[id] && !this.pushes.has(id)) await this.release(id)
  }

  /** After a linked window exits: upload its login state, then give the lock back. */
  afterExit(id: string): Promise<void> {
    const link = this.file.links[id]
    if (!link || !this.locked.has(id)) return Promise.resolve()
    this.stopHeartbeat(id)
    const push = (async () => {
      try {
        await this.upload(id, link)
        this.onSync({ profileId: id, phase: 'done' })
      } catch (error) {
        link.pendingUpload = true
        await this.save().catch(() => undefined)
        const message = error instanceof Error ? error.message : String(error)
        this.logger?.error('团队窗口登录态上传失败', { profileId: id, error: message })
        this.onSync({ profileId: id, phase: 'error', message: `登录态上传失败，下次打开时重试：${message}` })
      } finally {
        await this.release(id)
      }
    })()
    this.pushes.set(id, push)
    void push.finally(() => { if (this.pushes.get(id) === push) this.pushes.delete(id) })
    return push
  }

  private async upload(id: string, link: TeamLink): Promise<void> {
    const api = this.requireApi()
    this.onSync({ profileId: id, phase: 'pushing' })
    const packed = await this.packLocal(id)
    try {
      const record = await api.saveProfile(link.teamId, {}, { ...packed, rev: link.dataRev + 1 })
      link.dataRev = record.data_rev
      link.pendingUpload = false
      await this.save()
      this.logger?.info('团队窗口登录态已上传', { profileId: id, rev: record.data_rev, bytes: packed.size })
    } finally {
      await rm(packed.file, { force: true })
    }
  }

  private async release(id: string): Promise<void> {
    this.stopHeartbeat(id)
    const link = this.file.links[id]
    if (!this.locked.delete(id) || !link || !this.api) return
    await this.api.unlock(link.teamId).catch((error) => {
      this.logger?.error('释放团队窗口占用失败', { profileId: id, error: error instanceof Error ? error.message : String(error) })
    })
  }

  private startHeartbeat(id: string, teamId: string): void {
    this.stopHeartbeat(id)
    this.heartbeats.set(id, setInterval(() => {
      void this.api?.heartbeat(teamId).catch((error) => {
        // Network trouble is retried by the next beat; a lost lock is reported once.
        if (error instanceof TeamApiError && error.status === 409) {
          this.stopHeartbeat(id)
          this.onSync({ profileId: id, phase: 'error', message: error.message })
        }
      })
    }, HEARTBEAT_MS))
  }

  private stopHeartbeat(id: string): void {
    const timer = this.heartbeats.get(id)
    if (timer) clearInterval(timer)
    this.heartbeats.delete(id)
  }

  /** Waits for uploads still running (app quit). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pushes.values())
  }

  /** A linked window was deleted here. */
  async forget(id: string): Promise<void> {
    if (!this.file.links[id]) return
    delete this.file.links[id]
    await this.save()
  }
}
