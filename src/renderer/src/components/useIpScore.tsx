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

  /**
   * The reading kept for a library proxy or a window, about `checkIp` (the IP shown). One still being
   * read (by any page, for that proxy) shows as reading and comes in when it is done.
   */
  async function follow(target: { proxyId?: string; profileId?: string }, checkIp?: string): Promise<void> {
    const current = ++run.current
    const fits = (record: IpSiteRecord | null) => record && (!checkIp || !record.checkIp || record.checkIp === checkIp) ? { record } : {}
    try {
      const kept = await window.browserApi.proxy.keptIpSites(target, false)
      if (current !== run.current) return
      setState({ ...fits(kept.record), ...(kept.pending ? { loading: true } : {}) })
      if (!kept.pending) return
      const done = await window.browserApi.proxy.keptIpSites(target, true)
      if (current === run.current) setState(fits(done.record))
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

  return { record: state.record, loading: state.loading === true, read, follow, reset, showKept, token: () => run.current, panel }
}
