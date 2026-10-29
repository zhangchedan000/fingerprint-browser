import type { ApiCheckRecord, BrowserProfile, ProxyConfig, ProxyTestResult, ServerPlace } from '../shared/types'
import { resolveApiProxy, type ApiProxyEndpoint } from './api-proxy'
import type { ProfileStore } from './profile-store'

export interface ApiProxyOptions {
  /** Take a new proxy from the link even while the current one works (换一个 IP). */
  refresh?: boolean
  /**
   * The window's proxy is kept while it works, wherever its IP is (a launch: 勾选 means this IP);
   * `region` then only decides whether it counts as a mismatch, and new ones replace a dead one.
   */
  keepWorking?: boolean
  /** The window's country: a proxy elsewhere is replaced, up to `attempts` new ones. */
  region?: string
  attempts?: number
  /** What started it, for the window's check log (检测代理 unless said otherwise). */
  trigger?: ApiCheckRecord['trigger']
  /** Where a proxy server is (the address the link gave), shown next to it; none when not given. */
  locate?: (host: string) => Promise<ServerPlace | undefined>
}

export interface ApiProxyOutcome {
  profile: BrowserProfile
  check: ProxyTestResult
  /** New proxies taken from the link. */
  fetched: number
  /**
   * No proxy in the window's country came within the attempts, or the proxy rotates (then no
   * more are taken: the link gives rotating ones); the last one is in use.
   */
  mismatch: boolean
}

type Tester = (config: ProxyConfig) => Promise<ProxyTestResult>
type Fetcher = (url: string, route: ProxyConfig['tunnel']) => Promise<ApiProxyEndpoint>

/** A check log entry for one proxy the link gave (or the kept one) and what its check found. */
export function apiCheckRecord(
  trigger: ApiCheckRecord['trigger'],
  endpoint: Pick<ApiProxyEndpoint, 'host' | 'port'> | undefined,
  place: ServerPlace | undefined,
  fetched: boolean,
  result: ProxyTestResult | { error: string }
): ApiCheckRecord {
  const check = 'ok' in result ? result : undefined
  return {
    at: new Date().toISOString(),
    trigger,
    ...(endpoint ? { address: `${endpoint.host}:${endpoint.port}` } : {}),
    ...(place ? { addressPlace: place } : {}),
    ...(fetched ? { fetched: true } : {}),
    ok: Boolean(check?.ok),
    ...(check?.ok && check.ip ? { ip: check.ip } : {}),
    ...(check?.ok && check.countryCode ? { countryCode: check.countryCode.toUpperCase() } : {}),
    ...(check?.ok && check.city ? { city: check.city } : {}),
    ...(check?.rotating ? { rotating: true } : {}),
    ...(check && !check.ok ? { error: check.error ?? '代理不可用' } : {}),
    ...(!check && 'error' in result ? { error: result.error } : {})
  }
}

/**
 * An API 提取 window's proxy: the one it has while it still works, so an account keeps its IP and
 * the link is not used up; a new one from the link when it stops working or is elsewhere. A
 * rotating proxy is not replaced: the link hands out rotating ones, more would only use it up.
 * Every check is saved on the window and in its check log, and every new IP goes into its history.
 */
export async function apiProxyFor(
  profiles: ProfileStore,
  id: string,
  tester: Tester,
  options: ApiProxyOptions = {},
  fetchProxy: Fetcher = resolveApiProxy
): Promise<ApiProxyOutcome> {
  const attempts = Math.max(1, options.attempts ?? 1)
  const trigger = options.trigger ?? (options.refresh ? 'refresh' : 'check')
  const fits = (check: ProxyTestResult) => check.ok && (!options.region || (check.geoConfidence !== 'conflict'
    && (!check.countryCode || check.countryCode.toUpperCase() === options.region)))
  const save = async (check: ProxyTestResult) => profiles.setProxyCheck(id, { ...check, checkedAt: new Date().toISOString() })
  // Where the server is, looked up while its check runs.
  const placeOf = (host: string) => options.locate ? options.locate(host).catch(() => undefined) : Promise.resolve(undefined)
  let profile = profiles.get(id)
  if (!profile.apiProxy) throw new Error('这个窗口没有使用 API 提取')
  let last: { profile: BrowserProfile; check: ProxyTestResult } | undefined
  // The last proxy that worked (in another country), put back when none of the new ones works.
  let working: { endpoint: ApiProxyEndpoint; check: ProxyTestResult; place?: ServerPlace; fetchedAt?: string } | undefined
  const remember = (check: ProxyTestResult) => {
    const { protocol, host, port, username, password } = profile.proxy
    const kept = profile.apiProxy?.endpoint
    if (check.ok && (protocol === 'http' || protocol === 'socks5') && port) working = { endpoint: { protocol, host, port, username, password }, check, place: kept?.place, fetchedAt: kept?.fetchedAt }
  }
  // 取消勾选: the kept proxy is not used again.
  if (!options.refresh && profile.apiProxy.endpoint && !profile.apiProxy.released) {
    const kept = profile.apiProxy.endpoint
    const [check, found] = await Promise.all([tester(profile.proxy), kept.place ? Promise.resolve(kept.place) : placeOf(kept.host)])
    if (found && !kept.place) profile = await profiles.setWindowApiEndpoint(id, { ...kept, password: profile.proxy.password }, found, kept.fetchedAt)
    profile = await save(check)
    profile = await profiles.noteApiCheck(id, apiCheckRecord(trigger, kept, found, false, check))
    if (fits(check)) return { profile, check, fetched: 0, mismatch: false }
    if (check.ok && options.keepWorking) return { profile, check, fetched: 0, mismatch: true }
    last = { profile, check }
    remember(check)
    if (check.ok && check.rotating) return { ...last, fetched: 0, mismatch: true }
  }
  let fetched = 0
  let fetchError: unknown
  while (fetched < attempts) {
    fetched += 1
    let endpoint: ApiProxyEndpoint
    try {
      endpoint = await fetchProxy(profile.apiProxy!.url, profile.proxy.tunnel)
    } catch (error) {
      fetchError = error
      profile = await profiles.noteApiCheck(id, apiCheckRecord(trigger, undefined, undefined, true, { error: error instanceof Error ? error.message : String(error) }))
      continue
    }
    const placing = placeOf(endpoint.host)
    profile = await profiles.setWindowApiEndpoint(id, endpoint)
    const [check, place] = await Promise.all([tester(profile.proxy), placing])
    if (place) profile = await profiles.setWindowApiEndpoint(id, endpoint, place, profile.apiProxy?.endpoint?.fetchedAt)
    profile = await save(check)
    profile = await profiles.noteApiCheck(id, apiCheckRecord(trigger, endpoint, place, true, check))
    if (fits(check)) return { profile, check, fetched, mismatch: false }
    last = { profile, check }
    remember(check)
    if (check.ok && check.rotating) return { ...last, fetched, mismatch: true }
  }
  if (!last?.check.ok && working) {
    profile = await profiles.setWindowApiEndpoint(id, working.endpoint, working.place, working.fetchedAt)
    profile = await save(working.check)
    return { profile, check: working.check, fetched, mismatch: true }
  }
  if (!last) throw fetchError instanceof Error ? fetchError : new Error(String(fetchError))
  return { ...last, fetched, mismatch: last.check.ok }
}
