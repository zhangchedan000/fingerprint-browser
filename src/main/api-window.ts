import type { BrowserProfile, ProxyConfig, ProxyTestResult } from '../shared/types'
import { resolveApiProxy, type ApiProxyEndpoint } from './api-proxy'
import type { ProfileStore } from './profile-store'

export interface ApiProxyOptions {
  /** Take a new proxy from the link even while the current one works (换一个 IP). */
  refresh?: boolean
  /** The window's country: a proxy elsewhere (or rotating) is replaced, up to `attempts` new ones. */
  region?: string
  attempts?: number
}

export interface ApiProxyOutcome {
  profile: BrowserProfile
  check: ProxyTestResult
  /** New proxies taken from the link. */
  fetched: number
  /** No proxy in the window's country (or a fixed one) came within the attempts; the last one is in use. */
  mismatch: boolean
}

type Tester = (config: ProxyConfig) => Promise<ProxyTestResult>
type Fetcher = (url: string, route: ProxyConfig['tunnel']) => Promise<ApiProxyEndpoint>

/**
 * An API 提取 window's proxy: the one it has while it still works, so an account keeps its IP and
 * the link is not used up; a new one from the link when it stops working, is elsewhere or rotates.
 * Every check is saved on the window, and every new IP goes into its history.
 */
export async function apiProxyFor(
  profiles: ProfileStore,
  id: string,
  tester: Tester,
  options: ApiProxyOptions = {},
  fetchProxy: Fetcher = resolveApiProxy
): Promise<ApiProxyOutcome> {
  const attempts = Math.max(1, options.attempts ?? 1)
  const fits = (check: ProxyTestResult) => check.ok && (!options.region || (check.geoConfidence !== 'conflict'
    && (!check.countryCode || check.countryCode.toUpperCase() === options.region)))
  const save = async (check: ProxyTestResult) => profiles.setProxyCheck(id, { ...check, checkedAt: new Date().toISOString() })
  let profile = profiles.get(id)
  if (!profile.apiProxy) throw new Error('这个窗口没有使用 API 提取')
  let last: { profile: BrowserProfile; check: ProxyTestResult } | undefined
  if (!options.refresh && profile.apiProxy.endpoint) {
    const check = await tester(profile.proxy)
    profile = await save(check)
    if (fits(check)) return { profile, check, fetched: 0, mismatch: false }
    last = { profile, check }
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
      continue
    }
    profile = await profiles.setWindowApiEndpoint(id, endpoint)
    const check = await tester(profile.proxy)
    profile = await save(check)
    if (fits(check)) return { profile, check, fetched, mismatch: false }
    last = { profile, check }
  }
  if (!last) throw fetchError instanceof Error ? fetchError : new Error(String(fetchError))
  return { ...last, fetched, mismatch: last.check.ok }
}
