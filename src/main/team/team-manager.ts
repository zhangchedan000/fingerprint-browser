import { hostname } from 'node:os'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  TeamBackup,
  TeamInvite,
  TeamLinkView,
  TeamLogPage,
  TeamLogQuery,
  TeamMemberDraft,
  TeamOffsite,
  TeamOffsiteDraft,
  TeamProfilePatch,
  TeamProfileView,
  TeamRegistration,
  TeamRole,
  TeamServerInfo,
  TeamStatus,
  TeamSyncEvent,
  TeamUser
} from '../../shared/team'
import type { BrowserProfile, ProfileDraft } from '../../shared/types'
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
  /** Who created the cloud window; members may change their own ones. */
  ownerId?: string
}

interface TeamFile {
  schemaVersion: 1
  server: string
  /** Encrypted with the system credential store. */
  token: string
  /** Role of the account last signed in here; decides what linked windows allow offline. */
  role?: TeamRole
  /** Account last signed in here. */
  userId?: string
  links: Record<string, TeamLink>
  /**
   * Windows deleted on this computer: the cloud keeps them, this computer does not pull them
   * again, and restoring one from the recycle bin links it back.
   */
  removed?: Record<string, TeamLink>
}

const HEARTBEAT_MS = 30_000

/** The team server this build signs in to unless another address is entered. */
export const DEFAULT_TEAM_SERVER = 'https://temu.orenge.ccwu.cc'

/**
 * A window's config as it goes to the cloud, with where it came from: the serial number and
 * creation time it has on the computer that made it, so cloud windows of the same name can be
 * told apart (and found again after being deleted here).
 */
function cloudConfig(profile: BrowserProfile): ProfileDraft & { origin: { serialNumber: number; createdAt: string } } {
  return { ...portableDraft(profile, { passwords: 'keep', extensions: false }), origin: { serialNumber: profile.serialNumber, createdAt: profile.createdAt } }
}

