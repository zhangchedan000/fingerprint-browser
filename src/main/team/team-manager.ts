import { createHash, randomUUID } from 'node:crypto'
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
  TeamServerPair,
  TeamStatus,
  TeamSyncEvent,
  TeamUser
} from '../../shared/team'
import type { BrowserProfile, ProfileDraft, TunnelRoute } from '../../shared/types'
import type { PortableTunnelSource } from '../tunnel-manager'
import { validateProfileDraft } from '../../shared/validation'
import type { Logger } from '../app-logger'
import type { CookieManager } from '../cookie-manager'
import type { ProfileStore } from '../profile-store'
import { portableDraft } from '../profile-portable'
import type { SecretCodec } from '../secret-codec'
import { normalizeServer, TeamApi, TeamApiError, TeamMovedError, type Fetch, type RemoteProfile, type TeamServerStatus, type UploadDevice } from './team-api'
import { packProfileState, sha256File, unpackProfileState, type PasswordTransfer } from './team-archive'
import { applyCheckRecords, collectCheckRecords } from './team-records'
import { adoptWindowExtensions, windowExtensions } from './team-extensions'
import type { ExtensionStore } from '../extension-store'
import { fingerprintCheckStore } from '../fingerprint-check'
import { windowsKeyProtector, type KeyProtector } from './saved-passwords'

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
  /**
   * Set by 0.5.55–0.5.57 (a copy per computer): the login state here may be this computer's own older
   * copy rather than the latest. The next open brings the latest and clears it.
   */
  deviceRev?: number
}

/**
 * A window deleted on this computer, and what the account knows of it. Deleting is account-wide (user,
 * 2026-11-04: one account on several computers keeps one state; a deleted window goes to every
 * computer's recycle bin and can be restored from any of them): the cloud window is marked deleted
 * (config.deletedAt), not removed, so it stays restorable.
 * - 'deleted': the cloud window is marked deleted;
 * - 'pending': deleted here while the server could not be reached; marked at the next sync;
 * - 'local': a window assigned to a member, who may not delete it for the account: gone here only;
 * - unset: deleted by a version before account-wide deleting (here only): marked deleted at the next
 *   sync unless it was used or changed elsewhere since, in which case it comes back here.
 */
interface RemovedLink extends TeamLink {
  cloud?: 'deleted' | 'pending' | 'local'
}

/** When the cloud window was deleted for the account (in the recycle bins), or undefined. */
function cloudDeletedAt(config: unknown): string | undefined {
  const value = config && typeof config === 'object' ? (config as { deletedAt?: unknown }).deletedAt : undefined
  return typeof value === 'string' && value ? value : undefined
}

export const CLOUD_DELETE_NEEDS_TRASH = '先在窗口列表里删除（移到回收站），才能删除云端备份'

function withoutDeletedAt(config: unknown): Record<string, unknown> {
  const { deletedAt: _deletedAt, ...rest } = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>
  return rest
}

function plainLink({ cloud: _cloud, ...link }: RemovedLink): TeamLink {
  return link
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
  removed?: Record<string, RemovedLink>
  /** The account last signed in here, shown in local mode. */
  userName?: string
  displayName?: string
  /** The team's servers (the active one and its standby), as the server last said. */
  servers?: string[]
  /** Working without the server (it could not be reached); see enterLocalMode. */
  localMode?: boolean
  /** Team windows opened, closed or changed in local mode: they go up when a server is back. */
  localTouched?: string[]
  /** Activation codes of standby servers (the owner's computer), encrypted like the token. */
  activationCodes?: Record<string, string>
  /** The account's libraries (proxies, groups, 网络加速 nodes, settings) as this computer last sent or took them (a hash). */
  workspaceHash?: string
  /** The server's version (updated time) of those libraries this computer last sent or took; unset: never synced both ways. */
  workspaceSeen?: string
  /** This computer's fixed id for its own copies of login states (made once, kept). */
  deviceId?: string
}

