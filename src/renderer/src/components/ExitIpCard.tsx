import { CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { Tag } from 'antd'
import { Fragment, type ReactNode } from 'react'
import { regionName } from './format'
import { t, translateMessage as mt } from '../../../shared/i18n'
import type { ProxyTestResult } from '../../../shared/types'
import { DelayText } from './TunnelRouteField'

/** The geo databases that agreed on where the IP is (proxy-test.ts names them). */
function sourcesText(result: ProxyTestResult): string {
  if (!result.geoSources?.length) return ''
  const sources = result.geoSources.join('、')
  return result.geoConfidence === 'consensus' ? t("{0}（一致）", sources) : sources
}

/**
 * A proxy check, as the exit IP it found: a chosen-looking card with the IP and where it is, then
 * one row per thing the check found (place, time zone, network, speed, UDP…); red with the reason
 * when it failed. `notes` add rows (when it was checked, where an API proxy came from), `stale` greys
 * it once the proxy was changed. `chosen` makes its mark a checkbox: ticked, the window keeps this
 * result (API 提取: opens on this IP); unticked, nothing of it is kept once the editor closes.
 * `aside` goes on its right (what the IP check sites say).
 */
export function ExitIpCard({ result, stale, notes, typeHint, risk, chosen, aside }: {
  result: ProxyTestResult
  stale?: boolean
  notes?: ReactNode[]
  /** The failure may come from the wrong type (HTTP / SOCKS5) being picked. */
  typeHint?: boolean
  risk?: string
  chosen?: { checked: boolean; onChange: (checked: boolean) => void; api?: boolean }
  aside?: ReactNode
}) {
  const shownNotes = (notes ?? []).filter(Boolean)
  if (!result.ok) {
    return (
      <div className={`fb-ip-card is-bad${stale ? ' is-stale' : ''}`}>
        <span className="fb-ip-mark"><CloseOutlined /></span>
        <span className="fb-ip-address">{t("连接失败")}</span>
        <span className="fb-ip-place" />
        <div className="fb-ip-rows">
          <span className="fb-ip-row-full">{mt(result.error)}{typeHint && !result.error?.includes('白名单') ? ` · ${t("请确认代理类型（HTTP / SOCKS5）是否选对")}` : ''}</span>
          {shownNotes.map((note, index) => <span key={index} className="fb-ip-row-full">{note}</span>)}
        </div>
      </div>
    )
  }
  const country = result.countryCode ? regionName(result.countryCode.toUpperCase()) : result.country
  const off = chosen && !chosen.checked
  const place = [country, result.region && result.region !== result.city ? result.region : '', result.city].filter(Boolean).join(' · ')
  const coordinates = result.latitude !== undefined && result.longitude !== undefined
    ? `${result.latitude.toFixed(4)}, ${result.longitude.toFixed(4)}${result.accuracyMeters ? ` ±${Math.round(result.accuracyMeters / 1000)} km` : ''}`
    : ''
  const network = [result.asn ? `AS${result.asn}` : '', result.organization].filter(Boolean).join(' ')
  const isp = result.isp && result.isp !== result.organization ? result.isp : ''
  const rows: Array<[string, ReactNode]> = [
    [t("位置"), place],
    [t("时区"), result.timezone],
    [t("坐标"), coordinates],
    [t("网络"), network],
    [t("运营商"), isp],
    [t("延迟"), <DelayText delay={result.latencyMs} />],
    ['UDP', result.udp === undefined ? '' : result.udp ? t("支持") : t("不支持")],
    [t("定位来源"), sourcesText(result)],
    [t("上次 IP"), result.exitChanged && result.previousIp ? result.previousIp : '']
  ]
  const useText = !chosen ? '' : chosen.api
    ? (chosen.checked ? t("窗口用这个 IP 启动") : t("不用这个 IP：保存后，下次启动从链接取新的"))
    : (chosen.checked ? t("保留这次检测结果") : t("不保留：关闭页面后删除这次检测结果"))
  const card = (
    <div className={`fb-ip-card${stale ? ' is-stale' : ''}${result.geoConfidence === 'conflict' ? ' is-warn' : ''}${off ? ' is-off' : ''}${aside ? ' has-aside' : ''}`}>
      {chosen ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={chosen.checked}
          className="fb-ip-mark is-toggle"
          title={chosen.api
            ? (chosen.checked ? t("取消勾选：不用这个 IP，下次启动从链接取新的") : t("勾选：窗口用这个 IP 启动"))
            : (chosen.checked ? t("取消勾选：关闭页面后删除这次检测结果") : t("勾选：保留这次检测结果"))}
          onClick={() => chosen.onChange(!chosen.checked)}
        >
          {chosen.checked && <CheckOutlined />}
        </button>
      ) : <span className="fb-ip-mark"><CheckOutlined /></span>}
      <span className="fb-ip-address">{result.ip}{result.ipVersion && <span className="fb-ip-version">IPv{result.ipVersion}</span>}</span>
      <span className="fb-ip-place">{country}</span>
      <div className="fb-ip-rows">
        {rows.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => (
          <Fragment key={label}><span className="k">{label}</span><span className="v">{value}</span></Fragment>
        ))}
        {risk && <span className="fb-ip-row-full"><Tag color="warning" className="fb-inline-tag">{risk}</Tag></span>}
        {shownNotes.map((note, index) => <span key={index} className="fb-ip-row-full">{note}</span>)}
        {useText && <span className="fb-ip-row-full fb-ip-use">{useText}</span>}
      </div>
    </div>
  )
  if (!aside) return card
  // The wrapper measures the width it has: a narrow one (the 代理 IP form) puts IP 评分 below the IP.
  return (
    <div className="fb-ip-card-wrap">
      <div className={`fb-ip-card-row${stale ? ' is-stale' : ''}${off ? ' is-off' : ''}`}>
        {card}
        <div className="fb-ip-card-aside">{aside}</div>
      </div>
    </div>
  )
}