/** The origin a cloud config carries (configs uploaded before it was added have none). */
function configOrigin(config: unknown): { serialNumber?: number; createdAt?: string } {
  const origin = config && typeof config === 'object' ? (config as { origin?: unknown }).origin : undefined
  if (!origin || typeof origin !== 'object') return {}
  const { serialNumber, createdAt } = origin as { serialNumber?: unknown; createdAt?: unknown }
  return {
    ...(Number.isInteger(serialNumber) && Number(serialNumber) > 0 ? { serialNumber: Number(serialNumber) } : {}),
    ...(typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)) ? { createdAt } : {})
  }
}

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
      this.file.userId = this.user.id
      this.file.token = this.secrets.encode(api.token)
      await this.save()
      this.scheduleSync()
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
    this.file.userId = user.id
    await this.save()
    this.scheduleSync()
    this.logger?.info('团队已登录', { server: normalized, user: user.username, role: user.role })
    return this.status()
  }

  /** Signs up with an invite code on the built-in server, then signs in. */
  async register(draft: TeamRegistration): Promise<TeamStatus> {
    const server = this.file.server || DEFAULT_TEAM_SERVER
    if (!draft.code.trim()) throw new Error('请填写邀请码')
    if (!/^[^\s@]{2,64}$/.test(draft.username.trim())) throw new Error('用户名 2 到 64 个字符，不能有空格和 @')
    if (draft.password.length < 8) throw new Error('密码至少 8 位')
    await new TeamApi(server, this.fetcher).register({ ...draft, username: draft.username.trim(), name: draft.name.trim() })
    return this.login(server, draft.username, draft.password)
  }

  /** The server signs out everywhere on a new password; this computer signs in again with it. */
  async changePassword(oldPassword: string, password: string): Promise<TeamStatus> {
    await this.restoring
    const api = this.requireApi()
    const user = this.user
    if (!user) throw new Error('请先登录')
    if (password.length < 8) throw new Error('新密码至少 8 位')
    await api.changePassword(user.id, oldPassword, password)
    return this.login(this.file.server || DEFAULT_TEAM_SERVER, user.username, password)
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

  async invites(): Promise<TeamInvite[]> {
    return (await this.requireOwner()).listInvites()
  }

  async createInvite(note: string): Promise<TeamInvite> {
    return (await this.requireOwner()).createInvite(note.trim())
  }

  async revokeInvite(id: string): Promise<void> {
    return (await this.requireOwner()).revokeInvite(id)
  }

  async logs(query: TeamLogQuery): Promise<TeamLogPage> {
    return (await this.requireOwner()).logs(query)
  }

  // ---- server page -----------------------------------------------------------------------

  async serverInfo(): Promise<TeamServerInfo> {
    return (await this.requireOwner()).serverInfo()
  }

  async backups(): Promise<TeamBackup[]> {
    return (await this.requireOwner()).listBackups()
  }

  async createBackup(): Promise<{ key: string }> {
    const result = await (await this.requireOwner()).createBackup()
    this.logger?.info('团队服务器已备份', result)
    return result
  }

  async setOffsite(draft: TeamOffsiteDraft): Promise<TeamOffsite> {
    const result = await (await this.requireOwner()).setOffsite(draft)
    this.logger?.info('团队服务器已开启异地备份', { bucket: result.bucket })
    return result
  }

  async removeOffsite(): Promise<void> {
    await (await this.requireOwner()).removeOffsite()
    this.logger?.info('团队服务器已关闭异地备份')
  }

  async removeBackup(key: string): Promise<void> {
    return (await this.requireOwner()).removeBackup(key)
  }

  async downloadBackup(key: string, target: string): Promise<void> {
    await (await this.requireOwner()).downloadBackup(key, target)
    this.logger?.info('团队服务器备份已下载', { key, target })
  }

  // ---- cloud windows ---------------------------------------------------------------------

  private localIdOf(teamId: string): string | undefined {
    return Object.entries(this.file.links).find(([, link]) => link.teamId === teamId)?.[0]
  }

  /** Members use the windows assigned to them as they are; their own ones they may change. */
  private isReadOnly(link: TeamLink): boolean {
    return this.file.role !== 'owner' && link.ownerId !== this.file.userId
  }

  links(): TeamLinkView[] {
    return Object.entries(this.file.links).map(([profileId, link]) => ({
      profileId,
      teamId: link.teamId,
      readOnly: this.isReadOnly(link),
      pendingUpload: Boolean(link.pendingUpload)
    }))
  }

  async listProfiles(): Promise<TeamProfileView[]> {
    const api = this.requireApi()
    const [records, locks] = await Promise.all([api.listProfiles(), api.listLocks()])
    const removed = new Set(Object.values(this.file.removed ?? {}).map((link) => link.teamId))
    const now = Date.now()
    return records.map((record) => {
      const lock = locks.find((item) => item.profile === record.id && item.expires > now)
      const holder = lock?.expand?.holder
      const origin = configOrigin(record.config)
      const local = this.localIdOf(record.id)
      const localProfile = local ? this.profiles.list().find((item) => item.id === local) : undefined
      return {
        id: record.id,
        name: record.name,
        note: record.note,
        // Older cloud windows: the linked window here, else when the cloud got it.
        serialNumber: origin.serialNumber ?? localProfile?.serialNumber,
        createdAt: origin.createdAt ?? localProfile?.createdAt ?? record.created ?? record.updated,
        ownerId: record.owner ?? '',
        assignees: record.assignees ?? [],
        configRev: record.config_rev,
        dataRev: record.data_rev,
        dataByName: record.expand?.data_by?.name || record.expand?.data_by?.username || '',
        dataSize: Number(record.data_size ?? 0),
        updated: record.updated,
        sourceId: record.source_id,
        localId: this.localIdOf(record.id),
        removedHere: removed.has(record.id),
        lock: lock
          ? { holderId: lock.holder, holderName: holder?.name || holder?.username || '', device: lock.device, expires: lock.expires }
          : undefined
      }
    })
  }

  private isClosed(id: string): boolean {
    const profile = this.profiles.get(id)
    return profile.status === 'closed' || profile.status === 'error'
  }

  private async packLocal(id: string): Promise<{ file: string; size: number; sha256: string }> {
    await mkdir(this.workPath, { recursive: true })
    const cookies = await this.cookies.exportCookies(id)
    return packProfileState(this.profiles.profileDataPath(id), cookies, join(this.workPath, `${id}-${Date.now()}.tgz`))
  }

  /** Puts a window of this computer into the cloud: its config and current login state. */
  private async uploadNew(id: string): Promise<void> {
    const api = this.requireApi()
    const profile = this.profiles.get(id)
    const packed = await this.packLocal(id)
    try {
      const record = await api.saveProfile(undefined, {
        name: profile.name,
        note: profile.note,
        source_id: id,
        owner: this.user!.id,
        config: cloudConfig(profile)
      }, { ...packed, rev: 1 })
      this.file.links[id] = { teamId: record.id, dataRev: record.data_rev, configRev: record.config_rev, ownerId: this.user!.id }
      await this.save()
      this.logger?.info('窗口已存到云端', { profileId: id, teamId: record.id, bytes: packed.size })
    } finally {
      await rm(packed.file, { force: true })
    }
  }

  private syncing?: Promise<void>
  private syncTimer?: NodeJS.Timeout

  /** Delay of scheduleSync; tests set it below 0 and call sync() themselves. */
  syncDelayMs = 1000

  /** Runs sync() soon; several changes in a row make one pass. */
  scheduleSync(): void {
    if (this.syncDelayMs < 0) return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      void this.sync().catch((error) => {
        this.logger?.error('云端窗口同步失败', { error: error instanceof Error ? error.message : String(error) })
      })
    }, this.syncDelayMs)
  }

  /**
   * Every window is a cloud window. Windows of this account that are not on this computer come
   * down (config now, login state on first open); windows of this computer not in the cloud yet
   * go up. Windows deleted here stay in the cloud and are not pulled again.
   */
  async sync(): Promise<{ added: number; uploaded: number }> {
    if (this.syncing) {
      await this.syncing
      return this.sync()
    }
    let result = { added: 0, uploaded: 0 }
    this.syncing = (async () => {
      await this.restoring
      if (!this.api || !this.user) return
      const removed = this.file.removed ?? (this.file.removed = {})
      // Restored from the recycle bin: linked again rather than uploaded as a new window.
      for (const [profileId, link] of Object.entries(removed)) {
        if (this.profiles.list().some((profile) => profile.id === profileId)) {
          this.file.links[profileId] = link
          delete removed[profileId]
        }
      }
      const records = await this.api.listProfiles()
      const hidden = new Set(Object.values(removed).map((link) => link.teamId))
      for (const record of records) {
        if (this.localIdOf(record.id) || hidden.has(record.id)) continue
        await this.addToComputer(record.id, record)
        result.added += 1
      }
      for (const profile of this.profiles.list()) {
        // A running window goes up once it is closed (afterExit runs sync again).
        if (this.file.links[profile.id] || !this.isClosed(profile.id)) continue
        try {
          await this.uploadNew(profile.id)
          result.uploaded += 1
        } catch (error) {
          this.logger?.error('窗口上传到云端失败', { profileId: profile.id, error: error instanceof Error ? error.message : String(error) })
        }
      }
      await this.save()
    })()
    try {
      await this.syncing
    } finally {
      this.syncing = undefined
    }
    if (result.added || result.uploaded) this.logger?.info('云端窗口已同步', result)
    return result
  }

  /** Owner: who may use these cloud windows (the owner always can). */
  async share(teamIds: string[], assignees: string[]): Promise<TeamProfileView[]> {
    const api = await this.requireOwner()
    for (const teamId of teamIds) await api.updateProfile(teamId, { assignees })
    return this.listProfiles()
  }

  async updateProfile(teamId: string, patch: TeamProfilePatch): Promise<unknown> {
    return (await this.requireOwner()).updateProfile(teamId, patch)
  }

  /**
   * Owner: deletes a cloud window for everyone. This computer's copy goes to the recycle bin
   * too (it would otherwise go up again as a new window); other computers keep theirs, unopenable.
   */
  async unshare(teamId: string): Promise<void> {
    const api = await this.requireOwner()
    const localId = this.localIdOf(teamId)
    if (localId && !this.isClosed(localId)) throw new Error('请先关闭这个窗口')
    await api.removeProfile(teamId)
    if (localId) {
      delete this.file.links[localId]
      await this.save()
      await this.profiles.remove(localId)
    }
    for (const [profileId, link] of Object.entries(this.file.removed ?? {})) {
      if (link.teamId === teamId) delete this.file.removed![profileId]
    }
    await this.save()
  }

  async forceUnlock(teamId: string): Promise<void> {
    return (await this.requireOwner()).unlock(teamId, true)
  }

  /** Puts a cloud window on this computer; its login state comes down on first open. */
  async addToComputer(teamId: string, known?: RemoteProfile): Promise<string> {
    const existing = this.localIdOf(teamId)
    if (existing) return existing
    const record = known ?? await this.requireApi().getProfile(teamId)
    const created = await this.profiles.create(configDraft(record.config, record.name))
    this.file.links[created.id] = { teamId, dataRev: 0, configRev: record.config_rev, ownerId: record.owner }
    for (const [profileId, link] of Object.entries(this.file.removed ?? {})) {
      if (link.teamId === teamId) delete this.file.removed![profileId]
    }
    await this.save()
    this.onProfileAdded?.(created.id)
    return created.id
  }

  /** Tells the window list about windows that came down from the cloud. */
  onProfileAdded?: (id: string) => void

  /** A window changed here: send the new config to the cloud (the owner's, or a member's own). */
  async afterLocalEdit(id: string): Promise<void> {
    const link = this.file.links[id]
    if (!link || !this.api || this.isReadOnly(link)) return
    const profile = this.profiles.get(id)
    try {
      const record = await this.api.saveProfile(link.teamId, {
        name: profile.name,
        note: profile.note,
        config: cloudConfig(profile)
      })
      link.configRev = record.config_rev
      await this.save()
    } catch (error) {
      this.logger?.error('云端窗口配置同步失败', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      throw new Error(`本机已保存，但同步到云端失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Windows assigned to a member are used as they are; changing or copying them out is the owner's call. */
  assertEditable(id: string): void {
    const link = this.file.links[id]
    if (link && this.isReadOnly(link)) throw new Error('这是分配给你的窗口，只有主账号可以修改或导出')
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
          await this.cookies.importCookies(id, cookies, { replace: true })
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
    // A window that was not in the cloud yet (opened before it went up) goes up now.
    if (!link) this.scheduleSync()
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

  /** A window was deleted here: the cloud keeps it, this computer does not pull it again. */
  async forget(id: string): Promise<void> {
    const link = this.file.links[id]
    if (!link) return
    ;(this.file.removed ??= {})[id] = link
    delete this.file.links[id]
    await this.save()
  }

  /** Puts a window deleted here back on this computer (from the Team page). */
  async restoreToComputer(teamId: string): Promise<string> {
    for (const [profileId, link] of Object.entries(this.file.removed ?? {})) {
      if (link.teamId === teamId) delete this.file.removed![profileId]
    }
    await this.save()
    return this.addToComputer(teamId)
  }
}
