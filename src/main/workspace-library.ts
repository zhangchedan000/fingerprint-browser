import { randomUUID } from 'node:crypto'
import { nextGroupColor } from '../shared/group-colors'
import type { GroupDraft, GroupRecord, ProxyCheckSummary, ProxyConfig, ProxyDraft, ProxyRecord } from '../shared/types'
import { validateGroupDraft, validateProxyConfig, validateProxyDraft } from '../shared/validation'
import { sameProxyIdentity } from './profile-secrets'

/**
 * The libraries windows refer to: proxies and groups.
 *
 * Every proxy and group exists here exactly once. A window only stores proxyId / groupId,
 * and everything that shows "the window's proxy" or "the window's group" reads it from here.
 * This class is pure (no disk access); ProfileStore persists it together with the windows
 * in one file, so a window can never point at a record that was saved separately.
 */
export class WorkspaceLibrary {
  readonly proxies: Map<string, ProxyRecord>
  readonly groups: Map<string, GroupRecord>

  constructor(proxies: ProxyRecord[] = [], groups: GroupRecord[] = []) {
    this.proxies = new Map(proxies.map((proxy) => [proxy.id, proxy]))
    this.groups = new Map(groups.map((group) => [group.id, group]))
  }

  clone(): WorkspaceLibrary {
    return new WorkspaceLibrary(
      [...this.proxies.values()].map((proxy) => ({ ...proxy, check: proxy.check ? { ...proxy.check } : undefined })),
      [...this.groups.values()].map((group) => ({ ...group }))
    )
  }

  // ---- proxies ---------------------------------------------------------------------------

