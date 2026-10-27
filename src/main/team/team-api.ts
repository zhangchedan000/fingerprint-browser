import { createWriteStream, openAsBlob } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { TeamBackup, TeamLogPage, TeamLogQuery, TeamMemberDraft, TeamProfilePatch, TeamRole, TeamServerInfo, TeamUser } from '../../shared/team'

export type Fetch = typeof fetch

/** A record of team_profiles as the server sends it. */
export interface RemoteProfile {
  id: string
  name: string
  note: string
  source_id: string
  /** Who created it (the owner account, or a member for their own windows). */
  owner: string
  config: unknown
  config_rev: number
  assignees: string[]
  data: string
  data_rev: number
  data_by: string
  data_size?: number
  updated: string
  expand?: { data_by?: RemoteUser }
}

interface RemoteUser {
  id: string
  username: string
  name: string
  role: TeamRole
  disabled: boolean
  created: string
}

export interface RemoteLock {
  id: string
  profile: string
  holder: string
  device: string
  expires: number
  expand?: { holder?: RemoteUser }
}

interface RemoteLog {
  id: string
  created: string
  user_name: string
  action: string
  profile_name: string
  detail: Record<string, unknown> | null
  ip: string
}

interface ListResult<T> {
  items: T[]
  page: number
  totalItems: number
  totalPages: number
}

const FIELD_ERRORS: Record<string, string> = {
  validation_not_unique: '已经被使用',
  validation_min_text_constraint: '太短',
  validation_length_out_of_range: '长度不对',
  validation_required: '不能为空',
  validation_values_mismatch: '两次输入不一致',
  validation_invalid_format: '格式不对'
}
const FIELD_NAMES: Record<string, string> = {
  username: '用户名', password: '密码', passwordConfirm: '确认密码', name: '名称', data: '登录态文件'
}

export class TeamApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Server messages are Chinese from our hooks, English from PocketBase itself. */
function errorMessage(status: number, body: { message?: string; data?: Record<string, { code?: string }> } | undefined): string {
  const fields = Object.entries(body?.data ?? {})
    .filter(([, value]) => value && typeof value === 'object' && value.code)
    .map(([field, value]) => `${FIELD_NAMES[field] ?? field}${FIELD_ERRORS[value.code!] ?? '不符合要求'}`)
  if (fields.length) return fields.join('；')
  const raw = (body?.message ?? '').replace(/\.$/, '')
  if (/[\u3400-\u9fff]/.test(raw)) return raw
  if (status === 400 && /authenticate/i.test(raw)) return '用户名或密码不对'
  if (status === 403 && /authenticate/i.test(raw)) return '这个账号已被停用'
  if (status === 401) return '登录已过期，请重新登录'
  if (status === 403) return '没有权限做这件事'
  if (status === 404) return '没有找到，可能已被删除或不再分配给你'
  if (status === 413) return '文件太大，服务器拒绝接收'
  return raw ? `团队服务器出错：${raw}` : `团队服务器出错（HTTP ${status}）`
}

export function normalizeServer(input: string): string {
  let value = input.trim()
  if (!value) throw new Error('请填写团队服务器地址')
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('团队服务器地址格式不对')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('团队服务器地址格式不对')
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

export function toTeamUser(user: RemoteUser): TeamUser {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    disabled: Boolean(user.disabled),
    created: user.created
  }
}

/** PocketBase REST calls of the team server. Holds the auth token, nothing else. */
export class TeamApi {
  token = ''

