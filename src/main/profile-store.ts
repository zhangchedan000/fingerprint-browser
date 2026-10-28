import { isKernelId } from '../shared/kernel-id'
import { suffixedProfileName } from '../shared/profile-name'
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ApiIpRecord, BrowserProfile, DeletedProfileSummary, GroupDraft, GroupRecord, ProfileBatchClassification, ProfileDraft, ProfileStoreHealth,
  FingerprintConfig, ProxyCheckSummary, ProxyConfig, ProxyDraft, ProxyRecord, TunnelRoute, WebRtcPolicy, WindowApiProxy
} from '../shared/types'
import { defaultProfileWindow, seedFromId } from '../shared/defaults'
import { nextGroupColor } from '../shared/group-colors'
import { effectiveGpu, refreshSeededGpuIdentity } from '../shared/hardware-profiles'
import { savedFingerprint } from '../shared/network-identity'
import { EMPTY_ACCOUNT, validateGroupName, validatePlatformAccount, validateProfileDraft, validateProxyConfig, validateProxyDraft, validProxyApiUrl, validTunnelRoute } from '../shared/validation'
import { identitySecretCodec, type SecretCodec } from './secret-codec'
import { privateAccount, privateProxyConfig, sameAccountIdentity, sameProxyIdentity } from './profile-secrets'
import { safePathSize } from './profile-data'
import { portableDraft } from './profile-portable'
import { nextProxyCheck, safeProxyCheck } from './proxy-check'
import { WorkspaceLibrary } from './workspace-library'

/**
 * What is written for a window. It holds references (proxyId, groupId), never the proxy or
 * group itself; ProfileStore fills those in when a window is read (see resolve()).
 */
type StoredProfile = Omit<BrowserProfile, 'group' | 'proxy' | 'proxyCheck' | 'proxyMissing'> & {
  /** Network check of a direct-connection window. Library proxies keep their own check. */
  directCheck?: ProxyCheckSummary
}

const SCHEMA_VERSION = 12

/** What assignMany can point windows at. '' = direct connection / ungrouped. */
export interface AssignPatch {
  proxyId?: string
  groupId?: string
  /** With a proxy: let time zone, language and location follow its exit IP. */
  followProxyIdentity?: boolean
  /** Add an extension to (or with removeExtension, take it off) the windows' extension list. */
  extensionId?: string
  removeExtension?: boolean
}

interface StoreFile {
  schemaVersion: number
  nextSerialNumber?: number
  profiles: unknown[]
  proxies?: unknown[]
  groups?: unknown[]
}

interface LoadedStore {
  profiles: StoredProfile[]
  library: WorkspaceLibrary
  nextSerialNumber: number
  schemaVersion: number
}

interface DeletedProfileRecord {
  schemaVersion: 1
  deletedAt: string
  /** The window as it was (proxy and group by value, plus their ids), so it can be restored on its own. */
  profile: BrowserProfile
}

interface ProfileOwnerMarker {
  schemaVersion: 1
  profileId: string
}

const PROFILE_OWNER_FILE = 'profile-owner.json'
const MAX_PROFILE_SERIAL = 999_999_999
const DIRECT: ProxyConfig = { protocol: 'direct', host: '', username: '', password: '' }

function validProfileSerial(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_PROFILE_SERIAL
}

function safeWebRtcPolicy(value: unknown): WebRtcPolicy {
  if (value === 'public_only') return 'default'
  return value === 'proxy_only' || value === 'privacy' || value === 'default' || value === 'disabled' ? value : 'proxy_only'
}

/** A saved 网络加速 setting, or none when it is unreadable (the window then keeps the old rule). */
function safeTunnelRoute(value: unknown): TunnelRoute | undefined {
  if (value === undefined) return undefined
  try {
    return validTunnelRoute(value)
  } catch {
    return undefined
  }
}

const API_HISTORY_LIMIT = 50

/** A saved API 提取 of a window, or none when it is unreadable. */
function safeApiProxy(value: unknown): WindowApiProxy | undefined {
  const api = value as Partial<WindowApiProxy> | undefined
  if (!api || typeof api !== 'object' || typeof api.url !== 'string') return undefined
  let url: string
  try { url = validProxyApiUrl(api.url) } catch { return undefined }
  const endpoint = api.endpoint && typeof api.endpoint === 'object'
    && (api.endpoint.protocol === 'http' || api.endpoint.protocol === 'socks5')
    && typeof api.endpoint.host === 'string' && Number.isInteger(api.endpoint.port)
    ? {
        protocol: api.endpoint.protocol,
        host: api.endpoint.host,
        port: api.endpoint.port,
        username: typeof api.endpoint.username === 'string' ? api.endpoint.username : '',
        ...(typeof api.endpoint.fetchedAt === 'string' ? { fetchedAt: api.endpoint.fetchedAt } : {})
      }
    : undefined
  const history = Array.isArray(api.history)
    ? api.history.filter((entry): entry is ApiIpRecord => Boolean(entry) && typeof entry.ip === 'string' && typeof entry.at === 'string').slice(0, API_HISTORY_LIMIT)
    : []
  return { url, ...(endpoint ? { endpoint } : {}), ...(history.length ? { history } : {}) }
}

/** The proxy as a window uses it: the window's own 网络加速, never the library proxy's default. */
function withWindowRoute(config: ProxyConfig, tunnel: TunnelRoute | undefined): ProxyConfig {
  const { tunnel: _default, ...rest } = config
  return tunnel ? { ...rest, tunnel } : rest
}

function validRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value)
}

function isEditable(profile: Pick<BrowserProfile, 'status'>): boolean {
  return profile.status === 'closed' || profile.status === 'error'
}

/** Drops the fields a window does not store and keeps the ones it does. */
function storedFields(profile: BrowserProfile | StoredProfile): StoredProfile {
  const { group: _group, proxy: _proxy, proxyCheck: _check, proxyMissing: _missing, ...stored } = profile as BrowserProfile
  return stored as StoredProfile
}

export class ProfileStore {
  readonly vaultPath: string
  readonly profilesPath: string
  readonly backupPath: string
  readonly previousBackupPath: string
  private profiles = new Map<string, StoredProfile>()
  /** Passwords of the proxies API links gave this session (not written to disk; the next launch fetches anew). */
  private apiPasswords = new Map<string, string>()
  private library = new WorkspaceLibrary()
  private nextSerialNumber = 1
  private writeQueue: Promise<void> = Promise.resolve()
  private health: ProfileStoreHealth = { recoveredFromBackup: false, backupHealthy: true }
  private preservePreviousBackupOnce = false
  private changeListeners = new Set<(profiles: BrowserProfile[]) => void>()

  /** The kernel a new window is pinned to when it names none (the default kernel at creation). */
  private defaultKernel?: () => Promise<string | undefined>

  constructor(vaultPath: string, private readonly secrets: SecretCodec = identitySecretCodec) {
    this.vaultPath = vaultPath
    this.profilesPath = join(vaultPath, 'profiles.json')
    this.backupPath = join(vaultPath, 'profiles.json.backup')
    this.previousBackupPath = join(vaultPath, 'profiles.json.backup.previous')
  }

