import { ThunderboltOutlined } from '@ant-design/icons'
import { Radio, Select, Switch } from 'antd'
import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import type { TunnelRoute, TunnelStatus } from '../../../shared/types'

export const TUNNEL_STATE_PILL: Record<TunnelStatus['state'], [string, string]> = {
  off: ['is-off', '未开启'],
  starting: ['is-busy', '启动中'],
  running: ['is-on', '运行中'],
  error: ['is-bad', '出错']
}

export function DelayText({ delay }: { delay?: number }) {
  if (delay === undefined) return <span className="fb-muted">—</span>
  if (delay === 0) return <span className="fb-tunnel-delay is-bad">{t("超时")}</span>
  return <span className={`fb-tunnel-delay ${delay < 300 ? 'is-good' : delay < 800 ? 'is-fair' : 'is-bad'}`}>{delay} ms</span>
}

/** Settings → 网络加速 (the built-in tunnel), kept current while a form is open. */
export function useTunnelStatus(): TunnelStatus | undefined {
  const [status, setStatus] = useState<TunnelStatus>()
  useEffect(() => {
    let alive = true
    void window.browserApi.tunnel.status().then((next) => { if (alive) setStatus(next) }).catch(() => undefined)
    const unsubscribe = window.browserApi.tunnel.onChanged(setStatus)
    return () => { alive = false; unsubscribe() }
  }, [])
  return status
}

/**
 * The 网络加速 shown for a window or proxy that has none of its own: its proxy's default; else, for
 * windows and proxies from before 0.5.9 (legacyCountry given, '' when never checked), what the old
 * rule did — through the tunnel while it is on, unless the proxy is in China; else off.
 * Mode and node start as chosen in Settings → 网络加速.
 */
export function defaultTunnelRoute(status: TunnelStatus | undefined, proxyDefault?: TunnelRoute, legacyCountry?: string): TunnelRoute {
  if (proxyDefault) return proxyDefault
  const manual = status?.selectionMode === 'manual' && status.selected
  return {
    enabled: legacyCountry !== undefined && Boolean(status?.enabled) && legacyCountry !== 'CN',
    mode: manual ? 'manual' : 'auto',
    ...(manual ? { node: status.selected } : {})
  }
}

/**
 * 网络加速 for one window or proxy, the same choices as Settings → 网络加速: on or off, the fastest
 * node or a fixed one, picked from the nodes added there.
 */
export function TunnelRouteField({ value, onChange, status, disabledReason }: {
  value: TunnelRoute
  onChange: (route: TunnelRoute) => void
  status?: TunnelStatus
  /** Shown instead of the choices when this proxy cannot use the tunnel (an HTTPS proxy). */
  disabledReason?: string
}) {
  if (disabledReason) {
    return (
      <div className="fb-tunnel-route">
        <div className="fb-tunnel-route-line">
          <Switch checked={false} disabled />
          <span className="fb-muted">{disabledReason}</span>
        </div>
      </div>
    )
  }
  const [stateClass, stateLabel] = TUNNEL_STATE_PILL[status?.state ?? 'off']
  const running = status?.state === 'running'
  const nodes = status?.nodes ?? []
  const options = nodes.map((node) => ({
    value: node.name,
    search: node.name,
    label: (
      <span className="fb-tunnel-node-option">
        <span className="fb-ellipsis" title={node.name}>{node.name}</span>
        <span className="fb-tunnel-node-meta">{node.exitIp && <span className="fb-mono fb-muted">{node.exitIp}</span>}<DelayText delay={node.delay} /></span>
      </span>
    )
  }))
  // A node chosen earlier stays visible: the tunnel may be off, or the node gone after an edit.
  if (value.node && !nodes.some((node) => node.name === value.node)) {
    options.unshift({
      value: value.node,
      search: value.node,
      label: <span className="fb-tunnel-node-option"><span className="fb-ellipsis">{value.node}</span>{running && <span className="fb-tunnel-delay is-bad">{t("已不存在")}</span>}</span>
    })
  }
  return (
    <div className="fb-tunnel-route">
      <div className="fb-tunnel-route-line">
        <Switch checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
        <span className={value.enabled ? undefined : 'fb-muted'}>{value.enabled ? t("连接代理时先经过你的加速节点") : t("直接连接代理")}</span>
        <span className={`fb-tunnel-state ${stateClass}`}><i />{t("加速通道")} · {t(stateLabel)}</span>
      </div>
      {value.enabled && (
        <>
          <Radio.Group
            size="small"
            optionType="button"
            value={value.mode}
            onChange={(event) => {
              const mode = event.target.value as TunnelRoute['mode']
              const node = mode === 'manual' ? value.node ?? (running ? status?.selected : undefined) : value.node
              onChange({ ...value, mode, ...(node ? { node } : {}) })
            }}
            options={[
              { value: 'auto', label: <><ThunderboltOutlined /> {t("自动选择最低延迟")}</> },
              { value: 'manual', label: t("手动固定") }
            ]}
          />
          {value.mode === 'manual' && (
            <Select
              showSearch
              className="fb-wide-select"
              placeholder={t("选择加速节点")}
              value={value.node}
              optionFilterProp="search"
              status={value.node ? undefined : 'error'}
              notFoundContent={t("加速通道开启后才能列出节点")}
              onChange={(node: string) => onChange({ ...value, node })}
              options={options}
            />
          )}
          <span className="fb-form-hint">
            {value.mode === 'manual'
              ? t("一直用所选节点连接代理；节点在 设置 → 网络加速 里添加")
              : t("每 5 分钟测速，自动用延迟最低的节点")}
          </span>
          {status && !running && (
            <span className="fb-proxy-result bad">{t("加速通道没有运行，这个代理会获取不到 IP；请到 设置 → 网络加速 开启")}</span>
          )}
        </>
      )}
    </div>
  )
}
