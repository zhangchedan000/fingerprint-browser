import { Tooltip } from 'antd'
import { t, translateMessage as mt } from '../../../shared/i18n'
import type { ProxyCheckSummary, ProxyConfig, ProxyRecordView } from '../../../shared/types'

/** host:port, with IPv6 hosts in brackets. */
export function proxyAddress(proxy: Pick<ProxyConfig, 'host' | 'port'>): string {
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  return `${host}:${proxy.port ?? ''}`
}

/** Country badge + exit IP (or address) + protocol and city: the proxy cell used in every list. */
export function ProxyCell({ proxy, check, missing }: { proxy: ProxyConfig; check?: ProxyCheckSummary; missing?: boolean }) {
  if (missing) {
    return (
      <div className="fb-proxy-cell">
        <div><span className="fb-cc muted">—</span><span>{t("代理已删除")}</span></div>
        <small className="fb-proxy-bad">{t("请重新选择代理")}</small>
      </div>
    )
  }
  if (proxy.protocol === 'direct') {
    return (
      <div className="fb-proxy-cell">
        <div><span className="fb-cc muted">—</span><span>{t("直连")}</span></div>
        <small>{t("本机网络")}</small>
      </div>
    )
  }
  const location = check?.ok ? check.city || check.country || '' : ''
  return (
    <div className="fb-proxy-cell">
      <div>
        <span className={`fb-cc${check?.ok && check.countryCode ? '' : ' muted'}`}>{check?.ok && check.countryCode ? check.countryCode : '—'}</span>
        <span className="fb-mono">{check?.ok && check.ip ? check.ip : proxyAddress(proxy)}</span>
      </div>
      <div className="fb-proxy-meta">
        <small className="fb-ellipsis" title={check?.ok ? [check.country, check.region, check.city].filter(Boolean).join(' · ') : undefined}>
          {proxy.protocol.toUpperCase()}{location ? ` · ${location}` : ''}
        </small>
        {check && !check.ok && <Tooltip title={mt(check.error ?? t("连接失败"))}><small className="fb-proxy-bad">{t("检测失败")}</small></Tooltip>}
        {!check && <small className="fb-proxy-unknown">{t("未检测")}</small>}
        {check?.exitChanged && <Tooltip title={t("出口 IP 与上次不同")}><small className="fb-proxy-warn">{t("出口变化")}</small></Tooltip>}
      </div>
    </div>
  )
}

/** One line describing a library proxy, for pickers. */
export function proxyLabel(proxy: ProxyRecordView) {
  const details = [
    proxy.check?.ok ? [proxy.check.countryCode, proxy.check.ip].filter(Boolean).join(' ') : '',
    proxy.note,
    proxy.profileIds.length ? t("{0} 个窗口在用", proxy.profileIds.length) : t("未绑定")
  ].filter(Boolean)
  return (
    <span className="fb-proxy-option">
      <span className="fb-mono">{proxy.apiUrl ? t("API 提取 · {0}", new URL(proxy.apiUrl).hostname) : `${proxy.protocol.toUpperCase()} · ${proxyAddress(proxy)}${proxy.username ? ` · ${proxy.username}` : ''}`}</span>
      <small>{details.join(' · ')}</small>
    </span>
  )
}
