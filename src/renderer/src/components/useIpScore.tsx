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

  return { record: state.record, read, reset, showKept, token: () => run.current, panel }
}
