import { CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { Tag } from 'antd'
import type { ReactNode } from 'react'
import { regionName } from './format'
import { t, translateMessage as mt } from '../../../shared/i18n'
import type { ProxyTestResult } from '../../../shared/types'
import { DelayText } from './TunnelRouteField'

/**
 * A proxy check, as the exit IP it found: a chosen-looking card with the IP, where it is, how fast
 * it answered and whether UDP goes through; red with the reason when it failed. `note` adds a line
 * (when it was checked, where an API proxy came from), `stale` greys it once the proxy was changed.
 * `chosen` makes its mark a checkbox (API 提取: ticked, the window opens on this IP).
 */
export function ExitIpCard({ result, stale, notes, typeHint, risk, chosen }: {
  result: ProxyTestResult
  stale?: boolean
  notes?: ReactNode[]
  /** The failure may come from the wrong type (HTTP / SOCKS5) being picked. */
  typeHint?: boolean
  risk?: string
  chosen?: { checked: boolean; onChange: (checked: boolean) => void }
}) {
  const shownNotes = (notes ?? []).filter(Boolean)
  if (!result.ok) {
    return (
      <div className={`fb-ip-card is-bad${stale ? ' is-stale' : ''}`}>
        <span className="fb-ip-mark"><CloseOutlined /></span>
        <span className="fb-ip-address">{t("连接失败")}</span>
        <span className="fb-ip-place" />
        <span className="fb-ip-meta">
          <span>{mt(result.error)}{typeHint && !result.error?.includes('白名单') ? ` · ${t("请确认代理类型（HTTP / SOCKS5）是否选对")}` : ''}</span>
          {shownNotes.map((note, index) => <span key={index}>{note}</span>)}
        </span>
      </div>
    )
  }
  const country = result.countryCode ? regionName(result.countryCode.toUpperCase()) : result.country
  const off = chosen && !chosen.checked
  return (
    <div className={`fb-ip-card${stale ? ' is-stale' : ''}${result.geoConfidence === 'conflict' ? ' is-warn' : ''}${off ? ' is-off' : ''}`}>
      {chosen ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={chosen.checked}
          className="fb-ip-mark is-toggle"
          title={chosen.checked ? t("取消勾选：不用这个 IP，下次启动从链接取新的") : t("勾选：窗口用这个 IP 启动")}
          onClick={() => chosen.onChange(!chosen.checked)}
        >
          {chosen.checked && <CheckOutlined />}
        </button>
      ) : <span className="fb-ip-mark"><CheckOutlined /></span>}
      <span className="fb-ip-address">{result.ip}</span>
      <span className="fb-ip-place">{[country, result.city].filter(Boolean).join(' · ')}</span>
      <span className="fb-ip-meta">
        <span>{t("延迟")} <DelayText delay={result.latencyMs} /></span>
        {result.udp !== undefined && <span>{result.udp ? t("支持 UDP") : t("不支持 UDP")}</span>}
        {shownNotes.map((note, index) => <span key={index}>{note}</span>)}
        {risk && <Tag color="warning" className="fb-inline-tag">{risk}</Tag>}
        {chosen && <span className="fb-ip-use">{chosen.checked ? t("窗口用这个 IP 启动") : t("不用这个 IP：保存后，下次启动从链接取新的")}</span>}
      </span>
    </div>
  )
}
