import { useRef, useState } from 'react'
import type { IpSiteRecord } from '../../../shared/ip-sites'
import type { ProfileDraft } from '../../../shared/types'
import { IpScorePanel } from './IpScorePanel'

/**
 * IP 评分 for an exit IP card, wherever one is shown (window editor, proxy forms): read after a
 * check that worked, through a check browser with the given draft's proxy; the panel goes on the
 * card's right.
 */
export function useIpScore(source: { draft: () => ProfileDraft; profileId?: string; libraryProxyId?: string; onOpen?: (url: string) => void }) {
  const [state, setState] = useState<{ record?: IpSiteRecord; loading?: boolean; error?: string }>({})
  const run = useRef(0)
  // Proxy and IP pairs read on their own already (a failed reading is not retried by itself).
  const autoRead = useRef(new Set<string>())

  async function read(): Promise<void> {
    const current = ++run.current
    setState({ loading: true })
    try {
      const record = await window.browserApi.profiles.ipSites(source.draft(), source.profileId, source.libraryProxyId)
      if (current === run.current) setState({ record })
    } catch (error) {
      if (current === run.current) setState({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Forget what was shown (another proxy, a failed check); `record`: show a kept reading instead. */
  function reset(record?: IpSiteRecord): void {
    run.current += 1
    setState(record ? { record } : {})
  }

  /** A new editing session: proxies may be read on their own again. */
  function forgetAutoReads(): void {
    autoRead.current.clear()
  }

  /**
   * The reading kept for a library proxy or a window, about `checkIp` (the IP shown). One still being
   * read (by any page, for that proxy) shows as reading and comes in when it is done. `readIfMissing`
   * (a library proxy whose check worked): none kept about this IP, so it is read now, once.
   */
  async function follow(target: { proxyId?: string; profileId?: string }, checkIp?: string, options: { readIfMissing?: boolean } = {}): Promise<void> {
    const current = ++run.current
    const fits = (record: IpSiteRecord | null) => record && (!checkIp || !record.checkIp || record.checkIp === checkIp) ? { record } : {}
    try {
      const kept = await window.browserApi.proxy.keptIpSites(target, false)
      if (current !== run.current) return
      setState({ ...fits(kept.record), ...(kept.pending ? { loading: true } : {}) })
      let record = kept.record
      if (kept.pending) {
        const done = await window.browserApi.proxy.keptIpSites(target, true)
        if (current !== run.current) return
        setState(fits(done.record))
        record = done.record
      }
      const key = `${target.proxyId ?? target.profileId ?? ''}|${checkIp ?? ''}`
      if (options.readIfMissing && checkIp && !fits(record).record && !autoRead.current.has(key)) {
        autoRead.current.add(key)
        await read()
      }
    } catch {
      if (current === run.current) setState({})
    }
  }

  /** Shows a kept reading if nothing newer started since `startedAt` (a value of `token()`). */
  function showKept(record: IpSiteRecord, startedAt: number): void {
    if (startedAt === run.current) setState({ record })
  }

  const panel = (checkIp?: string) => (
    <IpScorePanel
      record={state.record}
      loading={state.loading}
      error={state.error}
      checkIp={checkIp}
      onRetry={() => void read()}
      onOpen={source.onOpen}
    />
  )

  return { record: state.record, loading: state.loading === true, read, follow, reset, forgetAutoReads, showKept, token: () => run.current, panel }
}
