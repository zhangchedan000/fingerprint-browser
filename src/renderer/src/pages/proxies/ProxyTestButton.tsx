import { Button } from 'antd'
import { useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import type { ProxyTestResult } from '../../../../shared/types'

/** "检测代理" + the result line, shared by the proxy forms. */
export function ProxyTestButton({ result, onTest }: { result: ProxyTestResult | null; onTest: () => Promise<void> }) {
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="fb-proxy-test">
      <Button
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
      >{t("检测代理")}</Button>
      {result?.ok && (
        <span className={`fb-proxy-result ${result.geoConfidence === 'conflict' ? 'warn' : 'ok'}`}>
          {t("连接正常")} · {result.ip} · {[result.country, result.city].filter(Boolean).join(' ')} · {t("延迟 {0} ms", result.latencyMs)}
        </span>
      )}
      {result?.ok && result.degraded && result.warning && <span className="fb-proxy-result warn">{mt(result.warning)}</span>}
      {result && !result.ok && <span className="fb-proxy-result bad">{t("连接失败：{0}", mt(result.error))} · {t("请确认代理类型（HTTP / SOCKS5）是否选对")}</span>}
      {error && <span className="fb-proxy-result bad">{mt(error)}</span>}
    </div>
  )
}