  async initialize(): Promise<void> {
    await mkdir(this.vaultPath, { recursive: true })
    let loaded: LoadedStore | undefined
    let primaryError: unknown
    try {
      loaded = await this.readStore(this.profilesPath)
    } catch (error) {
      primaryError = error
    }

    if (!loaded) {
      const recoveryErrors: unknown[] = []
      let recoveredPath: string | undefined
      for (const candidate of [this.backupPath, this.previousBackupPath]) {
        try {
          loaded = await this.readStore(candidate)
          recoveredPath = candidate
          break
        } catch (error) {
          recoveryErrors.push(error)
        }
      }
      const firstRun = (primaryError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
        && recoveryErrors.length === 2
        && recoveryErrors.every((error) => (error as NodeJS.ErrnoException).code === 'ENOENT')
      if (!loaded && !firstRun) {
        throw new Error(`环境元数据及备份均无法读取：${primaryError instanceof Error ? primaryError.message : String(primaryError)}`)
      }
      if (loaded && recoveredPath) {
        this.preservePreviousBackupOnce = true
        let corruptFilePath: string | undefined
        if ((primaryError as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
          corruptFilePath = join(this.vaultPath, `profiles.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
          await rename(this.profilesPath, corruptFilePath)
        }
        this.health = {
          recoveredFromBackup: true,
          recoveryMessage: `主环境配置不可用，已从${recoveredPath === this.backupPath ? '最近备份' : '上一份备份'}恢复`,
          corruptFilePath,
          backupHealthy: true
        }
      }
    }

    // Keep an untouched copy of the file from before the proxy/group libraries existed.
    if (loaded && loaded.schemaVersion < SCHEMA_VERSION && !primaryError) {
      const copy = join(this.vaultPath, `profiles.v${loaded.schemaVersion}.before-upgrade.json`)
      await copyFile(this.profilesPath, copy).catch(() => undefined)
    }

    this.profiles.clear()
    this.library = loaded?.library ?? new WorkspaceLibrary()
    this.nextSerialNumber = loaded?.nextSerialNumber ?? 1
    for (const profile of loaded?.profiles ?? []) {
      this.profiles.set(profile.id, profile)
      await this.ensureProfileDirectories(profile.id)
    }
    this.moveApiProxiesIntoWindows()
    this.fixSavedFingerprints()
    await this.persist()
  }

  /**
   * Windows saved before every value was written in: one that still followed its IP keeps the values
   * of its last check, and the languages that followed are written in (savedFingerprint).
   */
  private fixSavedFingerprints(): void {
    this.rewrittenOnLoad.clear()
    for (const [id, stored] of this.profiles) {
      const fingerprint = savedFingerprint(stored.fingerprint, this.resolve(stored).proxyCheck, {
        gpuModel: effectiveGpu(stored.fingerprint, stored.kernelVersion)?.model,
        legacy: true
      })
      if (JSON.stringify(fingerprint) !== JSON.stringify(stored.fingerprint)) {
        this.profiles.set(id, { ...stored, fingerprint })
        this.rewrittenOnLoad.add(id)
      }
    }
  }

  private readonly rewrittenOnLoad = new Set<string>()

  /** Windows whose values were written in when this version first opened them (their cloud copy is updated once). */
  takeRewrittenOnLoad(): string[] {
    const ids = [...this.rewrittenOnLoad]
    this.rewrittenOnLoad.clear()
    return ids
  }

  /**
   * An API window's proxy as another computer left it (cloud): the same proxy and IP history, so
   * it opens on the same IP. Only for the same link.
   */
  async restoreApiState(id: string, input: unknown): Promise<BrowserProfile> {
    const current = this.stored(id)
    const state = input as { url?: unknown; endpoint?: { password?: unknown }; history?: unknown; check?: unknown } | undefined
    const api = safeApiProxy({ url: current.apiProxy?.url, endpoint: state?.endpoint, history: state?.history })
    if (!current.apiProxy || !api) return this.resolve(current)
    const check = safeProxyCheck(state?.check)
    const password = typeof state?.endpoint?.password === 'string' ? state.endpoint.password : ''
    if (api.endpoint && password) this.apiPasswords.set(id, password)
    else if (api.endpoint) this.apiPasswords.delete(id)
    const profile: StoredProfile = { ...current, apiProxy: { ...current.apiProxy, ...api } }
    if (check) profile.directCheck = check
    this.profiles.set(id, profile)
    await this.persist()
    return this.resolve(profile)
  }

  storageHealth(): ProfileStoreHealth {
    return { ...this.health }
  }

  /** Called with the windows whose shown proxy or group changed because a library record changed. */
  onProfilesChanged(listener: (profiles: BrowserProfile[]) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  private notify(profileIds: string[]): void {
    if (!profileIds.length || !this.changeListeners.size) return
    const changed = profileIds.filter((id) => this.profiles.has(id)).map((id) => this.get(id))
    for (const listener of this.changeListeners) listener(changed)
  }

  private async readStore(path: string): Promise<LoadedStore> {
    const raw = await readFile(path, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('环境元数据不是有效 JSON')
    }
    if (!value || typeof value !== 'object') throw new Error('环境元数据结构无效')
    const data = value as Partial<StoreFile>
    const schemaVersion = Number(data.schemaVersion)
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > SCHEMA_VERSION || !Array.isArray(data.profiles)) {
      throw new Error('环境元数据版本或列表结构无效')
    }
    const library = schemaVersion >= 12 ? this.readLibrary(data) : new WorkspaceLibrary()
    const now = new Date().toISOString()
    const result: StoredProfile[] = []
    const ids = new Set<string>()
    for (const value of data.profiles) {
      const stored = value as Partial<BrowserProfile> & Partial<StoredProfile>
      if (!validRecordId(stored.id) || ids.has(stored.id)) {
        throw new Error('环境元数据包含无效或重复 ID')
      }
      if (!stored.fingerprint || !Array.isArray(stored.startUrls)) {
        throw new Error(`环境 ${stored.id} 的配置不完整`)
      }
      if (typeof stored.createdAt !== 'string' || typeof stored.updatedAt !== 'string') {
        throw new Error(`环境 ${stored.id} 的持久化字段无效`)
      }
      // Up to version 11 the proxy and group were stored inside every window.
      const legacy = schemaVersion < 12
      if (legacy && (!stored.proxy || typeof stored.proxy.password !== 'string')) {
        throw new Error(`环境 ${stored.id} 的持久化字段无效`)
      }
      const proxyId = legacy ? '' : typeof stored.proxyId === 'string' ? stored.proxyId : ''
      const groupId = legacy ? '' : typeof stored.groupId === 'string' && library.groups.has(stored.groupId) ? stored.groupId : ''
      const draft = validateProfileDraft({
        name: stored.name as string,
        note: stored.note as string,
        group: legacy ? (typeof stored.group === 'string' ? stored.group : '') : library.groupName(groupId),
        tags: Array.isArray(stored.tags) ? stored.tags.filter((tag) => typeof tag === 'string') : [],
        extensionIds: Array.isArray(stored.extensionIds) ? stored.extensionIds.filter((id) => typeof id === 'string') : [],
        color: stored.color as string,
        startUrls: stored.startUrls,
        startupMode: stored.startupMode,
        kernelVersion: typeof stored.kernelVersion === 'string' ? stored.kernelVersion : '',
        window: stored.window ?? defaultProfileWindow(),
        tunnel: proxyId || stored.apiProxy ? safeTunnelRoute(stored.tunnel) : undefined,
        // A reference to a missing proxy is kept (and blocks launching); validate it as direct.
        proxy: legacy ? { ...stored.proxy!, password: this.secrets.decode(stored.proxy!.password) } : library.proxyConfig(proxyId) ?? DIRECT,
        account: stored.account && typeof stored.account === 'object'
          ? { ...stored.account, password: this.secrets.decode(typeof stored.account.password === 'string' ? stored.account.password : '') }
          : undefined,
        fingerprint: {
          ...stored.fingerprint,
          hardwareProfileId: stored.fingerprint.hardwareProfileId ?? 'legacy-custom',
          webrtcPolicy: safeWebRtcPolicy(stored.fingerprint.webrtcPolicy),
          networkIdentityMode: stored.fingerprint.networkIdentityMode ?? 'manual',
          proxyExitPolicy: stored.fingerprint.proxyExitPolicy ?? 'warn',
          disabledSpoofing: Array.isArray(stored.fingerprint.disabledSpoofing) ? stored.fingerprint.disabledSpoofing : []
        }
      })
      ids.add(stored.id)
      const legacyCheck = legacy ? safeProxyCheck(stored.proxyCheck) : undefined
      const resolvedProxyId = legacy ? library.ensureProxy(draft.proxy, now, legacyCheck) : proxyId
      const directCheck = legacy
        ? (resolvedProxyId ? undefined : legacyCheck)
        : (proxyId ? undefined : safeProxyCheck(stored.directCheck))
      const { proxy: _proxy, group, ...fields } = draft
      result.push({
        ...fields,
        account: privateAccount(draft.account),
        proxyId: resolvedProxyId,
        groupId: legacy ? library.ensureGroup(group, now) : groupId,
        id: stored.id,
        serialNumber: validProfileSerial(stored.serialNumber) ? stored.serialNumber : 0,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        lastOpenedAt: typeof stored.lastOpenedAt === 'string' ? stored.lastOpenedAt : undefined,
        ...(directCheck ? { directCheck } : {}),
        ...(!resolvedProxyId && safeApiProxy(stored.apiProxy) ? { apiProxy: safeApiProxy(stored.apiProxy) } : {}),
        ...this.loadApiPassword(stored),
        favorite: stored.favorite === true,
        status: 'closed',
        lastError: undefined
      })
    }
    const usedSerials = new Set<number>()
    const ordered = [...result].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    for (const profile of ordered) {
      if (validProfileSerial(profile.serialNumber) && !usedSerials.has(profile.serialNumber)) {
        usedSerials.add(profile.serialNumber)
      } else {
        profile.serialNumber = 0
      }
    }
    let migrationSerial = 1
    for (const profile of ordered) {
      if (validProfileSerial(profile.serialNumber)) continue
      while (usedSerials.has(migrationSerial)) migrationSerial += 1
      if (migrationSerial > MAX_PROFILE_SERIAL) throw new Error('环境编号空间已用尽')
      profile.serialNumber = migrationSerial
      usedSerials.add(migrationSerial)
    }
    let highestSerial = 0
    for (const serial of usedSerials) highestSerial = Math.max(highestSerial, serial)
    const storedNext = validProfileSerial(data.nextSerialNumber) ? data.nextSerialNumber : 1
    const nextSerialNumber = Math.max(storedNext, highestSerial + 1)
    if (nextSerialNumber > MAX_PROFILE_SERIAL) throw new Error('环境编号空间已用尽')
    return { profiles: result, library, nextSerialNumber, schemaVersion }
  }

  private readLibrary(data: Partial<StoreFile>): WorkspaceLibrary {
    if (!Array.isArray(data.proxies) || !Array.isArray(data.groups)) throw new Error('代理库或分组库结构无效')
    const proxies: ProxyRecord[] = []
    const proxyIds = new Set<string>()
    for (const value of data.proxies) {
      const stored = value as Partial<ProxyRecord>
      if (!validRecordId(stored.id) || proxyIds.has(stored.id) || typeof stored.password !== 'string'
        || typeof stored.createdAt !== 'string' || typeof stored.updatedAt !== 'string') {
        throw new Error('代理库包含无效记录')
      }
      const config = validateProxyConfig({
        protocol: stored.protocol as ProxyConfig['protocol'],
        host: stored.host as string,
        port: stored.port,
        username: stored.username as string,
        password: this.secrets.decode(stored.password)
      })
      if (config.protocol === 'direct') throw new Error('代理库包含无效记录')
      proxyIds.add(stored.id)
      const check = safeProxyCheck(stored.check)
      proxies.push({
        id: stored.id,
        protocol: config.protocol,
        host: config.host,
        port: config.port!,
        username: config.username,
        password: config.password,
        note: typeof stored.note === 'string' ? stored.note.slice(0, 200) : '',
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        ...(check ? { check } : {}),
        ...(typeof stored.apiUrl === 'string' && stored.apiUrl ? { apiUrl: validProxyApiUrl(stored.apiUrl) } : {}),
        ...(safeTunnelRoute(stored.tunnel) ? { tunnel: safeTunnelRoute(stored.tunnel) } : {})
      })
    }
    const groups: GroupRecord[] = []
    const groupIds = new Set<string>()
    for (const value of data.groups) {
      const stored = value as Partial<GroupRecord>
      if (!validRecordId(stored.id) || groupIds.has(stored.id) || typeof stored.createdAt !== 'string') {
        throw new Error('分组库包含无效记录')
      }
      groupIds.add(stored.id)
      groups.push({
        id: stored.id,
        name: validateGroupName(stored.name),
        color: typeof stored.color === 'string' && /^#[\da-f]{6}$/i.test(stored.color) ? stored.color : nextGroupColor(groups.length),
        note: typeof stored.note === 'string' ? stored.note.slice(0, 200) : '',
        createdAt: stored.createdAt
      })
    }
    return new WorkspaceLibrary(proxies, groups)
  }

  /** A window as everything else sees it: references filled in from the libraries. */
  private resolve(stored: StoredProfile): BrowserProfile {
    const { directCheck, ...fields } = stored
    const record = stored.proxyId ? this.library.proxies.get(stored.proxyId) : undefined
    const config = stored.proxyId ? this.library.proxyConfig(stored.proxyId) : stored.apiProxy ? this.apiProxyConfig(stored) : undefined
    const profile: BrowserProfile = {
      ...fields,
      group: this.library.groupName(stored.groupId),
      proxy: config ? withWindowRoute(config, stored.tunnel) : { ...DIRECT },
      proxyCheck: stored.proxyId ? record?.check : directCheck
    }
    if (stored.proxyId && !record) profile.proxyMissing = true
    if (!profile.proxyCheck) delete profile.proxyCheck
    return profile
  }

  /** A window's API 提取 as a proxy: the link, and the last proxy it gave (nothing yet: an empty host). */
  private apiProxyConfig(stored: StoredProfile): ProxyConfig {
    const { url, endpoint } = stored.apiProxy!
    return {
      protocol: endpoint?.protocol ?? 'http',
      host: endpoint?.host ?? '',
      ...(endpoint ? { port: endpoint.port } : {}),
      username: endpoint?.username ?? '',
      password: this.apiPasswords.get(stored.id) ?? '',
      apiUrl: url
    }
  }

  /** Gives windows an API link (API 提取) instead of their proxy; the same link keeps a window's history. */
  async setApiUrlMany(idsInput: string[], urlInput: unknown): Promise<BrowserProfile[]> {
    const url = validProxyApiUrl(typeof urlInput === 'string' ? urlInput : '')
    const ids = this.selection(idsInput)
    const running = ids.map((id) => this.stored(id)).find((profile) => !isEditable(profile))
    if (running) throw new Error(`环境“${running.name}”正在运行，请先关闭再更换代理`)
    const now = new Date().toISOString()
    for (const id of ids) {
      const current = this.stored(id)
      const same = current.apiProxy?.url === url
      const profile: StoredProfile = { ...current, proxyId: '', apiProxy: same ? current.apiProxy! : { url }, updatedAt: now }
      if (!same) delete profile.directCheck
      this.profiles.set(id, profile)
    }
    await this.persist()
    return ids.map((id) => this.get(id))
  }

  /** The proxy password of an API window, read from the file into memory (it never reaches the window list). */
  private loadApiPassword(stored: { id?: unknown; apiProxy?: unknown }): Record<string, never> {
    const password = (stored.apiProxy as { endpoint?: { password?: unknown } } | undefined)?.endpoint?.password
    if (typeof stored.id === 'string' && typeof password === 'string' && password) this.apiPasswords.set(stored.id, this.secrets.decode(password))
    return {}
  }

  /** A new proxy from a window's API link: used from now on, while it works. */
  async setWindowApiEndpoint(id: string, endpoint: { protocol: 'http' | 'socks5'; host: string; port: number; username: string; password: string }): Promise<BrowserProfile> {
    const current = this.stored(id)
    if (!current.apiProxy) throw new Error('这个窗口没有使用 API 提取')
    const { password, ...shown } = endpoint
    if (password) this.apiPasswords.set(id, password)
    else this.apiPasswords.delete(id)
    const profile: StoredProfile = { ...current, apiProxy: { ...current.apiProxy, endpoint: { ...shown, fetchedAt: new Date().toISOString() } } }
    this.profiles.set(id, profile)
    await this.persist()
    return this.resolve(profile)
  }

  /**
   * Windows that used an API proxy from the library (before 0.5.12) keep its link themselves; the
   * library entry, which only ever showed the last short-lived IP, is then removed.
   */
  private moveApiProxiesIntoWindows(): boolean {
    const apiRecords = this.library.listProxies().filter((record) => record.apiUrl)
    if (!apiRecords.length) return false
    for (const [id, stored] of this.profiles) {
      const record = apiRecords.find((item) => item.id === stored.proxyId)
      if (!record) continue
      const endpoint = record.host && record.port && (record.protocol === 'http' || record.protocol === 'socks5')
        ? { protocol: record.protocol, host: record.host, port: record.port, username: record.username }
        : undefined
      this.profiles.set(id, {
        ...stored,
        proxyId: '',
        apiProxy: { url: record.apiUrl!, ...(endpoint ? { endpoint } : {}) },
        ...(stored.tunnel || record.tunnel ? { tunnel: stored.tunnel ?? record.tunnel } : {}),
        ...(record.check ? { directCheck: record.check } : {})
      })
    }
    for (const record of apiRecords) this.library.deleteProxy(record.id)
    return true
  }

  private stored(id: string): StoredProfile {
    const profile = this.profiles.get(id)
    if (!profile) throw new Error('浏览器环境不存在')
    return profile
  }

  list(): BrowserProfile[] {
    return [...this.profiles.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((profile) => this.resolve(profile))
  }

  get(id: string): BrowserProfile {
    return this.resolve(this.stored(id))
  }

  /**
   * Which library proxy a draft refers to. A proxy picked from the library is used as is;
   * a typed proxy is looked up in the library and added when it is new. '' is direct.
   */
  private referenceProxy(input: ProfileDraft, proxy: ProxyConfig, now: string, currentProxyId = ''): string {
    if (proxy.apiUrl && !input.proxyId) return ''
    if (typeof input.proxyId === 'string' && input.proxyId) {
      if (!this.library.proxies.has(input.proxyId)) throw new Error('所选代理已不在代理库中，请重新选择')
      return input.proxyId
    }
    // An edit form that left a saved password empty still means the window's own proxy.
    const current = currentProxyId ? this.library.proxyConfig(currentProxyId) : undefined
    if (current && proxy.passwordStored && !proxy.password && sameProxyIdentity(proxy, current)) return currentProxyId
    return this.library.ensureProxy(proxy, now)
  }

  /**
   * A window's 网络加速: the one it was given, else (same proxy as before) the one it had, else the
   * default of the library proxy it now uses. A direct window has none.
   */
  private windowTunnel(draft: { tunnel?: TunnelRoute }, proxyId: string, current?: StoredProfile, api = false): TunnelRoute | undefined {
    if (api) return draft.tunnel ?? current?.tunnel
    if (!proxyId) return undefined
    if (draft.tunnel) return draft.tunnel
    if (current && current.proxyId === proxyId) return current.tunnel
    return this.library.proxies.get(proxyId)?.tunnel
  }

  /** Runs a change that may add library records; on failure the libraries are put back. */
  private async withLibraryRollback<T>(change: () => Promise<T>): Promise<T> {
    const snapshot = this.library.clone()
    try {
      return await change()
    } catch (error) {
      this.library = snapshot
      throw error
    }
  }

  setDefaultKernelResolver(resolver: () => Promise<string | undefined>): void {
    this.defaultKernel = resolver
  }

  /**
   * Pins every window that follows the default kernel to `kernelVersion` (the default now), so
   * a later change of the default only affects windows created after it. Returns how many changed.
   */
  async pinUnboundKernels(kernelVersion: string): Promise<number> {
    if (!isKernelId(kernelVersion)) throw new Error('内核版本号无效')
    // updatedAt stays: the list is sorted by it and nothing the user did changed.
    const next = [...this.profiles.values()]
      .filter((profile) => !profile.kernelVersion)
      .map((profile) => ({ ...profile, kernelVersion }))
    if (!next.length) return 0
    for (const profile of next) this.profiles.set(profile.id, profile)
    await this.persist()
    return next.length
  }

  async create(input: ProfileDraft): Promise<BrowserProfile> {
    return (await this.createMany([input]))[0]
  }

  async createMany(inputs: ProfileDraft[]): Promise<BrowserProfile[]> {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('没有可创建的浏览器环境')
    if (inputs.length > 1000) throw new Error('单次最多创建 1000 个浏览器环境')
    const drafts = inputs.map(validateProfileDraft)
    if (this.nextSerialNumber + drafts.length - 1 > MAX_PROFILE_SERIAL) throw new Error('环境编号空间已用尽')
    const defaultKernel = drafts.some((draft) => !draft.kernelVersion)
      ? await this.defaultKernel?.().catch(() => undefined)
      : undefined
    return this.withLibraryRollback(async () => {
      const now = new Date().toISOString()
      const created: StoredProfile[] = drafts.map((draft, index) => {
        const id = randomUUID()
        const { proxy, group, tunnel, ...fields } = draft
        const proxyId = this.referenceProxy(inputs[index], tunnel ? { ...proxy, tunnel } : proxy, now)
        const api = !proxyId && proxy.apiUrl ? { url: proxy.apiUrl } : undefined
        const route = this.windowTunnel(draft, proxyId, undefined, Boolean(api))
        return {
          ...fields,
          ...(route ? { tunnel: route } : {}),
          ...(api ? { apiProxy: api } : {}),
          kernelVersion: fields.kernelVersion || defaultKernel || '',
          id,
          serialNumber: this.nextSerialNumber + index,
          proxyId,
          groupId: this.library.ensureGroup(group, now),
          account: privateAccount(draft.account),
          // A saved window keeps its values: nothing follows an IP or a table from here on.
          fingerprint: savedFingerprint({
            ...draft.fingerprint,
            seed: Number.isInteger(draft.fingerprint.seed) ? draft.fingerprint.seed : seedFromId(id)
          }, undefined, { gpuModel: effectiveGpu(draft.fingerprint, fields.kernelVersion || defaultKernel)?.model }),
          createdAt: now,
          updatedAt: now,
          favorite: false,
          status: 'closed' as const
        }
      })
      try {
        await Promise.all(created.map((profile) => this.ensureProfileDirectories(profile.id)))
        for (const profile of created) this.profiles.set(profile.id, profile)
        this.nextSerialNumber += created.length
        await this.persist()
        return created.map((profile) => this.resolve(profile))
      } catch (error) {
        for (const profile of created) this.profiles.delete(profile.id)
        await Promise.allSettled(created.map((profile) => rm(join(this.vaultPath, 'profiles', profile.id), { recursive: true, force: true })))
        throw error
      }
    })
  }

  async update(id: string, input: ProfileDraft): Promise<BrowserProfile> {
    const current = this.stored(id)
    if (!isEditable(current)) {
      throw new Error('请先关闭浏览器环境再修改配置')
    }
    const draft = validateProfileDraft(input)
    // The kernel a window following the default runs, for the GPU its 自动 media devices go with (as the editor shows).
    const defaultKernel = draft.kernelVersion ? undefined : await this.defaultKernel?.().catch(() => undefined)
    const keepAccountPassword = !draft.account.password
      && draft.account.passwordStored === true
      && sameAccountIdentity(draft.account, current.account)
    return this.withLibraryRollback(async () => {
      const now = new Date().toISOString()
      const { proxy, group, tunnel, ...fields } = draft
      const proxyId = this.referenceProxy(input, tunnel ? { ...proxy, tunnel } : proxy, now, current.proxyId)
      const apiUrl = !proxyId ? proxy.apiUrl : undefined
      const route = this.windowTunnel(draft, proxyId, current, Boolean(apiUrl))
      const profile: StoredProfile = {
        ...current,
        ...fields,
        fingerprint: savedFingerprint(fields.fingerprint, proxyId === current.proxyId ? this.resolve(current).proxyCheck : undefined, {
          gpuModel: effectiveGpu(fields.fingerprint, fields.kernelVersion || defaultKernel)?.model
        }),
        proxyId,
        groupId: this.library.ensureGroup(group, now),
        account: privateAccount({
          ...draft.account,
          password: keepAccountPassword ? current.account.password : draft.account.password
        }),
        id,
        createdAt: current.createdAt,
        updatedAt: now,
        status: current.status
      }
      if (proxyId || current.proxyId) delete profile.directCheck
      if (route) profile.tunnel = route
      else delete profile.tunnel
      // The same link keeps its last proxy and IP history; a new link starts afresh.
      if (apiUrl) profile.apiProxy = current.apiProxy?.url === apiUrl ? current.apiProxy : { url: apiUrl }
      else delete profile.apiProxy
      if (apiUrl && current.apiProxy?.url !== apiUrl) delete profile.directCheck
      this.profiles.set(id, profile)
      await this.persist()
      return this.resolve(profile)
    })
  }

  async duplicate(id: string): Promise<BrowserProfile> {
    const source = this.get(id)
    const seed = seedFromId(randomUUID())
    const draft = portableDraft(source, { passwords: 'keep', extensions: true })
    return this.create({
      ...draft,
      name: suffixedProfileName('{0} 副本', source.name),
      // Same library proxy, not a copy of it.
      proxyId: source.proxyMissing ? undefined : source.proxyId,
      fingerprint: refreshSeededGpuIdentity({ ...draft.fingerprint, seed })
    })
  }

  async classifyMany(idsInput: string[], patch: ProfileBatchClassification): Promise<BrowserProfile[]> {
    if (!Array.isArray(idsInput) || !patch || typeof patch !== 'object') throw new Error('批量修改参数无效')
    const ids = this.selection(idsInput)
    if (patch.group === undefined && !patch.addTags?.length) throw new Error('请填写分组或要追加的标签')
    if (patch.group !== undefined && typeof patch.group !== 'string') throw new Error('环境分组格式无效')
    if (patch.addTags !== undefined && (!Array.isArray(patch.addTags) || !patch.addTags.every((tag) => typeof tag === 'string'))) {
      throw new Error('环境标签格式无效')
    }
    return this.withLibraryRollback(async () => {
      const now = new Date().toISOString()
      const groupId = patch.group === undefined
        ? undefined
        : this.library.ensureGroup(patch.group.trim() ? validateGroupName(patch.group) : '', now)
      const next = ids.map((id) => {
        const current = this.stored(id)
        const { tags } = validateProfileDraft({
          ...portableDraft(this.get(id), { passwords: 'keep', extensions: true }),
          tags: [...current.tags, ...(patch.addTags ?? [])]
        })
        return { ...current, tags, groupId: groupId ?? current.groupId, updatedAt: now }
      })
      for (const profile of next) this.profiles.set(profile.id, profile)
      await this.persist()
      return next.map((profile) => this.resolve(profile))
    })
  }

  private selection(idsInput: string[]): string[] {
    if (!Array.isArray(idsInput)) throw new Error('批量修改参数无效')
    const ids = [...new Set(idsInput)]
    if (!ids.length) throw new Error('没有选择浏览器环境')
    if (ids.length > 1000) throw new Error('单次最多修改 1000 个浏览器环境')
    for (const id of ids) this.stored(id)
    return ids
  }

  /**
   * The one way windows are assigned to a library record: point proxyId / groupId at it.
   * '' means direct connection / ungrouped. Proxies change only on closed windows.
   */
  async assignMany(idsInput: string[], patch: AssignPatch): Promise<BrowserProfile[]> {
    if (!patch || typeof patch !== 'object') throw new Error('批量修改参数无效')
    const ids = this.selection(idsInput)
    const { proxyId, groupId, followProxyIdentity, extensionId, removeExtension } = patch
    if (proxyId === undefined && groupId === undefined && extensionId === undefined) throw new Error('请选择要分配的代理或分组')
    if (extensionId !== undefined && (typeof extensionId !== 'string' || !/^[a-f\d-]{36}$/i.test(extensionId))) throw new Error('环境扩展配置无效或超过 50 个')
    if (proxyId !== undefined) {
      if (typeof proxyId !== 'string' || (proxyId && !this.library.proxies.has(proxyId))) throw new Error('所选代理已不在代理库中，请重新选择')
      const running = ids.map((id) => this.stored(id)).find((profile) => !isEditable(profile) && profile.proxyId !== proxyId)
      if (running) throw new Error(`环境“${running.name}”正在运行，请先关闭再更换代理`)
    }
    if (groupId !== undefined && (typeof groupId !== 'string' || (groupId && !this.library.groups.has(groupId)))) {
      throw new Error('所选分组已不存在，请重新选择')
    }
    const now = new Date().toISOString()
    const next = ids.map((id) => {
      const current = this.stored(id)
      const profile: StoredProfile = { ...current, updatedAt: now }
      if (groupId !== undefined) profile.groupId = groupId
      if (proxyId !== undefined && (proxyId !== current.proxyId || current.apiProxy)) {
        profile.proxyId = proxyId
        delete profile.directCheck
        delete profile.apiProxy
        // A window given another proxy starts with that proxy's 网络加速 default.
        const route = this.windowTunnel({}, proxyId)
        if (route) profile.tunnel = route
        else delete profile.tunnel
      }
      if (extensionId !== undefined) {
        const others = current.extensionIds.filter((id) => id !== extensionId)
        profile.extensionIds = removeExtension === true ? others : [...others, extensionId]
        if (profile.extensionIds.length > 50) throw new Error('环境扩展配置无效或超过 50 个')
      }
      // Time zone, language and location follow the new proxy's exit IP at launch.
      if (proxyId && followProxyIdentity === true) profile.fingerprint = { ...profile.fingerprint, networkIdentityMode: 'proxy' }
      return profile
    })
    for (const profile of next) this.profiles.set(profile.id, profile)
    await this.persist()
    return next.map((profile) => this.resolve(profile))
  }

  /**
   * Pin (or unpin with '') the kernel of several windows at once.
   * Running windows keep their current process; the change applies on next launch.
   * A hand-set brand version is cleared so it follows the new kernel automatically.
   */
  async setKernelMany(idsInput: string[], kernelVersionInput: string): Promise<BrowserProfile[]> {
    if (!Array.isArray(idsInput) || typeof kernelVersionInput !== 'string') throw new Error('批量切换内核参数无效')
    const ids = this.selection(idsInput)
    const kernelVersion = kernelVersionInput.trim()
    if (kernelVersion && !isKernelId(kernelVersion)) {
      throw new Error('绑定的内核版本号无效')
    }
    const now = new Date().toISOString()
    const next = ids.map((id) => {
      const current = this.stored(id)
      if (current.kernelVersion === kernelVersion) return current
      return {
        ...current,
        kernelVersion,
        fingerprint: { ...current.fingerprint, brandVersion: '' },
        updatedAt: now
      }
    })
    for (const profile of next) this.profiles.set(profile.id, profile)
    await this.persist()
    return next.map((profile) => this.resolve(profile))
  }

  // ---- proxy library ---------------------------------------------------------------------

  listProxies(): ProxyRecord[] {
    return this.library.listProxies().map((proxy) => ({ ...proxy }))
  }

  getProxy(id: string): ProxyRecord {
    return { ...this.library.getProxy(id) }
  }

  /** Windows that use a library proxy. Derived from the windows; never stored on the proxy. */
  proxyUsers(proxyId: string): BrowserProfile[] {
    return this.list().filter((profile) => profile.proxyId === proxyId)
  }

  /**
   * Adds many proxies at once (pasted list or file). Proxies already in the library are
   * counted, not added again; a bad entry is reported and the rest still go in.
   */
  async createProxies(inputs: ProxyDraft[]): Promise<{ created: ProxyRecord[]; duplicates: number; errors: Array<{ index: number; message: string }> }> {
    if (!Array.isArray(inputs) || !inputs.length) throw new Error('没有可添加的代理')
    if (inputs.length > 5000) throw new Error('单次最多添加 5000 个代理')
    return this.withLibraryRollback(async () => {
      const now = new Date().toISOString()
      const created: ProxyRecord[] = []
      const errors: Array<{ index: number; message: string }> = []
      let duplicates = 0
      inputs.forEach((input, index) => {
        try {
          const draft = validateProxyDraft(input)
          if (this.library.findProxy(draft)) {
            duplicates += 1
            return
          }
          created.push({ ...this.library.addProxy(draft, now) })
        } catch (error) {
          errors.push({ index, message: error instanceof Error ? error.message : String(error) })
        }
      })
      if (created.length) await this.persist()
      return { created, duplicates, errors }
    })
  }

  async createProxy(input: ProxyDraft): Promise<ProxyRecord> {
    return this.withLibraryRollback(async () => {
      const record = this.library.addProxy(input, new Date().toISOString())
      await this.persist()
      return { ...record }
    })
  }

  /** Records the proxy an API proxy's extraction just gave (windows already running keep theirs). */
  async setApiProxyEndpoint(id: string, endpoint: Pick<ProxyRecord, 'protocol' | 'host' | 'port' | 'username' | 'password'>): Promise<ProxyRecord> {
    const record = this.library.setApiEndpoint(id, endpoint, new Date().toISOString())
    await this.persist()
    this.notify(this.proxyUsers(id).map((profile) => profile.id))
    return { ...record }
  }

  async updateProxy(id: string, input: ProxyDraft): Promise<ProxyRecord> {
    const users = this.proxyUsers(id)
    return this.withLibraryRollback(async () => {
      const before = this.library.getProxy(id)
      const record = this.library.updateProxy(id, input, new Date().toISOString())
      const connectionChanged = !sameProxyIdentity(before, record) || before.password !== record.password
      const running = users.find((profile) => !isEditable(profile))
      if (connectionChanged && running) throw new Error(`环境“${running.name}”正在使用这个代理，请先关闭再修改`)
      await this.persist()
      this.notify(users.map((profile) => profile.id))
      return { ...record }
    })
  }

  /**
   * Removes a library proxy. When windows use it, replaceWith must say what they use instead:
   * another library proxy's id, or '' for direct connection.
   */
  async removeProxy(id: string, replaceWith?: string): Promise<void> {
    this.library.getProxy(id)
    const users = this.proxyUsers(id)
    if (users.length) {
      if (replaceWith === undefined) throw new Error(`有 ${users.length} 个窗口正在使用这个代理，请先选择替换的代理`)
      if (replaceWith === id) throw new Error('不能用要删除的代理替换它自己')
      await this.assignMany(users.map((profile) => profile.id), { proxyId: replaceWith })
    }
    this.library.deleteProxy(id)
    await this.persist()
    this.notify(users.map((profile) => profile.id))
  }

  // ---- group library ---------------------------------------------------------------------

  listGroups(): GroupRecord[] {
    return this.library.listGroups().map((group) => ({ ...group }))
  }

  async createGroup(draft: GroupDraft): Promise<GroupRecord> {
    const record = this.library.addGroup(draft, new Date().toISOString())
    await this.persist()
    return { ...record }
  }

  async updateGroup(id: string, draft: GroupDraft): Promise<GroupRecord> {
    const record = this.library.updateGroup(id, draft)
    await this.persist()
    this.notify(this.list().filter((profile) => profile.groupId === id).map((profile) => profile.id))
    return { ...record }
  }

  /** Removes a group; its windows become ungrouped. */
  async removeGroup(id: string): Promise<void> {
    this.library.getGroup(id)
    const members = [...this.profiles.values()].filter((profile) => profile.groupId === id)
    for (const profile of members) this.profiles.set(profile.id, { ...profile, groupId: '' })
    this.library.deleteGroup(id)
    await this.persist()
    this.notify(members.map((profile) => profile.id))
  }

  // ---- removal and recycle bin -----------------------------------------------------------

  async removeMany(idsInput: string[]): Promise<void> {
    if (!Array.isArray(idsInput)) throw new Error('批量删除参数无效')
    const ids = [...new Set(idsInput)]
    if (!ids.length) throw new Error('没有选择浏览器环境')
    if (ids.length > 1000) throw new Error('单次最多删除 1000 个浏览器环境')
    for (const id of ids) {
      const profile = this.stored(id)
      if (!isEditable(profile)) throw new Error(`环境“${profile.name}”正在运行，不能删除`)
    }
    for (const id of ids) await this.remove(id)
  }

  async remove(id: string): Promise<void> {
    const profile = this.get(id)
    if (!isEditable(profile)) throw new Error('运行中的环境不能删除')
    await this.assertProfileDataIdentity(id)
    const source = join(this.vaultPath, 'profiles', id)
    const recycle = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(recycle, { recursive: true })
    const deletedAt = new Date().toISOString()
    const { proxyMissing: _missing, ...snapshot } = profile
    const record: DeletedProfileRecord = {
      schemaVersion: 1,
      deletedAt,
      profile: {
        ...snapshot,
        status: 'closed',
        lastError: undefined,
        proxy: { ...profile.proxy, password: this.secrets.encode(profile.proxy.password) },
        account: { ...profile.account, password: this.secrets.encode(profile.account.password) }
      }
    }
    const marker = join(source, 'deleted-profile.json')
    await writeFile(marker, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
    const trashId = `${id}-${Date.now()}`
    try {
      await rename(source, join(recycle, trashId))
    } catch (error) {
      await rm(marker, { force: true })
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.profiles.delete(id)
    await this.persist()
  }

  async listTrash(): Promise<DeletedProfileSummary[]> {
    const root = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(root, { recursive: true })
    const result: DeletedProfileSummary[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const record = JSON.parse(await readFile(join(root, entry.name, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
        if (record.schemaVersion !== 1 || !record.profile?.id || !record.profile.name) continue
        result.push({
          trashId: entry.name,
          profileId: record.profile.id,
          serialNumber: validProfileSerial(record.profile.serialNumber) ? record.profile.serialNumber : undefined,
          name: record.profile.name,
          group: typeof record.profile.group === 'string' ? record.profile.group : '',
          deletedAt: record.deletedAt,
          sizeBytes: await safePathSize(join(root, entry.name))
        })
      } catch {
        // Old or incomplete recycle entries remain recoverable on disk but are not shown as restorable profiles.
      }
    }
    return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  async usesExtension(id: string): Promise<boolean> {
    if (this.list().some((profile) => profile.extensionIds.includes(id))) return true
    const root = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(root, { recursive: true })
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const record = JSON.parse(await readFile(join(root, entry.name, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
        if (record.profile?.extensionIds?.includes(id)) return true
      } catch {
        // Ignore legacy recycle entries without restorable metadata.
      }
    }
    return false
  }

  async kernelUsers(version: string): Promise<string[]> {
    const names = this.list().filter((profile) => profile.kernelVersion === version).map((profile) => profile.name)
    const root = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(root, { recursive: true })
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const record = JSON.parse(await readFile(join(root, entry.name, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
        if (record.profile?.kernelVersion === version && typeof record.profile.name === 'string') names.push(record.profile.name)
      } catch {
        // Ignore legacy recycle entries without restorable metadata.
      }
    }
    return names
  }

  async purgeTrash(trashId: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(trashId)) throw new Error('回收站条目标识无效')
    const target = join(this.vaultPath, 'recycle-bin', 'profiles', trashId)
    let record: DeletedProfileRecord
    try {
      record = JSON.parse(await readFile(join(target, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
    } catch {
      throw new Error('回收站条目不完整，已取消永久删除')
    }
    if (record.schemaVersion !== 1 || !record.profile?.id) throw new Error('回收站条目元数据无效，已取消永久删除')
    await rm(target, { recursive: true, force: true })
  }

  async emptyTrash(): Promise<number> {
    const items = await this.listTrash()
    for (const item of items) await this.purgeTrash(item.trashId)
    return items.length
  }

  async purgeTrashOlderThan(days: number): Promise<number> {
    if (days === 0) return 0
    if (days !== 7 && days !== 30 && days !== 90) throw new Error('回收站保留天数无效')
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const root = join(this.vaultPath, 'recycle-bin', 'profiles')
    await mkdir(root, { recursive: true })
    const expired: string[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const record = JSON.parse(await readFile(join(root, entry.name, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
        if (record.schemaVersion === 1 && record.profile?.id && Date.parse(record.deletedAt) < cutoff) expired.push(entry.name)
      } catch {
        // Incomplete entries are deliberately preserved for manual inspection.
      }
    }
    for (const trashId of expired) await this.purgeTrash(trashId)
    return expired.length
  }

  /**
   * Restores a window from the recycle bin. Its proxy is looked up again: the same library record
   * when it still exists, otherwise the saved copy goes back into the library (never silently direct).
   */
  async restore(trashId: string): Promise<BrowserProfile> {
    if (!/^[a-zA-Z0-9-]+$/.test(trashId)) throw new Error('回收站条目标识无效')
    const source = join(this.vaultPath, 'recycle-bin', 'profiles', trashId)
    let record: DeletedProfileRecord
    try {
      record = JSON.parse(await readFile(join(source, 'deleted-profile.json'), 'utf8')) as DeletedProfileRecord
    } catch {
      throw new Error('回收站中的环境数据不完整')
    }
    if (record.schemaVersion !== 1 || !record.profile?.id) throw new Error('回收站中的环境元数据无效')
    if (this.profiles.has(record.profile.id)) throw new Error('相同 ID 的环境已经存在，无法恢复')
    const saved = record.profile
    return this.withLibraryRollback(async () => {
      const now = new Date().toISOString()
      const savedProxy = saved.proxy && typeof saved.proxy === 'object'
        ? privateProxyConfig({ ...saved.proxy, password: this.secrets.decode(typeof saved.proxy.password === 'string' ? saved.proxy.password : '') })
        : DIRECT
      // An API 提取 window keeps its link itself; it never goes into the library.
      const proxyId = safeApiProxy(saved.apiProxy)
        ? ''
        : typeof saved.proxyId === 'string' && this.library.proxies.has(saved.proxyId)
          ? saved.proxyId
          : this.library.ensureProxy(savedProxy, now)
      // Back into its group; a group deleted meanwhile is not brought back (the window goes to Ungrouped).
      // Windows deleted before groups had ids find their group by name.
      const groupId = typeof saved.groupId === 'string'
        ? (this.library.groups.has(saved.groupId) ? saved.groupId : '')
        : this.library.findGroup(typeof saved.group === 'string' ? saved.group : '')?.id ?? ''
      const serialNumber = validProfileSerial(saved.serialNumber) && ![...this.profiles.values()].some((item) => item.serialNumber === saved.serialNumber)
        ? saved.serialNumber
        : this.nextSerialNumber++
      const profile: StoredProfile = {
        ...storedFields(saved),
        serialNumber,
        proxyId,
        groupId,
        kernelVersion: typeof saved.kernelVersion === 'string' ? saved.kernelVersion : '',
        tags: Array.isArray(saved.tags) ? saved.tags : [],
        extensionIds: Array.isArray(saved.extensionIds) ? saved.extensionIds : [],
        fingerprint: {
          ...saved.fingerprint,
          webrtcPolicy: safeWebRtcPolicy(saved.fingerprint?.webrtcPolicy)
        },
        window: saved.window ?? defaultProfileWindow(),
        tunnel: proxyId || safeApiProxy(saved.apiProxy) ? safeTunnelRoute(saved.tunnel) : undefined,
        apiProxy: proxyId ? undefined : safeApiProxy(saved.apiProxy),
        favorite: saved.favorite === true,
        account: saved.account && typeof saved.account === 'object'
          ? privateAccount(validatePlatformAccount({
              ...saved.account,
              password: this.secrets.decode(typeof saved.account.password === 'string' ? saved.account.password : '')
            }))
          : { ...EMPTY_ACCOUNT },
        status: 'closed',
        lastError: undefined,
        updatedAt: now
      }
      if (!proxyId && saved.proxyCheck) {
        const check = safeProxyCheck(saved.proxyCheck)
        if (check) profile.directCheck = check
      }
      if (profile.serialNumber >= this.nextSerialNumber) this.nextSerialNumber = profile.serialNumber + 1
      if (this.nextSerialNumber > MAX_PROFILE_SERIAL) throw new Error('环境编号空间已用尽')
      const target = join(this.vaultPath, 'profiles', profile.id)
      await rename(source, target)
      try {
        await this.ensureProfileDirectories(profile.id)
        await rm(join(target, 'deleted-profile.json'), { force: true })
        this.profiles.set(profile.id, profile)
        await this.persist()
        return this.resolve(profile)
      } catch (error) {
        this.profiles.delete(profile.id)
        await rename(target, source).catch(() => undefined)
        throw error
      }
    })
  }

  // ---- runtime state ---------------------------------------------------------------------

  async setRuntime(
    id: string,
    patch: Pick<BrowserProfile, 'status'> & Partial<Pick<BrowserProfile, 'lastError' | 'lastOpenedAt'>>
  ): Promise<BrowserProfile> {
    const current = this.stored(id)
    const profile: StoredProfile = {
      ...current,
      ...patch,
      updatedAt: current.updatedAt
    }
    if (patch.lastError === undefined) delete profile.lastError
    this.profiles.set(id, profile)
    if (patch.lastOpenedAt || patch.status === 'closed' || patch.status === 'error') await this.persist()
    return this.resolve(profile)
  }

  /**
   * Saves the result of testing a window's network. For a library proxy the result belongs
   * to the proxy, so every window using it shows it.
   */
  async setProxyCheck(id: string, check: ProxyCheckSummary, baselineIp?: string): Promise<BrowserProfile> {
    const current = this.stored(id)
    if (current.proxyId) {
      await this.setLibraryProxyCheck(current.proxyId, check, baselineIp, id)
      return this.get(id)
    }
    if (current.apiProxy) {
      // A new proxy from the link is expected: no "exit changed" against the last one; its IP goes into the history.
      const entry: ApiIpRecord | undefined = check.ok && check.ip
        ? { at: check.checkedAt, ip: check.ip, ...(current.apiProxy.endpoint ? { port: current.apiProxy.endpoint.port } : {}), ...(check.countryCode ? { countryCode: check.countryCode } : {}), ...(check.city ? { city: check.city } : {}) }
        : undefined
      // The same proxy checked again is not a new entry.
      const latest = current.apiProxy.history?.[0]
      const repeated = entry && latest && latest.ip === entry.ip && latest.port === entry.port
      const history = entry && !repeated ? [entry, ...(current.apiProxy.history ?? [])].slice(0, API_HISTORY_LIMIT) : current.apiProxy.history
      const profile: StoredProfile = {
        ...current,
        directCheck: nextProxyCheck(check, undefined),
        apiProxy: { ...current.apiProxy, ...(history?.length ? { history } : {}) }
      }
      this.profiles.set(id, profile)
      await this.persist()
      return this.resolve(profile)
    }
    const profile: StoredProfile = { ...current, directCheck: nextProxyCheck(check, current.directCheck, baselineIp) }
    this.profiles.set(id, profile)
    await this.persist()
    return this.resolve(profile)
  }

  /** Saves a test result for a library proxy (from the proxy library page or a window). */
  async setLibraryProxyCheck(proxyId: string, check: ProxyCheckSummary, baselineIp?: string, sourceProfileId?: string): Promise<ProxyRecord> {
    const record = this.library.getProxy(proxyId)
    // An API proxy gives a new exit every time: no "exit changed" against the last one.
    const next = { ...record, check: record.apiUrl ? nextProxyCheck(check, undefined) : nextProxyCheck(check, record.check, baselineIp) }
    this.library.proxies.set(proxyId, next)
    await this.persist()
    this.notify(this.list().filter((profile) => profile.proxyId === proxyId && profile.id !== sourceProfileId).map((profile) => profile.id))
    return { ...next }
  }

  /**
   * Writes values a window worked out at launch (from its IP, from this computer) into the window
   * so later launches use the same ones. Not an edit: works while the window is starting.
   * A key given as undefined is removed.
   */
  async lockFingerprint(id: string, patch: Partial<FingerprintConfig>): Promise<BrowserProfile> {
    const current = this.stored(id)
    const fingerprint = { ...current.fingerprint, ...patch } as FingerprintConfig
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (fingerprint as unknown as Record<string, unknown>)[key]
    }
    const profile: StoredProfile = { ...current, fingerprint, updatedAt: new Date().toISOString() }
    this.profiles.set(id, profile)
    await this.persist()
    return this.resolve(profile)
  }

  async setFavorite(id: string, favorite: boolean): Promise<BrowserProfile> {
    if (typeof favorite !== 'boolean') throw new Error('收藏状态无效')
    const current = this.stored(id)
    const profile: StoredProfile = { ...current, favorite, updatedAt: new Date().toISOString() }
    this.profiles.set(id, profile)
    await this.persist()
    return this.resolve(profile)
  }

  // ---- window data directories -----------------------------------------------------------

  profileDataPath(id: string): string {
    return join(this.vaultPath, 'profiles', id, 'user-data')
  }

  profileRuntimePath(id: string): string {
    return join(this.vaultPath, 'profiles', id, 'runtime')
  }

  profileOwnerPath(id: string): string {
    return join(this.vaultPath, 'profiles', id, PROFILE_OWNER_FILE)
  }

  async assertProfileDataIdentity(id: string): Promise<void> {
    this.stored(id)
    await this.verifyProfileDataIdentity(id)
  }

  private async verifyProfileDataIdentity(id: string): Promise<void> {
    const root = join(this.vaultPath, 'profiles', id)
    const [rootInfo, markerInfo, dataInfo, runtimeInfo] = await Promise.all([
      lstat(root),
      lstat(this.profileOwnerPath(id)),
      lstat(this.profileDataPath(id)),
      lstat(this.profileRuntimePath(id))
    ]).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('环境数据目录不完整，为保护数据已取消操作')
      }
      throw error
    })
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || !markerInfo.isFile() || markerInfo.isSymbolicLink()
      || !dataInfo.isDirectory() || dataInfo.isSymbolicLink()
      || !runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
      throw new Error('环境数据目录结构异常或包含符号链接，为保护数据已取消操作')
    }
    let marker: ProfileOwnerMarker
    try {
      marker = JSON.parse(await readFile(this.profileOwnerPath(id), 'utf8')) as ProfileOwnerMarker
    } catch {
      throw new Error('环境数据身份标记损坏，为保护数据已取消操作')
    }
    if (marker.schemaVersion !== 1 || marker.profileId !== id) {
      throw new Error('环境数据目录与环境 ID 不匹配，为保护数据已取消操作')
    }
  }

  private async ensureProfileDirectories(id: string): Promise<void> {
    const root = join(this.vaultPath, 'profiles', id)
    await mkdir(root, { recursive: true })
    try {
      await writeFile(this.profileOwnerPath(id), JSON.stringify({
        schemaVersion: 1,
        profileId: id
      } satisfies ProfileOwnerMarker, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await mkdir(this.profileDataPath(id), { recursive: true })
    await mkdir(this.profileRuntimePath(id), { recursive: true })
    await this.verifyProfileDataIdentity(id)
  }

  // ---- persistence -----------------------------------------------------------------------

  /** Windows, proxies and groups are written together, so references always match what is saved. */
  private persist(): Promise<void> {
    const data: StoreFile = {
      schemaVersion: SCHEMA_VERSION,
      nextSerialNumber: this.nextSerialNumber,
      profiles: [...this.profiles.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((profile) => ({
          ...profile,
          ...(profile.apiProxy?.endpoint && this.apiPasswords.get(profile.id)
            ? { apiProxy: { ...profile.apiProxy, endpoint: { ...profile.apiProxy.endpoint, password: this.secrets.encode(this.apiPasswords.get(profile.id)!) } } }
            : {}),
          account: { ...profile.account, password: this.secrets.encode(profile.account.password) }
        })),
      proxies: this.library.listProxies().map((proxy) => ({ ...proxy, password: this.secrets.encode(proxy.password) })),
      groups: this.library.listGroups()
    }
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.profilesPath), { recursive: true })
      const temporary = `${this.profilesPath}.tmp`
      await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.profilesPath)
      const backupTemporary = `${this.backupPath}.tmp`
      try {
        if (!this.preservePreviousBackupOnce) {
          try {
            await copyFile(this.backupPath, this.previousBackupPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        await copyFile(this.profilesPath, backupTemporary)
        await rm(this.backupPath, { force: true })
        await rename(backupTemporary, this.backupPath)
        this.preservePreviousBackupOnce = false
        this.health = { ...this.health, backupHealthy: true, backupError: undefined }
      } catch (error) {
        await rm(backupTemporary, { force: true }).catch(() => undefined)
        this.health = {
          ...this.health,
          backupHealthy: false,
          backupError: error instanceof Error ? error.message : String(error)
        }
      }
    })
    this.writeQueue = operation
    return operation
  }
}
