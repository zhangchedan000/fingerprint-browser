import { ExitIpCard } from '../../components/ExitIpCard'
import { Button } from 'antd'
import { useState, type ReactNode } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import type { ProxyTestResult } from '../../../../shared/types'

/** The exit IP part of the proxy forms: 检测代理 and what the check found (ExitIpCard, IP 评分 on its right). */
export function ProxyTestButton({ result, onTest, aside, note }: { result: ProxyTestResult | null; onTest: () => Promise<void>; aside?: ReactNode; note?: string }) {
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="fb-exit-block">
      <div className="fb-exit-head">
        <span className="fb-exit-title">{t("出口 IP")}</span>
        <Button
          type="primary"
          ghost
          loading={testing}
          onClick={async () => {
            setTesting(true)
            setError('')
            try {
              await onTest()
            } catch (failure) {
              if (!(failure && typeof failure === 'object' && 'errorFields' in failure)) setError(failure instanceof Error ? failure.message : String(failure))
            } finally {
              setTesting(false)
            }
          }}
        >{result ? t("重新检测") : t("检测代理")}</Button>
      </div>
      {result
        ? <ExitIpCard result={result} typeHint notes={[note ?? '', result.ok && result.degraded && result.warning ? mt(result.warning) : '']} aside={result.ok ? aside : undefined} />
        : !error && <span className="fb-muted">{t("还没检测；检测后这里是这个代理的出口 IP")}</span>}
      {error && <span className="fb-proxy-result bad">{mt(error)}</span>}
    </div>
  )
}