const HEARTBEAT_MS = 30_000
/** How long a standby server may take to pull the data from R2 and restart as the active one. */
const TAKEOVER_WAIT_MS = 3 * 60_000

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
  /** Fingerprint seeds of the team's cloud windows not on this computer, from the last listing. */
  private cloudSeeds = new Set<number>()

  /** The 网络加速 node sources a window uses (set by the app), so they go to the cloud with it. */
  tunnelSources?: (route: TunnelRoute | undefined) => PortableTunnelSource[]
  /** Adds node sources that came with a cloud window and are missing here. */
  adoptTunnelSources?: (sources: unknown) => Promise<void>

  /**
   * A window's cloud config, with what makes it work the same on another computer: the node
   * sources of its 网络加速 and, for API 提取, the proxy it is on, its IP history and check log.
   */
  private noteCloudSeeds(records: Array<{ id: string; config?: unknown }>): void {
    const seeds = new Set<number>()
    for (const record of records) {
      if (this.localIdOf(record.id)) continue
      const seed = (record.config as { fingerprint?: { seed?: unknown } } | undefined)?.fingerprint?.seed
      if (typeof seed === 'number' && Number.isInteger(seed)) seeds.add(seed)
    }
    this.cloudSeeds = seeds
  }

  /** Seeds the team's cloud windows use: a new window here takes none of them. */
  seedsInUse(): Iterable<number> {
    return this.cloudSeeds
  }

  private cloudConfig(profile: BrowserProfile): ProfileDraft & { origin: { serialNumber: number; createdAt: string }; favorite: boolean } {
    const sources = this.tunnelSources?.(profile.tunnel) ?? []
    return {
      ...cloudConfig(profile),
      // 收藏 follows the account too.
      favorite: profile.favorite === true,
      ...(sources.length ? { tunnelSources: sources } : {}),
      ...(profile.apiProxy ? {
        apiState: {
          ...(profile.apiProxy.endpoint ? { endpoint: { ...profile.apiProxy.endpoint, password: profile.proxy.password } } : {}),
          ...(profile.apiProxy.history ? { history: profile.apiProxy.history } : {}),
          ...(profile.apiProxy.log ? { log: profile.apiProxy.log } : {}),
          ...(profile.proxyCheck ? { check: profile.proxyCheck } : {})
        }
      } : {})
    }
  }

  /** Locks Chrome's password key for this computer's user (Windows); tests set their own. */
  keyProtector: KeyProtector | undefined = windowsKeyProtector

  private passwordTransfer(id: string): PasswordTransfer {
    return {
      protector: this.keyProtector,
      onError: (error) => this.logger?.error('保存的密码没有随登录态同步', { profileId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * This computer's config of a window, when it may go up: the account may change it and the
   * cloud still has the version this computer last took (nothing newer would be overwritten).
   */
  private async configToPush(id: string, link: TeamLink): Promise<ReturnType<TeamManager['cloudConfig']> | undefined> {
    if (this.isReadOnly(link)) return undefined
    const remote = await this.requireApi().getProfile(link.teamId)
    return remote.config_rev === link.configRev ? this.cloudConfig(this.profiles.get(id)) : undefined
  }

  /** What came with a cloud config beside the window itself (cloudConfig): nodes and the API proxy. */
  private async applyCloudExtras(id: string, config: unknown): Promise<void> {
    const extras = (config && typeof config === 'object' ? config : {}) as { tunnelSources?: unknown; apiState?: unknown }
    try {
      await this.adoptTunnelSources?.(extras.tunnelSources)
      if (extras.apiState) await this.profiles.restoreApiState(id, extras.apiState)
    } catch (error) {
      this.logger?.error('云端窗口的加速节点或 API 代理没有带过来', { profileId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Windows this version wrote values into on first start: their cloud copies get the same values. */
  private async pushRewritten(): Promise<void> {
    for (const id of this.profiles.takeRewrittenOnLoad()) {
      const link = this.file.links[id]
      // A config changed elsewhere since this computer took it is newer: it comes down at the next launch.
      if (!link || !await this.configToPush(id, link).catch(() => undefined)) continue
      await this.afterLocalEdit(id).catch((error) => {
        this.logger?.error('固定后的窗口配置没有同步到云端', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      })
    }
  }

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

  /** This computer's extensions: a team window's go along with its login state (team-extensions.ts). */
  extensions?: ExtensionStore

  /** The windows' fingerprint check reports (the same store the editor writes). */
  private get fingerprintChecks() {
    return fingerprintCheckStore(join(this.vaultPath, 'fingerprint-checks.json'))
  }

  /** False: the team feature is off (TEAM_FEATURE_ENABLED): nothing here reaches a server. */
  enabled = true

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
    if (!this.enabled) return
    if (this.file.server && this.file.token) {
      const api = this.followTeam(new TeamApi(this.file.server, this.fetcher))
      try {
        api.token = this.secrets.decode(this.file.token)
        this.api = api
      } catch (error) {
        this.logger?.error('团队登录凭据无法读取', error)
        return
      }
      // In the background: the app must not wait for the server to start.
      this.restoring = this.restoreSession(api, this.restoreRetryMs)
    }
  }

  private restoring?: Promise<void>

  /** Resolves once the saved sign-in was checked at start (signed in or not). */
  async whenOnline(): Promise<void> {
    await this.restoring
  }

  private poll?: NodeJS.Timeout
  /** While signed in, every computer of the account looks at the cloud this often (one state everywhere). */
  pollMs = 30_000

  private startPolling(): void {
    if (this.poll || this.pollMs <= 0 || this.syncDelayMs < 0) return
    this.poll = setInterval(() => this.scheduleSync(), this.pollMs)
    this.poll.unref?.()
  }
  /** Why the saved sign-in could not be checked (server unreachable); the app stays locked. */
  private offline?: string
  private verifiedAt = 0

  /** At start an unreachable server is tried again after these waits: a network blip is no error. */
  restoreRetryMs = [2_000, 4_000, 8_000]

  private async restoreSession(api: TeamApi, retryMs: number[] = [], failover = true): Promise<void> {
    this.offline = undefined
    try {
      this.user = await api.refresh()
      this.rememberUser(this.user)
      if (this.file.localMode) {
        // A server answers again: back from local mode (what was used there goes up in afterOnline).
        this.file.localMode = false
        this.logger?.info('团队服务器连上了，退出本地模式', { server: api.server })
      }
      this.verifiedAt = Date.now()
      this.file.role = this.user.role
      this.file.userId = this.user.id
      this.file.token = this.secrets.encode(api.token)
      await this.save()
      this.scheduleSync()
      this.startPolling()
      void this.pushRewritten()
      this.settling = this.afterOnline()
    } catch (error) {
      // The server moved, or is gone: the team's other server may be the one in use now.
      if (failover && (error instanceof TeamMovedError || (error instanceof TeamApiError && error.status === 0))) {
        const next = await this.findActiveServer(api.server, error instanceof TeamMovedError ? error.movedTo : '')
        if (next) {
          this.logger?.info('团队服务器换了，改连另一台', { from: api.server, to: next })
          return this.restoreSession(this.useServer(next, api.token), [], false)
        }
      }
      const rejected = error instanceof TeamApiError && error.status > 0 && !(error instanceof TeamMovedError)
      if (!rejected && retryMs.length) {
        this.logger?.info('团队服务器暂时连不上，稍后再试', { error: error instanceof Error ? error.message : String(error), waitMs: retryMs[0] })
        await new Promise((resolve) => setTimeout(resolve, retryMs[0]))
        return this.restoreSession(api, retryMs.slice(1))
      }
      // Unreachable: keep the token so "retry" can try again; rejected (expired, disabled): sign out.
      this.user = undefined
      if (rejected) {
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
    // App checks (tools/app-e2e) without a team server open this computer's own windows (see status()).
    if (process.env.PRISM_E2E === '1' && process.env.PRISM_E2E_TEAM_OFFLINE === '1' && !this.user) return
    const api = this.requireApi()
    if (!this.user) throw new Error('请先登录')
    if (Date.now() - this.verifiedAt < 60_000) return
    try {
      this.user = await api.refresh()
      this.verifiedAt = Date.now()
      this.file.token = this.secrets.encode(api.token)
      await this.save()
    } catch (error) {
      if (error instanceof TeamMovedError || (error instanceof TeamApiError && error.status === 0)) {
        const next = await this.findActiveServer(api.server, error instanceof TeamMovedError ? error.movedTo : '')
        if (next) {
          this.logger?.info('团队服务器换了，改连另一台', { from: api.server, to: next })
          const moved = this.useServer(next, api.token)
          this.user = await moved.refresh()
          this.verifiedAt = Date.now()
          this.file.token = this.secrets.encode(moved.token)
          await this.save()
          return
        }
      }
      if (error instanceof TeamApiError && error.status > 0 && !(error instanceof TeamMovedError)) {
        this.api = undefined
        this.user = undefined
        this.file.token = ''
        await this.save().catch(() => undefined)
        throw new Error('登录已失效（账号可能已被停用），请重新登录')
      }
      throw new Error(`连不上团队服务器，暂时不能打开窗口；服务器修好前可以点左上角头像进入本地模式（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  // ---- the team's two servers and local mode ------------------------------------------

  /** Works through `server` from now on, with the sign-in this computer has. */
  private useServer(server: string, token: string): TeamApi {
    const api = this.followTeam(new TeamApi(server, this.fetcher))
    api.token = token
    this.api = api
    this.file.server = server
    return api
  }

  /**
   * The app's connection follows the team: a request answered with "moved to X" goes to X (and
   * this computer remembers X), one answered with "switching" waits for the switch (TeamApi).
   */
  private followTeam(api: TeamApi): TeamApi {
    api.switchPollMs = this.switchPollMs
    api.onMoved = (server) => {
      if (this.api !== api) return
      this.file.server = server
      if (!(this.file.servers ?? []).includes(server)) this.file.servers = [...(this.file.servers ?? []), server]
      void this.save().catch(() => undefined)
      this.logger?.info('团队服务器换了，改连另一台', { to: server })
    }
    return api
  }

  /** Tests make the wait while servers switch short. */
  switchPollMs = 5_000

  /** The server of the team that is in use (active and set up), other than `current`. */
  private async findActiveServer(current: string, hint: string): Promise<string | undefined> {
    const candidates = [hint, ...(this.file.servers ?? [])].filter((url, index, all) => url && url !== current && all.indexOf(url) === index)
    for (const url of candidates) {
      const status = await new TeamApi(url, this.fetcher).status().catch(() => undefined)
      if (status?.ready && status.role === 'active') return url
    }
    return undefined
  }

  private rememberUser(user: TeamUser): void {
    this.file.userName = user.username
    this.file.displayName = user.name
  }

  /** Signed in and reachable: learn the team's servers, bring back what local mode left, sync the workspace. */
  private async afterOnline(): Promise<void> {
    try {
      const status = await this.requireApi().status()
      if (status.servers?.length) this.file.servers = status.servers
      await this.save()
      await this.syncServerCodes()
      await this.flushLocalChanges()
      await this.pullWorkspace()
    } catch (error) {
      this.logger?.error('连上团队服务器后的同步没做完', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private get online(): boolean {
    return this.enabled && !this.file.localMode
  }

  /** A team window used in local mode, to go up once a server is reachable. */
  private async touch(id: string): Promise<void> {
    if (!this.file.links[id]) return
    const touched = this.file.localTouched ?? []
    if (touched.includes(id)) return
    this.file.localTouched = [...touched, id]
    await this.save()
  }

  /** Sends what local mode changed: config, then the login state (each only if nobody changed it in the cloud since). */
  private async flushLocalChanges(): Promise<void> {
    const touched = [...(this.file.localTouched ?? [])]
    for (const id of touched) {
      try {
        await this.afterLocalEdit(id)
        await this.pushLoginState(id)
        this.logger?.info('本地模式下用过的团队窗口已传到云端', { profileId: id })
      } catch (error) {
        this.logger?.error('本地模式下用过的团队窗口没传上去', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      }
      this.file.localTouched = (this.file.localTouched ?? []).filter((item) => item !== id)
      await this.save()
    }
  }

  /**
   * The server cannot be reached (not: the account is stopped): work on this computer's windows
   * without it. Only an account that signed in here before; team windows go up once a server is back.
   */
  async enterLocalMode(): Promise<TeamStatus> {
    if (!this.enabled) throw new Error('团队功能已停用')
    await this.restoring
    if (!this.file.userId || !this.file.token) throw new Error('这台电脑还没登录过团队账号，不能进入本地模式')
    if (this.user && !this.offline) throw new Error('团队服务器连得上，不用进入本地模式')
    this.file.localMode = true
    await this.save()
    this.logger?.info('进入本地模式')
    return this.status()
  }

  /**
   * Connects to another server of the team (the panel's "连接其它服务器"). A server that is not in use
   * yet takes over first when the owner gives its activation code.
   */
  async connectServer(server: string, code?: string): Promise<TeamStatus> {
    if (!this.enabled) throw new Error('团队功能已停用')
    const url = normalizeServer(server)
    let status = await new TeamApi(url, this.fetcher).status()
    if (!(status.ready && status.role === 'active')) {
      const activation = code?.trim() || this.storedCode(url)
      if (!activation) throw new Error('这台服务器还没接班，需要主账号填它的激活码切换过去')
      status = await this.takeOver(url, activation)
    }
    if (!this.file.token) {
      // Not signed in here yet (a new computer while the default server is down): sign in there next.
      this.file.server = url
      if (!(this.file.servers ?? []).includes(url)) this.file.servers = [...(this.file.servers ?? []), url]
      await this.save()
      return this.status()
    }
    const api = this.useServer(url, this.secrets.decode(this.file.token))
    if (!(this.file.servers ?? []).includes(url)) this.file.servers = [...(this.file.servers ?? []), url]
    await this.save()
    this.restoring = this.restoreSession(api, [], false)
    await this.restoring
    if (!this.user) throw new Error(this.offline ? `连不上这台服务器（${this.offline}）` : '这台服务器上登录不了，请重新登录')
    return this.status()
  }

  private storedCode(url: string): string | undefined {
    const stored = this.file.activationCodes?.[url]
    if (!stored) return undefined
    try { return this.secrets.decode(stored) } catch { return undefined }
  }

  /** Has `url` pull the team's data from R2 and become the server in use; waits until it answers. */
  private async takeOver(url: string, code: string): Promise<TeamServerStatus> {
    const target = new TeamApi(url, this.fetcher)
    await target.activate(code)
    const deadline = Date.now() + TAKEOVER_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.takeoverPollMs))
      const status = await target.status().catch(() => undefined)
      if (status?.ready && status.role === 'active') return status
    }
    throw new Error('备用服务器接班超时，请稍后重试')
  }

  /**
   * Owner: the activation codes of the team's servers, kept on the server too, so every computer of
   * the owner switches between them with one click. Codes only this computer knows go up (an older
   * version kept them here only); the server's go into this computer's encrypted file.
   * A server without this (older program) is skipped.
   */
  private async syncServerCodes(): Promise<void> {
    if (this.file.role !== 'owner' || !this.api || !this.online || !this.user || this.offline) return
    const api = this.api
    try {
      const known = await api.serverCodes()
      const team = this.file.servers ?? []
      for (const url of team) {
        const local = this.storedCode(url)
        if (local && known[url] !== local) {
          await api.saveServerCode(url, local)
          known[url] = local
        }
      }
      const codes = { ...(this.file.activationCodes ?? {}) }
      let changed = false
      for (const [url, code] of Object.entries(known)) {
        if (code && this.storedCode(url) !== code) {
          codes[url] = this.secrets.encode(code)
          changed = true
        }
      }
      if (changed) {
        this.file.activationCodes = codes
        await this.save()
      }
    } catch (error) {
      if (!(error instanceof TeamApiError && error.status === 404)) {
        this.logger?.error('同步服务器激活码没做完', { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /** Tests make the wait for a server's restart short. */
  takeoverPollMs = 3000

  /** The team's servers as the active one sees them, for the 服务器 page. */
  async serverPair(): Promise<TeamServerPair> {
    await this.syncServerCodes()
    const current = this.file.server || DEFAULT_TEAM_SERVER
    const urls = [current, ...(this.file.servers ?? [])].filter((url, index, all) => url && all.indexOf(url) === index)
    const servers = await Promise.all(urls.map(async (url) => {
      const status = await new TeamApi(url, this.fetcher).status().catch(() => undefined)
      return { url, reachable: Boolean(status), role: status?.role, ready: status?.ready ?? false, codeSaved: Boolean(this.file.activationCodes?.[url]) }
    }))
    return { current, servers }
  }

  /**
   * Owner: adds `server` to the team's servers as a standby (any number of them; adding one that is
   * already there just checks and keeps its code). The active server names it (and checks it
   * answers), then it gets the R2 bucket with its activation code, kept here and on the server.
   */
  async setStandby(server: string, code: string): Promise<TeamServerPair> {
    const api = await this.requireOwner()
    const url = normalizeServer(server)
    if (url === api.server) throw new Error('这是正在用的这台，不用添加')
    if (!code.trim()) throw new Error('请填写这台服务器的激活码')
    const key = await api.offsiteKey()
    // Needs the server program with multi-server support (2026-11-01); both servers are updated first.
    const named = await api.addServer(url)
    await new TeamApi(url, this.fetcher).standbySetup(code.trim(), key)
    this.file.servers = named.servers?.length ? named.servers : [...new Set([...(this.file.servers ?? [api.server]), url])]
    this.file.activationCodes = { ...(this.file.activationCodes ?? {}), [url]: this.secrets.encode(code.trim()) }
    await this.save()
    // The server keeps it too, for the owner's other computers.
    await api.saveServerCode(url, code.trim()).catch(() => undefined)
    this.logger?.info('备用服务器已设置', { standby: url })
    return this.serverPair()
  }

  /** Owner: `server` is no longer one of the team's servers (not the one in use). */
  async removeServer(server: string): Promise<TeamServerPair> {
    const api = await this.requireOwner()
    const url = normalizeServer(server)
    if (url === api.server) throw new Error('正在用的这台不能移除')
    const named = await api.removeServer(url)
    this.file.servers = named.servers?.length ? named.servers : (this.file.servers ?? []).filter((item) => item !== url)
    const codes = { ...(this.file.activationCodes ?? {}) }
    delete codes[url]
    this.file.activationCodes = codes
    await this.save()
    this.logger?.info('服务器已移除', { server: url })
    return this.serverPair()
  }

  /**
   * Owner: the whole team moves to `server` (批量切换). The server in use stops writing and leaves
   * everything in R2 (skipped when it is down), the other one takes over from R2, and every app
   * follows it (they know its address, and the old server points to it).
   */
  async switchServer(server: string, code?: string): Promise<TeamStatus> {
    if (!this.enabled) throw new Error('团队功能已停用')
    if (this.file.role !== 'owner') throw new Error('只有主账号可以切换服务器')
    const url = normalizeServer(server)
    const activation = code?.trim() || this.storedCode(url)
    if (!activation) throw new Error('请填写这台服务器的激活码')
    if (this.api && this.user && this.api.server !== url) {
      await this.api.handover().catch((error: unknown) => {
        // Down or unreachable: it cannot write either; anything else stops the switch.
        if (!(error instanceof TeamApiError && error.status === 0)) throw error
      })
    }
    return this.connectServer(url, activation)
  }

  // ---- the account's libraries: proxies, groups, 网络加速 nodes, settings ------------------

  /** Set by the app: this computer's libraries, and how to take the account's ('merge': add what is
   *  missing, keep the rest; 'mirror': become the same). */
  workspaceExport?: () => Promise<unknown>
  workspaceImport?: (data: unknown, mode: 'merge' | 'mirror') => Promise<void>
  private workspaceId?: string

  private static workspaceHashOf(data: unknown): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex')
  }

  /**
   * One set of libraries for the account on every computer (user, 2026-11-04), whoever changed them
   * last: changed here since the last sync → sent (this computer's are the latest); changed on another
   * computer → taken as they are (added, changed and removed here too). The first time on a computer
   * (or from a version before this) the two are merged, so nothing on either side is lost; also when
   * both changed between two syncs.
   */
  async pushWorkspace(): Promise<void> {
    if (!this.online || !this.api || !this.user || !this.workspaceExport) return
    const api = this.api
    const version = await api.workspaceVersion()
    this.workspaceId = version?.id
    const localHash = TeamManager.workspaceHashOf(await this.workspaceExport())
    const firstTime = this.file.workspaceSeen === undefined
    const changedHere = localHash !== this.file.workspaceHash
    const changedThere = Boolean(version) && version!.updated !== this.file.workspaceSeen
    if (version && this.workspaceImport && (firstTime || (changedHere && changedThere))) {
      const record = await api.getWorkspace()
      if (record?.data) await this.workspaceImport(record.data, 'merge')
      await this.sendWorkspace()
      return
    }
    if (changedHere || !version) {
      await this.sendWorkspace()
      return
    }
    if (changedThere && this.workspaceImport) {
      const record = await api.getWorkspace()
      if (record?.data) await this.workspaceImport(record.data, 'mirror')
      // What this computer has now (an entry still in use here may stay) counts as taken, not as a change here.
      this.file.workspaceHash = TeamManager.workspaceHashOf(await this.workspaceExport())
      this.file.workspaceSeen = record?.updated ?? version!.updated
      await this.save()
      this.logger?.info('代理库、分组、加速节点和设置已按账号同步', { from: record?.updated })
    }
  }

  private async sendWorkspace(): Promise<void> {
    const data = await this.workspaceExport!()
    const saved = await this.requireApi().saveWorkspace(this.workspaceId, this.user!.id, data)
    this.workspaceId = saved.id
    this.file.workspaceHash = TeamManager.workspaceHashOf(data)
    this.file.workspaceSeen = saved.updated ?? ''
    await this.save()
  }

  /** Right after signing in or reconnecting: the account's libraries (pushWorkspace merges the first time). */
  private async pullWorkspace(): Promise<void> {
    await this.pushWorkspace()
  }

  /** Writes team.json; saves from background work and from the user's actions wait for each other. */
  private save(): Promise<void> {
    const next = this.saving.catch(() => undefined).then(async () => {
      await mkdir(this.vaultPath, { recursive: true })
      const temp = `${this.filePath}.tmp`
      await writeFile(temp, JSON.stringify(this.file, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temp, this.filePath)
    })
    this.saving = next
    return next
  }

  private saving: Promise<void> = Promise.resolve()

  async status(): Promise<TeamStatus> {
    if (!this.enabled) return { server: this.file.server || DEFAULT_TEAM_SERVER, disabled: true }
    if (this.file.localMode) {
      // The account this computer signed in with last; the app is used without the server.
      const user = this.user ?? (this.file.userId ? {
        id: this.file.userId, username: this.file.userName ?? '', name: this.file.displayName ?? '', role: this.file.role ?? 'member', disabled: false, created: ''
      } : undefined)
      return { server: this.file.server || DEFAULT_TEAM_SERVER, user, offline: this.offline, localMode: true, servers: this.file.servers, canLocal: true }
    }
    await this.restoring
    // App checks (tools/app-e2e) run the UI without a team server: a signed-in user, offline.
    if (process.env.PRISM_E2E === '1' && process.env.PRISM_E2E_TEAM_OFFLINE === '1' && !this.user) {
      return { server: DEFAULT_TEAM_SERVER, user: { id: 'e2e', username: 'e2e', name: 'E2E', role: 'owner', disabled: false, created: '' }, offline: 'app check without a team server' }
    }
    return {
      server: this.file.server || DEFAULT_TEAM_SERVER,
      user: this.user,
      offline: this.offline,
      servers: this.file.servers,
      canLocal: Boolean(this.file.userId && this.file.token && this.offline)
    }
  }

  private requireApi(): TeamApi {
    if (!this.enabled) throw new Error('团队功能已停用')
    if (this.file.localMode) throw new Error('现在是本地模式，团队服务器连上后再做')
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
    if (!this.enabled) throw new Error('团队功能已停用')
    const normalized = normalizeServer(server)
    const status = await new TeamApi(normalized, this.fetcher).status().catch(async (error: unknown) => {
      // Down: answer for the team's server in use, if another one is.
      const next = await this.findActiveServer(normalized, '')
      if (!next) throw error
      return { ...(await new TeamApi(next, this.fetcher).status()), active: next, role: 'standby' as const }
    })
    // A server waiting as standby: what matters is the one in use (it may have no owner of its own yet).
    if (status.role === 'standby' && status.active && normalizeServer(status.active) !== normalized) {
      const active = normalizeServer(status.active)
      const current = await new TeamApi(active, this.fetcher).status().catch(() => undefined)
      if (current) return { server: active, ready: current.ready }
    }
    return { server: normalized, ready: status.ready }
  }

  async setup(server: string, code: string, username: string, name: string, password: string): Promise<TeamStatus> {
    if (!this.enabled) throw new Error('团队功能已停用')
    const normalized = normalizeServer(server)
    await new TeamApi(normalized, this.fetcher).setup(code.trim(), username.trim(), name.trim(), password)
    return this.login(normalized, username, password)
  }

  async login(server: string, username: string, password: string): Promise<TeamStatus> {
    if (!this.enabled) throw new Error('团队功能已停用')
    const asked = normalizeServer(server)
    const sameTeam = (url: string) => url === this.file.server || (this.file.servers ?? []).includes(url)
    if (this.file.server && !sameTeam(asked) && Object.keys(this.file.links).length) {
      throw new Error('这台电脑上还有其他团队服务器的窗口，请先在窗口管理里删除它们再换服务器')
    }
    // The team may have moved to another of its servers (批量切换): sign in where it is now.
    let normalized = asked
    let api = new TeamApi(normalized, this.fetcher)
    let user: TeamUser
    for (let hop = 0; ; hop++) {
      try {
        user = await api.login(username.trim(), password)
        break
      } catch (error) {
        // Down: the team's other server may be the one in use now.
        const next = error instanceof TeamApiError && error.status === 0 && hop < 2 ? await this.findActiveServer(normalized, '') : undefined
        if (!next && (!(error instanceof TeamMovedError) || !error.movedTo || hop >= 2)) throw error
        normalized = next ?? normalizeServer((error as TeamMovedError).movedTo)
        api = new TeamApi(normalized, this.fetcher)
        if (!(this.file.servers ?? []).includes(normalized)) this.file.servers = [...new Set([...(this.file.servers ?? []), asked, normalized])]
      }
    }
    if (this.user && this.user.id !== user.id && this.locked.size) throw new Error('还有团队窗口在运行，请先关闭再切换账号')
    this.api = this.followTeam(api)
    this.user = user
    this.offline = undefined
    this.verifiedAt = Date.now()
    this.file.server = normalized
    this.file.token = this.secrets.encode(api.token)
    this.file.role = user.role
    this.file.userId = user.id
    this.rememberUser(user)
    await this.save()
    this.scheduleSync()
    this.startPolling()
    this.settling = this.afterOnline()
    this.logger?.info('团队已登录', { server: normalized, user: user.username, role: user.role })
    return this.status()
  }

  /** Signs up with an invite code on the built-in server, then signs in. */
  async register(draft: TeamRegistration): Promise<TeamStatus> {
    if (!this.enabled) throw new Error('团队功能已停用')
    const server = this.file.server || DEFAULT_TEAM_SERVER
    if (!draft.code.trim()) throw new Error('请填写邀请码')
    if (!/^[^\s@]{2,64}$/.test(draft.username.trim())) throw new Error('用户名 2 到 64 个字符，不能有空格和 @')
    if (draft.password.length < 8) throw new Error('密码至少 8 位')
    // Registers where the team is now, if it moved (批量切换).
    let target = server
    const api = new TeamApi(server, this.fetcher)
    api.switchPollMs = this.switchPollMs
    api.onMoved = (url) => { target = url }
    await api.register({ ...draft, username: draft.username.trim(), name: draft.name.trim() })
    return this.login(target, draft.username, draft.password)
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
    if (this.poll) clearInterval(this.poll)
    this.poll = undefined
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

  /**
   * Names of the team's cloud windows other than the one linked to `profileId`, so a window saved
   * here does not take a name a teammate's window already has. Empty when signed out, in local
   * mode or when the server can't be reached: the local names are still checked.
   */
  async cloudWindowNames(profileId?: string): Promise<string[]> {
    if (!this.enabled || this.file.localMode || !this.api || !this.file.token) return []
    try {
      const own = profileId ? this.file.links[profileId]?.teamId : undefined
      return (await this.api.listProfiles()).filter((record) => record.id !== own).map((record) => record.name)
    } catch {
      return []
    }
  }

  async listProfiles(): Promise<TeamProfileView[]> {
    const api = this.requireApi()
    const [records, locks] = await Promise.all([api.listProfiles(), api.listLocks()])
    this.noteCloudSeeds(records)
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
        deletedAt: cloudDeletedAt(record.config),
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
    // The check records go along, so the next computer shows what this one found.
    const records = await collectCheckRecords(this.profiles, this.fingerprintChecks, id).catch(() => undefined)
    const extensions = this.extensions
      ? await windowExtensions(this.extensions, this.profiles.get(id)).catch((error) => {
        this.logger?.error('团队窗口的扩展没有带上', { profileId: id, error: error instanceof Error ? error.message : String(error) })
        return []
      })
      : []
    return packProfileState(this.profiles.profileDataPath(id), cookies, join(this.workPath, `${id}-${Date.now()}.tgz`), this.passwordTransfer(id), { records, extensions })
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
        config: this.cloudConfig(profile)
      }, { ...packed, rev: 1, device: this.device })
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
    if (!this.online || this.syncDelayMs < 0) return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      void this.sync().catch((error) => {
        this.logger?.error('云端窗口同步失败', { error: error instanceof Error ? error.message : String(error) })
      })
    }, this.syncDelayMs)
  }

  /**
   * One account, one state on every computer (user, 2026-11-04). Every window is a cloud window:
   * - windows of the account not on this computer come down (config now, login state on first open);
   *   windows of this computer not in the cloud yet go up;
   * - a window changed on another computer takes the change here once it is closed, without opening it;
   * - a window deleted anywhere goes to this computer's recycle bin (the cloud keeps it, marked
   *   deleted); restored anywhere, it comes back here (from this recycle bin, or from the cloud);
   *   permanently deleted anywhere, this computer's recycle bin drops it too.
   * Whatever happened last, on whichever computer, is what every computer shows.
   */
  async sync(): Promise<{ added: number; uploaded: number }> {
    if (!this.online) return { added: 0, uploaded: 0 }
    if (this.syncing) {
      await this.syncing
      return this.sync()
    }
    let result = { added: 0, uploaded: 0 }
    let changed = false
    this.syncing = (async () => {
      await this.restoring
      if (!this.api || !this.user) return
      const api = this.api
      const removed = this.file.removed ?? (this.file.removed = {})
      const records = await api.listProfiles()
      const byId = new Map(records.map((record) => [record.id, record]))
      this.noteCloudSeeds(records)
      const here = () => new Set(this.profiles.list().map((profile) => profile.id))
      if (await this.dropDuplicateTrash()) changed = true

      // Restored here from the recycle bin: linked again (not uploaded as a new window), and restored
      // for the account when it was deleted there.
      for (const [profileId, entry] of Object.entries(removed)) {
        if (!here().has(profileId)) continue
        delete removed[profileId]
        const record = byId.get(entry.teamId)
        // Permanently deleted elsewhere meanwhile: it goes up again as a new window.
        if (!record) continue
        const link = plainLink(entry)
        this.file.links[profileId] = link
        if (cloudDeletedAt(record.config) && !this.isReadOnly(link)) {
          const saved = await api.saveProfile(record.id, { config: this.cloudConfig(this.profiles.get(profileId)) })
          link.configRev = saved.config_rev
          byId.set(record.id, saved)
          this.logger?.info('从回收站恢复的窗口在账号里也恢复了', { profileId, teamId: record.id })
        }
      }

      // Windows deleted here, against the account.
      for (const [profileId, entry] of Object.entries(removed)) {
        if (removed[profileId] !== entry) continue
        const record = byId.get(entry.teamId)
        if (!record) {
          // Permanently deleted for the account: this recycle bin drops it too.
          if (entry.cloud === 'deleted') {
            await this.purgeLocalTrash(profileId)
            changed = true
          }
          delete removed[profileId]
          continue
        }
        if (cloudDeletedAt(record.config)) {
          entry.cloud = 'deleted'
          entry.configRev = record.config_rev
          continue
        }
        if (entry.cloud === 'local') continue
        if (entry.cloud === 'pending') {
          await this.markCloudDeleted(entry, record)
          continue
        }
        // Deleted here before deleting was account-wide: deleted for the account now, unless it was
        // used or changed elsewhere since (then the account has it, and so does this computer).
        if (entry.cloud === undefined && record.config_rev === entry.configRev && record.data_rev === entry.dataRev) {
          await this.markCloudDeleted(entry, record)
          continue
        }
        // Restored (or used) on another computer: back here too (from this recycle bin when it has it).
        await this.addToComputer(record.id, record)
        changed = true
      }

      const hidden = new Set(Object.values(removed).map((link) => link.teamId))
      for (const record of records) {
        const current = byId.get(record.id) ?? record
        const localId = this.localIdOf(record.id)
        if (localId) {
          if (!this.isClosed(localId)) continue
          if (cloudDeletedAt(current.config)) {
            // Deleted on another computer: into this recycle bin (a running window when it closes).
            await this.moveToRecycleBin(localId, current)
            changed = true
          } else if (current.config_rev > this.file.links[localId].configRev) {
            await this.applyCloudConfig(localId, current)
            changed = true
          }
          continue
        }
        // Deleted for the account: not brought to a computer that never had it (the Team page lists it).
        if (hidden.has(record.id) || cloudDeletedAt(current.config)) continue
        await this.addToComputer(record.id, current)
        result.added += 1
      }

      // Linked windows the account no longer has (permanently deleted, or taken back from a member).
      for (const [localId, link] of Object.entries(this.file.links)) {
        if (byId.has(link.teamId) || !here().has(localId) || !this.isClosed(localId)) continue
        delete this.file.links[localId]
        await this.profiles.remove(localId)
        this.logger?.info('账号里已没有这个窗口，本机的移到回收站', { profileId: localId, teamId: link.teamId })
        changed = true
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
      // The proxy library and 网络加速 go along with every sync (only when they changed).
      await this.pushWorkspace().catch((error: unknown) => {
        this.logger?.error('代理库和网络加速备份失败', { error: error instanceof Error ? error.message : String(error) })
      })
    })()
    try {
      await this.syncing
    } finally {
      this.syncing = undefined
    }
    if (result.added || result.uploaded) this.logger?.info('云端窗口已同步', result)
    if (changed || result.added) this.onProfilesChanged?.()
    return result
  }

  /** The window list changed in the background (sync): the app reloads it. */
  onProfilesChanged?: () => void

  /** Marks a cloud window deleted for the account (it stays restorable), or notes it as gone here only. */
  private async markCloudDeleted(entry: RemovedLink, known?: RemoteProfile): Promise<void> {
    if (this.isReadOnly(entry)) {
      entry.cloud = 'local'
      return
    }
    const api = this.requireApi()
    const record = known ?? await api.getProfile(entry.teamId)
    if (cloudDeletedAt(record.config)) {
      entry.configRev = record.config_rev
    } else {
      const saved = await api.saveProfile(entry.teamId, { config: { ...withoutDeletedAt(record.config), deletedAt: new Date().toISOString() } })
      entry.configRev = saved.config_rev
      this.logger?.info('窗口已在账号里删除（各电脑进回收站）', { teamId: entry.teamId })
    }
    entry.cloud = 'deleted'
  }

  /** A window deleted on another computer: this computer's copy goes to the recycle bin. */
  private async moveToRecycleBin(localId: string, record: RemoteProfile): Promise<void> {
    const link = this.file.links[localId]
    delete this.file.links[localId]
    ;(this.file.removed ??= {})[localId] = { ...link, configRev: record.config_rev, cloud: 'deleted' }
    await this.save()
    await this.profiles.remove(localId)
    await this.keepOneTrashCopy(record.id, localId)
    await this.save()
    this.logger?.info('窗口在其他电脑删除了，本机的移到回收站', { profileId: localId, teamId: record.id })
  }

  /**
   * A cloud window coming back to this computer: its recycle-bin copy here comes back (the same window,
   * its data and number) when there is one; its id when it did.
   */
  private async restoreFromTrash(teamId: string, record: RemoteProfile): Promise<string | undefined> {
    const removed = this.file.removed ?? {}
    const trash = await this.profiles.listTrash()
    for (const [profileId, entry] of Object.entries(removed)) {
      if (entry.teamId !== teamId) continue
      const trashed = trash.find((item) => item.profileId === profileId)
      if (!trashed) continue
      try {
        await this.profiles.restore(trashed.trashId)
      } catch (error) {
        this.logger?.error('从本机回收站恢复失败，改从云端拉', { profileId, error: error instanceof Error ? error.message : String(error) })
        continue
      }
      delete removed[profileId]
      this.file.links[profileId] = plainLink(entry)
      if (record.config_rev > entry.configRev && this.isClosed(profileId)) await this.applyCloudConfig(profileId, record)
      this.logger?.info('云端窗口回到本机：用的是本机回收站里的那一份', { profileId, teamId })
      return profileId
    }
    return undefined
  }

  /** Takes the cloud config of a closed window changed elsewhere (as opening it would). */
  private async applyCloudConfig(localId: string, record: RemoteProfile): Promise<void> {
    const current = this.profiles.get(localId)
    const draft = configDraft(record.config, record.name)
    await this.profiles.update(localId, { ...draft, extensionIds: current.extensionIds })
    await this.applyCloudExtras(localId, record.config)
    const favorite = (record.config as { favorite?: unknown }).favorite
    if (typeof favorite === 'boolean' && favorite !== Boolean(this.profiles.get(localId).favorite)) await this.profiles.setFavorite(localId, favorite)
    this.file.links[localId].configRev = record.config_rev
  }

  /** Drops this computer's recycle-bin copy of a window (permanently deleted for the account). */
  private async purgeLocalTrash(profileId: string): Promise<void> {
    for (const item of (await this.profiles.listTrash()).filter((trashed) => trashed.profileId === profileId)) {
      await this.profiles.purgeTrash(item.trashId)
    }
  }

  /**
   * Windows permanently deleted from this recycle bin (by hand, emptied, or past the retention days):
   * deleted on this computer only. The cloud keeps them, marked deleted (deleting a cloud window for
   * good is only by hand, on the Team page), and this computer remembers them so they are not brought
   * back; restoring one (Team page, or on another computer) puts it here again from the cloud.
   * Members' assigned windows were deleted here only, so nothing is remembered for them.
   */
  async purged(profileIds: string[]): Promise<void> {
    const removed = this.file.removed ?? {}
    for (const profileId of profileIds) {
      const entry = removed[profileId]
      if (!entry) continue
      if (entry.cloud === 'local' || this.isReadOnly(entry)) {
        delete removed[profileId]
        continue
      }
      this.logger?.info('回收站里永久删除的窗口只删本机，云端保留', { profileId, teamId: entry.teamId })
    }
    await this.save()
  }

  /**
   * One recycle-bin copy per cloud window: the window just moved there (keep) stays, older copies of
   * the same cloud window are dropped from this computer (the cloud is not touched).
   */
  private async keepOneTrashCopy(teamId: string, keep: string): Promise<void> {
    const removed = this.file.removed ?? {}
    for (const [profileId, entry] of Object.entries(removed)) {
      if (profileId === keep || entry.teamId !== teamId) continue
      await this.purgeLocalTrash(profileId)
      delete removed[profileId]
      this.logger?.info('同一个云端窗口在回收站里只留最新的一份', { profileId, teamId })
    }
  }

  /** Older data: several recycle-bin copies of one cloud window, the newest stays (keepOneTrashCopy). */
  private async dropDuplicateTrash(): Promise<boolean> {
    const removed = this.file.removed ?? {}
    const byTeam = new Map<string, string[]>()
    for (const [profileId, entry] of Object.entries(removed)) byTeam.set(entry.teamId, [...(byTeam.get(entry.teamId) ?? []), profileId])
    const groups = [...byTeam.entries()].filter(([, ids]) => ids.length > 1)
    if (!groups.length) return false
    const trash = await this.profiles.listTrash()
    for (const [teamId, ids] of groups) {
      const newest = (id: string) => trash.filter((item) => item.profileId === id).reduce((at, item) => item.deletedAt > at ? item.deletedAt : at, '')
      const keep = [...ids].sort((a, b) => newest(b).localeCompare(newest(a)))[0]
      await this.keepOneTrashCopy(teamId, keep)
    }
    return true
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
   * Owner: deletes a cloud window for everyone, for good. This computer's copy goes to the recycle bin
   * too (it would otherwise go up again as a new window); other computers' copies go to theirs at their
   * next sync (sync: linked windows the account no longer has).
   */
  async unshare(teamId: string): Promise<void> {
    const api = await this.requireOwner()
    const localId = this.localIdOf(teamId)
    if (localId && !this.isClosed(localId)) throw new Error('请先关闭这个窗口')
    // Only a window already deleted in the window list (in the recycle bins) loses its cloud backup;
    // the server checks this too.
    if (!cloudDeletedAt((await api.getProfile(teamId)).config)) throw new Error(CLOUD_DELETE_NEEDS_TRASH)
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

  /**
   * Puts a cloud window on this computer: its recycle-bin copy here when there is one (restoreFromTrash),
   * else a new window whose login state comes down on first open.
   */
  async addToComputer(teamId: string, known?: RemoteProfile): Promise<string> {
    const existing = this.localIdOf(teamId)
    if (existing) return existing
    const record = known ?? await this.requireApi().getProfile(teamId)
    const fromTrash = await this.restoreFromTrash(teamId, record)
    if (fromTrash) {
      for (const [profileId, link] of Object.entries(this.file.removed ?? {})) {
        if (link.teamId === teamId) delete this.file.removed![profileId]
      }
      await this.save()
      this.onProfileAdded?.(fromTrash)
      return fromTrash
    }
    // The window keeps the number and creation time it has on the computer that made it, when free here.
    const created = await this.profiles.create(configDraft(record.config, record.name), configOrigin(record.config))
    await this.applyCloudExtras(created.id, record.config)
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
    if (this.enabled && this.file.localMode) return this.touch(id)
    if (!this.enabled || !link || !this.api || this.isReadOnly(link)) return
    const profile = this.profiles.get(id)
    try {
      const record = await this.api.saveProfile(link.teamId, {
        name: profile.name,
        note: profile.note,
        config: this.cloudConfig(profile)
      })
      link.configRev = record.config_rev
      await this.save()
    } catch (error) {
      this.logger?.error('云端窗口配置同步失败', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      throw new Error(`本机已保存，但同步到云端失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Several windows changed here at once (batch assign, a group or library proxy changed): each goes up. */
  async pushConfigs(ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
      await this.afterLocalEdit(id).catch((error) => {
        this.logger?.error('窗口配置没有同步到云端', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      })
    }
  }

  /** Windows assigned to a member are used as they are; changing or copying them out is the owner's call. */
  assertEditable(id: string): void {
    // Team off: every window is this computer's own.
    if (!this.enabled) return
    const link = this.file.links[id]
    if (link && this.isReadOnly(link)) throw new Error('这是分配给你的窗口，只有主账号可以修改或导出')
  }

  // ---- open and close ------------------------------------------------------------------

  /** Before a linked window starts: take the lock, then bring config and login state up to date. */
  /**
   * Before a window opens: the lock and the latest config now; the latest login state comes down
   * meanwhile (loginState), so the launcher checks the proxy at the same time and waits for it only
   * before the browser starts.
   */
  async beforeLaunch(id: string): Promise<void | { loginState: Promise<void> }> {
    if (!this.enabled) return
    if (this.file.localMode) return this.touch(id)
    await this.verifySession()
    const link = this.file.links[id]
    if (!link) return
    const pending = this.pushes.get(id)
    if (pending) await pending
    const api = this.requireApi()
    const here = await this.lockDevice()
    await api.lock(link.teamId, here.name, here.id)
    this.locked.add(id)
    const failed = async (error: unknown): Promise<never> => {
      this.onSync({ profileId: id, phase: 'error', message: error instanceof Error ? error.message : String(error) })
      await this.release(id)
      throw error
    }
    let record: RemoteProfile
    try {
      try {
        record = await api.getProfile(link.teamId)
      } catch (error) {
        if (error instanceof TeamApiError && error.status === 404) throw new Error('这个团队窗口已被收回或删除')
        throw error
      }
      if (cloudDeletedAt(record.config)) {
        this.scheduleSync()
        throw new Error('这个窗口已在其他电脑删除（在回收站里，可以恢复）')
      }
      if (link.pendingUpload && record.data_rev === link.dataRev) {
        // Last close could not upload and nobody has changed it since.
        await this.upload(id, link)
        record = await api.getProfile(link.teamId)
      } else if (link.pendingUpload) {
        this.logger?.error('上次未上传的登录态已被更新的版本取代', { profileId: id, local: link.dataRev, remote: record.data_rev })
        link.pendingUpload = false
      }
      if (record.config_rev > link.configRev) {
        const current = this.profiles.get(id)
        const draft = configDraft(record.config, record.name)
        await this.profiles.update(id, { ...draft, extensionIds: current.extensionIds })
        await this.applyCloudExtras(id, record.config)
        link.configRev = record.config_rev
      }
    } catch (error) {
      return failed(error)
    }
    // Every computer opens the latest login state (whoever closed the window last). 0.5.55–0.5.57 kept
    // a copy per computer and could open this computer's own older copy (deviceRev set): then the
    // latest from another computer is brought once even at the same revision.
    const latest = record
    const loginState = (async () => {
      const ownCopyHere = link.deviceRev !== undefined && Boolean(latest.data_device) && latest.data_device !== this.device.id
      if ((latest.data_rev > link.dataRev || ownCopyHere) && latest.data) {
        this.logger?.info('[登录态] 打开窗口：拉云端最新的登录状态', { profileId: id, rev: latest.data_rev, localRev: link.dataRev, from: latest.data_device_name || undefined, uploadedAt: latest.updated })
        await this.pullState(id, latest)
        link.dataRev = latest.data_rev
      } else {
        this.logger?.info('[登录态] 打开窗口：本机已是云端最新，不用下载', { profileId: id, rev: latest.data_rev })
      }
      link.deviceRev = undefined
      await this.save()
      this.startHeartbeat(id, link.teamId)
    })().catch(failed)
    return { loginState }
  }

  /**
   * 测试模式 on: closing keeps the login state here. Off: this computer's login state goes up
   * first (as the latest and as this computer's copy); the mode stays on if that fails.
   */
  async setTestMode(id: string, on: boolean): Promise<BrowserProfile> {
    if (!on && this.profiles.get(id).testMode) {
      if (!this.isClosed(id)) throw new Error('请先关闭这个窗口')
      await this.pushLoginState(id, { evenInTestMode: true })
    }
    return this.profiles.setTestMode(id, on)
  }

  /** Downloads a login state (the window's latest, or a computer's copy) into this window. */
  private async pullState(id: string, source: RemoteProfile): Promise<void> {
    const api = this.requireApi()
    this.onSync({ profileId: id, phase: 'pulling' })
    await mkdir(this.workPath, { recursive: true })
    const archive = join(this.workPath, `${id}-pull-${Date.now()}.tgz`)
    const extensionsFolder = join(this.workPath, `${id}-extensions-${Date.now()}`)
    try {
      await api.downloadData(source, archive)
      const expected = (source as { data_sha256?: string }).data_sha256
      if (expected && await sha256File(archive) !== expected) throw new Error('下载的登录态校验失败，请重试')
      const userData = this.profiles.profileDataPath(id)
      const { cookies, records, extensions } = await unpackProfileState(archive, userData, this.passwordTransfer(id), this.extensions ? extensionsFolder : undefined)
      await this.cookies.importCookies(id, cookies, { replace: true })
      await applyCheckRecords(this.profiles, this.fingerprintChecks, id, records).catch((error) => {
        this.logger?.error('团队窗口的检测记录没有放好', { profileId: id, error: error instanceof Error ? error.message : String(error) })
      })
      if (this.extensions && extensions?.length) {
        const extensionIds = await adoptWindowExtensions(this.extensions, extensionsFolder, extensions, userData)
        await this.profiles.setExtensionIds(id, extensionIds)
      }
      this.logger?.info('[登录态] 已拉取并放进窗口', { profileId: id, rev: source.data_rev, cookies: cookies.length, extensions: extensions?.length ?? 0 })
    } finally {
      await rm(archive, { force: true })
      await rm(extensionsFolder, { recursive: true, force: true })
    }
    this.onSync({ profileId: id, phase: 'done' })
  }

  /** This computer: its fixed id (made on first use) and its name. */
  private get device(): UploadDevice {
    if (!this.file.deviceId) this.file.deviceId = randomUUID()
    return { id: this.file.deviceId, name: hostname() }
  }

  /** This computer for a lock: its id is saved first, so a restart still counts as the same computer. */
  private async lockDevice(): Promise<UploadDevice> {
    const fresh = !this.file.deviceId
    const device = this.device
    if (fresh) await this.save()
    return device
  }

  /** The launch failed after beforeLaunch: give the lock back without uploading. */
  async launchFailed(id: string): Promise<void> {
    if (!this.online) return
    // A browser that started and died uploads through afterExit, which releases by itself.
    if (this.file.links[id] && !this.pushes.has(id)) await this.release(id)
  }

  /**
   * Cookies changed in the editor of a closed window: its login state goes up now, the way a close
   * would send it (taking the lock while it does). Not linked: nothing to do.
   */
  async pushLoginState(id: string, options: { evenInTestMode?: boolean } = {}): Promise<void> {
    const link = this.file.links[id]
    // 测试模式: the login state stays on this computer until the mode is turned off.
    if (this.profiles.get(id).testMode && !options.evenInTestMode) return
    if (this.enabled && this.file.localMode) return this.touch(id)
    if (!this.enabled || !link || !this.api) return
    const pending = this.pushes.get(id)
    if (pending) await pending
    const here = await this.lockDevice()
    await this.api.lock(link.teamId, here.name, here.id)
    this.locked.add(id)
    try {
      await this.upload(id, link)
      this.onSync({ profileId: id, phase: 'done' })
    } finally {
      await this.release(id)
    }
  }

  /** After a linked window exits: upload its login state, then give the lock back. */
  afterExit(id: string): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    const testMode = this.profiles.get(id).testMode === true
    if (this.file.localMode) return testMode ? Promise.resolve() : this.touch(id)
    const link = this.file.links[id]
    // A window that was not in the cloud yet (opened before it went up) goes up now.
    if (!link) this.scheduleSync()
    if (!link || !this.locked.has(id)) return Promise.resolve()
    this.stopHeartbeat(id)
    const push = (async () => {
      if (testMode) {
        // 测试模式: closing keeps the login state on this computer only.
        this.logger?.info('[登录态] 关闭窗口：测试模式，只留在本机，没有上传', { profileId: id })
        await this.release(id)
        return
      }
      try {
        await this.upload(id, link)
        this.onSync({ profileId: id, phase: 'done' })
      } catch (error) {
        link.pendingUpload = true
        await this.save().catch(() => undefined)
        const message = error instanceof Error ? error.message : String(error)
        this.logger?.error('[登录态] 关闭窗口：上传失败，下次打开时重试', { profileId: id, error: message })
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
      // The config goes up too (an API window may be on a new proxy now), when this account may change
      // it and nobody changed it in the cloud since this computer took it: a newer one is never replaced.
      const config = await this.configToPush(id, link)
      const record = await api.saveProfile(link.teamId, config ? { config } : {}, { ...packed, rev: link.dataRev + 1, device: this.device })
      link.dataRev = record.data_rev
      if (config) link.configRev = record.config_rev
      link.pendingUpload = false
      await this.save()
      this.logger?.info('[登录态] 已上传，覆盖云端那一份', { profileId: id, rev: record.data_rev, bytes: packed.size })
    } finally {
      await rm(packed.file, { force: true })
    }
  }

  private async release(id: string): Promise<void> {
    this.stopHeartbeat(id)
    const link = this.file.links[id]
    if (!this.locked.delete(id) || !link || !this.api) return
    await this.api.unlock(link.teamId, false, this.device.id).catch((error) => {
      this.logger?.error('释放团队窗口占用失败', { profileId: id, error: error instanceof Error ? error.message : String(error) })
    })
  }

  private startHeartbeat(id: string, teamId: string): void {
    this.stopHeartbeat(id)
    this.heartbeats.set(id, setInterval(() => {
      void this.api?.heartbeat(teamId, this.device.id).catch((error) => {
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

  /** Waits for uploads and the sync after signing in still running (app quit). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pushes.values(), this.settling])
  }

  /** The sync after signing in or reconnecting (afterOnline), for flush(). */
  private settling: Promise<void> = Promise.resolve()

  /**
   * A window was deleted here: deleted for the account (every computer moves it to its recycle bin;
   * the cloud keeps it, marked deleted, so any computer can restore it). Without the server it is
   * marked at the next sync.
   */
  async forget(id: string): Promise<void> {
    const link = this.file.links[id]
    if (!link) return
    const entry: RemovedLink = { ...link, cloud: 'pending' }
    ;(this.file.removed ??= {})[id] = entry
    delete this.file.links[id]
    await this.keepOneTrashCopy(link.teamId, id)
    await this.save()
    if (!this.online || !this.api) return
    try {
      await this.markCloudDeleted(entry)
    } catch (error) {
      // 404: gone from the cloud already; anything else: tried again at the next sync.
      if (error instanceof TeamApiError && error.status === 404) delete this.file.removed![id]
      else this.logger?.error('窗口没能在账号里删除，下次同步再试', { profileId: id, error: error instanceof Error ? error.message : String(error) })
    }
    await this.save()
  }

  /**
   * Puts a cloud window on this computer (from the Team page). One deleted for the account is restored
   * for it: this computer's recycle-bin copy comes back when it has one, every other computer gets it too.
   */
  async restoreToComputer(teamId: string): Promise<string> {
    const api = this.requireApi()
    let record = await api.getProfile(teamId)
    if (cloudDeletedAt(record.config)) {
      const owner = this.file.role === 'owner' || record.owner === this.file.userId
      if (!owner) throw new Error('这个窗口已被删除，只有主账号可以恢复')
      record = await api.saveProfile(teamId, { config: withoutDeletedAt(record.config) })
    }
    return this.addToComputer(teamId, record)
  }

}