  listProxies(): ProxyRecord[] {
    return [...this.proxies.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  getProxy(id: string): ProxyRecord {
    const proxy = this.proxies.get(id)
    if (!proxy) throw new Error('代理不存在或已被删除')
    return proxy
  }

  /** The connection settings of a library proxy, in the shape the launcher and tester use. */
  proxyConfig(id: string): ProxyConfig | undefined {
    const proxy = this.proxies.get(id)
    return proxy && {
      protocol: proxy.protocol, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password,
      ...(proxy.apiUrl ? { apiUrl: proxy.apiUrl } : {}),
      ...(proxy.tunnel ? { tunnel: proxy.tunnel } : {})
    }
  }

  /**
   * Finds the library proxy a typed-in proxy means.
   * With keepSavedPassword (password left empty in a form that had one saved), the password is not compared.
   */
  findProxy(config: ProxyConfig, keepSavedPassword = false): ProxyRecord | undefined {
    if (config.protocol === 'direct') return undefined
    const candidates = this.listProxies().filter((proxy) => sameProxyIdentity(proxy, config))
    if (keepSavedPassword && !config.password) return candidates[0]
    return candidates.find((proxy) => proxy.password === config.password)
  }

  /**
   * Returns the id of the library proxy for a typed-in proxy, adding it when it is new.
   * '' means direct connection. This is the only way a proxy typed anywhere (editor, import,
   * restore, migration) becomes part of a window.
   */
  ensureProxy(input: ProxyConfig, now: string, check?: ProxyCheckSummary): string {
    const config = validateProxyConfig(input)
    if (config.protocol === 'direct') return ''
    // An API proxy is the same one by its extraction link, whatever proxy it gave this time.
    const existing = config.apiUrl ? this.findApiProxy(config.apiUrl) : this.findProxy(config, config.passwordStored === true)
    if (existing) {
      if (check && (!existing.check || existing.check.checkedAt < check.checkedAt)) existing.check = check
      return existing.id
    }
    const record: ProxyRecord = {
      id: randomUUID(),
      protocol: config.protocol,
      host: config.host,
      port: config.port!,
      username: config.username,
      password: config.password,
      note: '',
      createdAt: now,
      updatedAt: now,
      ...(check ? { check } : {}),
      ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
      // A proxy typed into a window starts with that window's 网络加速 as its default.
      ...(config.tunnel ? { tunnel: config.tunnel } : {})
    }
    this.proxies.set(record.id, record)
    return record.id
  }

  /** The library's API proxy with this extraction URL (an API proxy is the same one by its URL). */
  private findApiProxy(apiUrl: string): ProxyRecord | undefined {
    return this.listProxies().find((proxy) => proxy.apiUrl === apiUrl)
  }

  addProxy(input: ProxyDraft, now: string): ProxyRecord {
    const draft = validateProxyDraft(input)
    if (draft.apiUrl ? this.findApiProxy(draft.apiUrl) : this.findProxy(draft)) throw new Error('代理库中已有相同的代理')
    const record: ProxyRecord = {
      id: randomUUID(),
      protocol: draft.protocol,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      password: draft.password,
      note: draft.note,
      createdAt: now,
      updatedAt: now,
      ...(draft.apiUrl ? { apiUrl: draft.apiUrl } : {}),
      ...(draft.tunnel ? { tunnel: draft.tunnel } : {})
    }
    this.proxies.set(record.id, record)
    return record
  }

  updateProxy(id: string, input: ProxyDraft, now: string): ProxyRecord {
    const current = this.getProxy(id)
    const draft = validateProxyDraft(input)
    const password = !draft.password && draft.passwordStored && sameProxyIdentity(draft, current) ? current.password : draft.password
    const duplicate = draft.apiUrl ? this.findApiProxy(draft.apiUrl) : this.findProxy({ ...draft, password })
    if (duplicate && duplicate.id !== id) throw new Error('代理库中已有相同的代理')
    const connectionChanged = !sameProxyIdentity(draft, current) || password !== current.password
    const record: ProxyRecord = {
      ...current,
      protocol: draft.protocol,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      password,
      note: draft.note,
      updatedAt: now
    }
    if (draft.apiUrl) record.apiUrl = draft.apiUrl
    else delete record.apiUrl
    if (draft.tunnel) record.tunnel = draft.tunnel
    // A check of the old connection says nothing about the new one.
    if (connectionChanged) {
      delete record.check
      delete record.ipSites
    }
    this.proxies.set(id, record)
    return record
  }

  /** The proxy an API proxy's extraction gave last, kept so lists show it; its check stays. */
  setApiEndpoint(id: string, endpoint: Pick<ProxyRecord, 'protocol' | 'host' | 'port' | 'username' | 'password'>, now: string): ProxyRecord {
    const current = this.getProxy(id)
    if (!current.apiUrl) throw new Error('这不是 API 代理')
    const record: ProxyRecord = { ...current, ...endpoint, updatedAt: now }
    this.proxies.set(id, record)
    return record
  }

  deleteProxy(id: string): void {
    this.getProxy(id)
    this.proxies.delete(id)
  }

  // ---- groups ----------------------------------------------------------------------------

  listGroups(): GroupRecord[] {
    return [...this.groups.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
  }

  getGroup(id: string): GroupRecord {
    const group = this.groups.get(id)
    if (!group) throw new Error('分组不存在或已被删除')
    return group
  }

  groupName(id: string): string {
    return id ? this.groups.get(id)?.name ?? '' : ''
  }

  findGroup(name: string): GroupRecord | undefined {
    const wanted = name.trim()
    return this.listGroups().find((group) => group.name === wanted)
  }

  /** Returns the id of the group with this name, adding it when it is new. '' means ungrouped. */
  ensureGroup(name: string, now: string): string {
    if (!name.trim()) return ''
    const existing = this.findGroup(name)
    if (existing) return existing.id
    return this.addGroup({ name }, now).id
  }

  addGroup(input: GroupDraft, now: string): GroupRecord {
    const draft = validateGroupDraft(input)
    if (this.findGroup(draft.name)) throw new Error('已有同名分组')
    const record: GroupRecord = {
      id: randomUUID(),
      name: draft.name,
      color: draft.color ?? nextGroupColor(this.groups.size),
      note: draft.note,
      createdAt: now
    }
    this.groups.set(record.id, record)
    return record
  }

  updateGroup(id: string, input: GroupDraft): GroupRecord {
    const current = this.getGroup(id)
    const draft = validateGroupDraft(input)
    const duplicate = this.findGroup(draft.name)
    if (duplicate && duplicate.id !== id) throw new Error('已有同名分组')
    const record = { ...current, name: draft.name, color: draft.color ?? current.color, note: draft.note }
    this.groups.set(id, record)
    return record
  }

  deleteGroup(id: string): void {
    this.getGroup(id)
    this.groups.delete(id)
  }
}
