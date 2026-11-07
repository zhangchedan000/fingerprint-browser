import { ApiOutlined, ClearOutlined, DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Dropdown, Input, Modal, Space, Table, Tag, Tooltip, type TableColumnsType, type TableProps } from 'antd'
import { useMemo, useState } from 'react'
import { t } from '../../../../shared/i18n'
import type { ProxyRecordView, TunnelNodeInfo, TunnelSourceSummary, TunnelStatus } from '../../../../shared/types'
import { humanError, relativeTime } from '../../components/format'
import { StatCards } from '../../components/StatCards'
import { nodeShortName, SubscriptionModal, subscriptionNodes } from '../../components/subscriptions'
import { DelayText } from '../../components/TunnelRouteField'
import { useTableColumns } from '../../components/table-columns'
import { useWorkspace } from '../../data/workspace'

interface NodeRow {
  key: string
  source: TunnelSourceSummary
  node: TunnelNodeInfo
  short: string
  /** The node's library entry (once a window picked it or it was checked). */
  entry?: ProxyRecordView
}

/**
 * 代理 IP → 订阅: the account's subscriptions, any number of them, each with its nodes (exit IP,
 * delay, the windows on it). A window uses a node with 代理方式「订阅」.
 */
export function SubscriptionsSection({ status, setStatus }: { status: TunnelStatus | undefined; setStatus: (status: TunnelStatus) => void }) {
  const ws = useWorkspace()
  const { proxies, profiles, notify, locale } = ws
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<TunnelSourceSummary>()
  const [formOpen, setFormOpen] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const windowName = new Map(profiles.map((profile) => [profile.id, profile.name]))
  const sources = status?.sources ?? []

  const entryOf = (source: TunnelSourceSummary, short: string) =>
    proxies.find((item) => item.subscription?.source === source.name && item.subscription.node === short)
  const rowsOf = (source: TunnelSourceSummary): NodeRow[] => subscriptionNodes(status, source).map((node) => {
    const short = nodeShortName(source, node)
    return { key: node.name, source, node, short, entry: entryOf(source, short) }
  })
  const windowsOf = (source: TunnelSourceSummary) => [...new Set(proxies.filter((item) => item.subscription?.source === source.name).flatMap((item) => item.profileIds))]
  const allNodes = sources.flatMap(rowsOf)
  const nodeState = (row: NodeRow) => row.entry?.check ? (row.entry.check.ok ? 'ok' : 'bad') : row.node.delay === undefined ? 'unknown' : row.node.delay > 0 ? 'ok' : 'bad'
  const nodeIp = (row: NodeRow) => (row.entry?.check?.ok ? row.entry.check.ip : row.node.exitIp) ?? ''
  const nodeDelay = (row: NodeRow) => (row.entry?.check?.ok ? row.entry.check.latencyMs : row.node.delay) ?? 0
  const STATE_ORDER = { ok: 0, unknown: 1, bad: 2 }

  /**
   * Library entries of nodes no longer listed: the subscription was deleted, or its download no longer
   * has the node (renamed or removed). A subscription that has no nodes right now (download failed,
   * still starting) says nothing about its nodes: its entries are kept.
   */
  const staleEntries = status ? proxies.filter((item) => {
    const ref = item.subscription
    if (!ref) return false
    const source = sources.find((candidate) => candidate.name === ref.source)
    if (!source) return true
    const nodes = subscriptionNodes(status, source)
    return nodes.length > 0 && !nodes.some((node) => nodeShortName(source, node) === ref.node)
  }) : []

  function cleanStale(): void {
    const unused = staleEntries.filter((item) => !item.profileIds.length)
    const bound = staleEntries.length - unused.length
    Modal.confirm({
      title: t("清理 {0} 条旧节点记录？", unused.length),
      content: (
        <>
          <p>{t("这些节点所在的订阅已删除，或订阅里已经没有这个节点；记录里只有以前的检测结果。")}</p>
          {bound > 0 && <p>{t("另有 {0} 条绑定了窗口，不会删除，请先给这些窗口换节点。", bound)}</p>}
        </>
      ),
      okText: t("清理"),
      okButtonProps: { danger: true, disabled: !unused.length },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          const removed = await window.browserApi.proxy.removeUnused(unused.map((item) => item.id))
          await ws.reloadLibraries()
          notify.success(t("已清理 {0} 条旧节点记录", removed))
        } catch (error) {
          notify.error(humanError(error))
        }
      }
    })
  }

  const normalized = query.trim().toLowerCase()
  const matches = (row: NodeRow) => !normalized || [row.short, row.source.name, row.entry?.check?.ip ?? row.node.exitIp ?? ''].some((value) => value.toLowerCase().includes(normalized))
  const visibleSources = useMemo(() => sources.filter((source) => !normalized || source.name.toLowerCase().includes(normalized) || rowsOf(source).some(matches)),
    [sources, status, proxies, normalized])

  async function run(key: string, action: () => Promise<TunnelStatus>): Promise<void> {
    setBusy(key)
    try {
      setStatus(await action())
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(undefined)
    }
  }

  /** Checks nodes the way a library proxy is checked (exit IP, place, IP 评分): through their library entry. */
  async function check(rows: NodeRow[]): Promise<void> {
    if (!rows.length) return
    setChecking((current) => new Set([...current, ...rows.map((row) => row.key)]))
    let ok = 0
    let failed = 0
    for (let index = 0; index < rows.length; index += 4) {
      await Promise.all(rows.slice(index, index + 4).map(async (row) => {
        try {
          const entry = row.entry ?? await window.browserApi.subscriptions.nodeProxy({ source: row.source.name, node: row.short })
          const result = await window.browserApi.proxy.check(entry.id)
          if (result.check?.ok) ok += 1
          else failed += 1
        } catch {
          failed += 1
        } finally {
          setChecking((current) => {
            const next = new Set(current)
            next.delete(row.key)
            return next
          })
        }
      }))
    }
    await Promise.all([ws.reloadLibraries(), ws.reloadProfiles()])
    notify.success(t("检测完成：可用 {0}，失败 {1}", ok, failed))
  }

  function confirmRemove(source: TunnelSourceSummary): void {
    const users = windowsOf(source)
    Modal.confirm({
      title: t("删除订阅“{0}”？", source.name),
      content: users.length
        ? t("有 {0} 个窗口用着这个订阅的节点（{1}）；删除后这些窗口打开时会提示重新选择节点。", users.length, users.slice(0, 5).map((id) => windowName.get(id) ?? id).join('、'))
        : t("删除后其他电脑上也会删除（跟着账号同步）。"),
      okText: t("删除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: () => run(`remove-${source.id}`, () => window.browserApi.subscriptions.removeSource(source.id))
    })
  }

  const windowsCell = (ids: string[]) => ids.length
    ? <Tooltip title={ids.map((id) => windowName.get(id) ?? id).join('、')}><span>{windowName.get(ids[0]) ?? ids[0]}{ids.length > 1 ? <span className="fb-muted"> +{ids.length - 1}</span> : null}</span></Tooltip>
    : <span className="fb-muted">{t("未绑定")}</span>

  const nodeColumns: TableColumnsType<NodeRow> = [
    {
      title: t("节点名称"),
      key: 'name',
      width: 200,
      sorter: (a, b) => a.short.localeCompare(b.short, undefined, { numeric: true }),
      render: (_value, row) => <span className="fb-mono">{row.short}</span>
    },
    { title: t("协议"), key: 'type', width: 110, sorter: (a, b) => (a.node.type || '').localeCompare(b.node.type || ''), render: (_value, row) => row.node.type || '—' },
    {
      title: t("出口 IP / 地区"),
      key: 'ip',
      width: 220,
      sorter: (a, b) => `${a.entry?.check?.ok ? a.entry.check.countryCode ?? '' : ''} ${nodeIp(a)}`.localeCompare(`${b.entry?.check?.ok ? b.entry.check.countryCode ?? '' : ''} ${nodeIp(b)}`, undefined, { numeric: true }),
      render: (_value, row) => {
        const check = row.entry?.check
        const ip = check?.ok ? check.ip : row.node.exitIp
        return ip
          ? <div className="fb-proxy-cell"><div>{check?.ok && check.countryCode && <span className="fb-cc">{check.countryCode}</span>}<span className="fb-mono">{ip}</span></div>{check?.ok && <small>{[check.country, check.city].filter(Boolean).join(' · ')}</small>}</div>
          : <span className="fb-muted">{t("未检测")}</span>
      }
    },
    {
      title: t("延迟"),
      key: 'delay',
      width: 90,
      sorter: (a, b) => (nodeDelay(a) > 0 ? nodeDelay(a) : Infinity) - (nodeDelay(b) > 0 ? nodeDelay(b) : Infinity),
      render: (_value, row) => <DelayText delay={row.entry?.check?.ok ? row.entry.check.latencyMs : row.node.delay} />
    },
    {
      title: t("状态"),
      key: 'state',
      width: 90,
      sorter: (a, b) => STATE_ORDER[nodeState(a)] - STATE_ORDER[nodeState(b)],
      render: (_value, row) => {
        const state = nodeState(row)
        return <Tag color={state === 'ok' ? 'success' : state === 'bad' ? 'error' : 'default'}>{state === 'ok' ? t("可用") : state === 'bad' ? t("失效") : t("未检测")}</Tag>
      }
    },
    { title: t("绑定窗口"), key: 'windows', width: 160, sorter: (a, b) => (a.entry?.profileIds.length ?? 0) - (b.entry?.profileIds.length ?? 0), render: (_value, row) => windowsCell(row.entry?.profileIds ?? []) },
    {
      title: t("操作"),
      key: 'actions',
      width: 80,
      align: 'right',
      fixed: 'right',
      render: (_value, row) => <Button size="small" type="link" loading={checking.has(row.key)} onClick={() => void check([row])}>{t("检测")}</Button>
    }
  ]

  const columns: TableColumnsType<TunnelSourceSummary> = [
    { title: t("订阅名称"), dataIndex: 'name', key: 'name', width: 220, sorter: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }), render: (name: string) => <strong>{name}</strong> },
    { title: t("类型"), key: 'kind', width: 110, sorter: (a, b) => a.kind.localeCompare(b.kind), render: (_value, source) => source.kind === 'subscription' ? t("订阅链接") : t("节点链接") },
    { title: t("节点数"), key: 'nodes', width: 90, sorter: (a, b) => subscriptionNodes(status, a).length - subscriptionNodes(status, b).length, render: (_value, source) => subscriptionNodes(status, source).length },
    { title: t("绑定窗口"), key: 'windows', width: 180, sorter: (a, b) => windowsOf(a).length - windowsOf(b).length, render: (_value, source) => windowsCell(windowsOf(source)) },
    { title: t("最后更新"), key: 'updated', width: 120, sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt), render: (_value, source) => relativeTime(source.updatedAt, locale, '—') },
    {
      title: t("操作"),
      key: 'actions',
      width: 200,
      align: 'right',
      fixed: 'right',
      render: (_value, source) => (
        <Space size={2}>
          <Button size="small" type="link" loading={checking.size > 0 && rowsOf(source).some((row) => checking.has(row.key))} onClick={() => void check(rowsOf(source))}>{t("检测")}</Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => { setEditing(source); setFormOpen(true) }}>{t("编辑")}</Button>
          <Dropdown
            trigger={['click']}
            menu={{ items: [{ key: 'remove', icon: <DeleteOutlined />, danger: true, label: t("删除") }], onClick: () => confirmRemove(source) }}
          >
            <Button size="small" type="text" icon={<MoreOutlined />} aria-label={t("更多操作")} loading={busy === `remove-${source.id}`} />
          </Dropdown>
        </Space>
      )
    }
  ]

  const sourceTable = useTableColumns(columns, undefined, { settingsTitle: t("订阅列"), rowDrag: true })
  const nodeTable = useTableColumns(nodeColumns, undefined, { settingsTitle: t("节点列"), rowDrag: true })
  const shownSources = sourceTable.arrange(visibleSources)
  // Node rows are known by their key; the table's own order and columns go by an id.
  const nodesOf = (source: TunnelSourceSummary) => nodeTable.arrange(rowsOf(source).filter(matches).map((row) => ({ ...row, id: row.key })))

  return (
    <div className="fb-stack">
      <StatCards stats={[
        { label: t("订阅总数"), value: sources.length },
        { label: t("节点总数"), value: allNodes.length },
        { label: t("可用"), value: allNodes.filter((row) => nodeState(row) === 'ok').length, tone: 'success' },
        { label: t("失效"), value: allNodes.filter((row) => nodeState(row) === 'bad').length, tone: 'danger' }
      ]} />
      <div className="fb-toolbar">
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(undefined); setFormOpen(true) }}>{t("添加订阅")}</Button>
          <Button icon={<ReloadOutlined />} disabled={!sources.length} loading={busy === 'refresh'} onClick={() => void run('refresh', () => window.browserApi.subscriptions.refresh())}>{t("全部刷新")}</Button>
          <Button icon={<ApiOutlined />} disabled={!allNodes.length} loading={checking.size > 0} onClick={() => void check(allNodes)}>{t("全部检测")}</Button>
        </Space>
        <div className="fb-toolbar-filters">
          {staleEntries.length > 0 && (
            <Tooltip title={t("订阅已删除、或订阅里已经没有的节点留下的记录（只有以前的检测结果）")}>
              <Button icon={<ClearOutlined />} onClick={cleanStale}>{t("清理旧记录 {0}", staleEntries.length)}</Button>
            </Tooltip>
          )}
          <Input allowClear prefix={<SearchOutlined />} placeholder={t("搜索订阅 / 节点 / IP")} value={query} onChange={(event) => setQuery(event.target.value)} style={{ width: 240 }} />
          {sourceTable.settings}
          {nodeTable.settings}
        </div>
      </div>
      {status?.state === 'error' && status.error && <Alert type="error" showIcon title={status.error} />}
      <div className="fb-table-panel">
        <Table<TunnelSourceSummary>
          rowKey="id"
          size="middle"
          columns={sourceTable.columns}
          components={sourceTable.components}
          tableLayout={sourceTable.tableLayout}
          scroll={sourceTable.scrollX ? { x: sourceTable.scrollX } : undefined}
          dataSource={shownSources}
          onChange={sourceTable.onChange}
          onRow={(row) => sourceTable.rowProps(row, shownSources)}
          rowClassName={(row) => sourceTable.rowClass(row)}
          pagination={false}
          locale={{ emptyText: sources.length ? t("没有符合条件的订阅") : t("还没有订阅，可以添加多个，每个订阅里的节点都能给窗口用") }}
          expandable={{
            expandedRowRender: (source) => (
              <Table<NodeRow & { id: string }>
                rowKey="key"
                size="small"
                columns={nodeTable.columns as TableColumnsType<NodeRow & { id: string }>}
                components={nodeTable.components as TableProps<NodeRow & { id: string }>['components']}
                tableLayout={nodeTable.tableLayout}
                scroll={nodeTable.scrollX ? { x: nodeTable.scrollX } : undefined}
                dataSource={nodesOf(source)}
                onChange={nodeTable.onChange as TableProps<NodeRow & { id: string }>['onChange']}
                onRow={(row) => nodeTable.rowProps(row, nodesOf(source))}
                rowClassName={(row) => nodeTable.rowClass(row)}
                pagination={rowsOf(source).length > 50 ? { pageSize: 50 } : false}
                locale={{ emptyText: t("这个订阅还没有可用节点（刚添加时要等几秒，或点「全部刷新」）") }}
              />
            ),
            defaultExpandedRowKeys: sources.length === 1 ? [sources[0].id] : []
          }}
        />
      </div>
      <SubscriptionModal open={formOpen} editing={editing} onClose={() => setFormOpen(false)} onSaved={(next) => { setStatus(next); void ws.reloadLibraries() }} />
    </div>
  )
}