  constructor(readonly server: string, private readonly fetcher: Fetch = fetch) {}

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const headers: Record<string, string> = {}
    if (this.token) headers.Authorization = this.token
    let payload: BodyInit | undefined
    if (body instanceof FormData) payload = body
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    let response: Response
    try {
      response = await this.fetcher(`${this.server}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new TeamApiError(`连不上团队服务器（${reason}）`, 0)
    }
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    if (!response.ok) throw new TeamApiError(errorMessage(response.status, parsed as never), response.status)
    if (parsed === undefined && text) throw new TeamApiError('团队服务器返回的不是有效数据，请检查服务器地址', response.status)
    return parsed as T
  }

  status(): Promise<{ ready: boolean; lockMs: number }> {
    return this.request('GET', '/api/team/status', undefined, 10_000)
  }

  setup(code: string, username: string, name: string, password: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/team/setup', { code, username, name, password })
  }

  async login(username: string, password: string): Promise<TeamUser> {
    const result = await this.request<{ token: string; record: RemoteUser }>('POST', '/api/collections/users/auth-with-password', {
      identity: username,
      password
    })
    this.token = result.token
    return toTeamUser(result.record)
  }

  /** New token and the current account (role or disabled may have changed). */
  async refresh(): Promise<TeamUser> {
    const result = await this.request<{ token: string; record: RemoteUser }>('POST', '/api/collections/users/auth-refresh', undefined, 10_000)
    this.token = result.token
    return toTeamUser(result.record)
  }

  async listUsers(): Promise<TeamUser[]> {
    const result = await this.request<ListResult<RemoteUser>>('GET', '/api/collections/users/records?perPage=500&sort=created')
    return result.items.map(toTeamUser)
  }

  async createMember(draft: Required<Pick<TeamMemberDraft, 'username' | 'password'>> & TeamMemberDraft): Promise<TeamUser> {
    return toTeamUser(await this.request<RemoteUser>('POST', '/api/collections/users/records', {
      username: draft.username,
      name: draft.name ?? '',
      role: 'member',
      disabled: false,
      password: draft.password,
      passwordConfirm: draft.password
    }))
  }

  async updateMember(id: string, draft: TeamMemberDraft): Promise<TeamUser> {
    const body: Record<string, unknown> = {}
    if (draft.username !== undefined) body.username = draft.username
    if (draft.name !== undefined) body.name = draft.name
    if (draft.disabled !== undefined) body.disabled = draft.disabled
    if (draft.password) {
      body.password = draft.password
      body.passwordConfirm = draft.password
    }
    return toTeamUser(await this.request<RemoteUser>('PATCH', `/api/collections/users/records/${encodeURIComponent(id)}`, body))
  }

  async removeMember(id: string): Promise<void> {
    await this.request('DELETE', `/api/collections/users/records/${encodeURIComponent(id)}`)
  }

  async listProfiles(): Promise<RemoteProfile[]> {
    const result = await this.request<ListResult<RemoteProfile>>('GET', '/api/collections/team_profiles/records?perPage=500&sort=name&expand=data_by&fields=*,expand.data_by.name,expand.data_by.username')
    return result.items
  }

  getProfile(id: string): Promise<RemoteProfile> {
    return this.request('GET', `/api/collections/team_profiles/records/${encodeURIComponent(id)}?expand=data_by`)
  }

  async listLocks(): Promise<RemoteLock[]> {
    const result = await this.request<ListResult<RemoteLock>>('GET', '/api/collections/team_locks/records?perPage=500&expand=holder')
    return result.items
  }

  /** Creates (no id) or updates a shared window; with dataFile, also uploads the login state. */
  async saveProfile(
    id: string | undefined,
    fields: { name?: string; note?: string; source_id?: string; owner?: string; config?: unknown; assignees?: string[] },
    data?: { file: string; rev: number; size: number; sha256: string }
  ): Promise<RemoteProfile> {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      if (key === 'config') form.append(key, JSON.stringify(value))
      else if (Array.isArray(value)) {
        // An empty list has to be sent as an empty value to clear it.
        if (!value.length) form.append(key, '')
        for (const item of value) form.append(key, item)
      } else form.append(key, String(value))
    }
    if (data) {
      form.append('data_rev', String(data.rev))
      form.append('data_size', String(data.size))
      form.append('data_sha256', data.sha256)
      form.append('data', await openAsBlob(data.file), 'profile.tgz')
    }
    // Large login states take a while over a slow line.
    const timeout = data ? Math.max(120_000, data.size / 50) : 30_000
    return id
      ? this.request('PATCH', `/api/collections/team_profiles/records/${encodeURIComponent(id)}`, form, timeout)
      : this.request('POST', '/api/collections/team_profiles/records', form, timeout)
  }

  updateProfile(id: string, patch: TeamProfilePatch): Promise<RemoteProfile> {
    return this.saveProfile(id, patch)
  }

  async removeProfile(id: string): Promise<void> {
    await this.request('DELETE', `/api/collections/team_profiles/records/${encodeURIComponent(id)}`)
  }

  lock(id: string, device: string): Promise<{ expires: number; lockMs: number }> {
    return this.request('POST', `/api/team/profiles/${encodeURIComponent(id)}/lock`, { device })
  }

  heartbeat(id: string): Promise<{ expires: number }> {
    return this.request('POST', `/api/team/profiles/${encodeURIComponent(id)}/heartbeat`)
  }

  async unlock(id: string, force = false): Promise<void> {
    await this.request('POST', `/api/team/profiles/${encodeURIComponent(id)}/unlock`, { force })
  }

  /** Saves the window's login state archive to `target`. */
  async downloadData(profile: RemoteProfile, target: string): Promise<void> {
    const { token } = await this.request<{ token: string }>('POST', '/api/files/token')
    const url = `${this.server}/api/files/team_profiles/${encodeURIComponent(profile.id)}/${encodeURIComponent(profile.data)}?token=${encodeURIComponent(token)}`
    let response: Response
    try {
      response = await this.fetcher(url, { signal: AbortSignal.timeout(30 * 60_000) })
    } catch (error) {
      throw new TeamApiError(`下载登录态失败（${error instanceof Error ? error.message : String(error)}）`, 0)
    }
    if (!response.ok || !response.body) throw new TeamApiError(`下载登录态失败（HTTP ${response.status}）`, response.status)
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(target))
  }

  serverInfo(): Promise<TeamServerInfo> {
    return this.request('GET', '/api/team/server', undefined, 15_000)
  }

  async listBackups(): Promise<TeamBackup[]> {
    return (await this.request<{ items: TeamBackup[] }>('GET', '/api/team/backups')).items
  }

  /** The server zips its whole data folder, which takes a while once there are many login states. */
  createBackup(): Promise<{ key: string }> {
    return this.request('POST', '/api/team/backups', undefined, 30 * 60_000)
  }

  async removeBackup(key: string): Promise<void> {
    await this.request('DELETE', `/api/team/backups/${encodeURIComponent(key)}`)
  }

  async downloadBackup(key: string, target: string): Promise<void> {
    let response: Response
    try {
      response = await this.fetcher(`${this.server}/api/team/backups/${encodeURIComponent(key)}`, {
        headers: { Authorization: this.token },
        signal: AbortSignal.timeout(60 * 60_000)
      })
    } catch (error) {
      throw new TeamApiError(`下载备份失败（${error instanceof Error ? error.message : String(error)}）`, 0)
    }
    if (!response.ok || !response.body) {
      let parsed: unknown
      try { parsed = await response.json() } catch { parsed = undefined }
      throw new TeamApiError(errorMessage(response.status, parsed as never), response.status)
    }
    try {
      await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(target))
    } catch (error) {
      await rm(target, { force: true })
      throw new TeamApiError(`下载备份失败（${error instanceof Error ? error.message : String(error)}）`, 0)
    }
  }

  async logs(query: TeamLogQuery): Promise<TeamLogPage> {
    const filters: string[] = []
    const quote = (value: string) => `"${value.replace(/["\\]/g, '')}"`
    if (query.userId) filters.push(`user = ${quote(query.userId)}`)
    if (query.profileId) filters.push(`profile = ${quote(query.profileId)}`)
    if (query.action) filters.push(`action = ${quote(query.action)}`)
    const params = new URLSearchParams({
      page: String(Math.max(1, query.page)),
      perPage: String(Math.min(200, Math.max(1, query.perPage))),
      sort: '-created'
    })
    if (filters.length) params.set('filter', filters.join(' && '))
    const result = await this.request<ListResult<RemoteLog>>('GET', `/api/collections/team_logs/records?${params}`)
    return {
      page: result.page,
      totalItems: result.totalItems,
      items: result.items.map((item) => ({
        id: item.id,
        created: item.created,
        userName: item.user_name,
        action: item.action,
        profileName: item.profile_name,
        detail: item.detail ?? {},
        ip: item.ip
      }))
    }
  }
}
