import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Select, Space, Tooltip, type TableColumnsType } from 'antd'
import { useMemo, useState } from 'react'
import { t } from '../../../../shared/i18n'
import type { ProxyDraft, ProxyRecordView } from '../../../../shared/types'
import { AssignModal } from '../../components/AssignModal'
import { humanError, relativeTime } from '../../components/format'
import { ListPage } from '../../components/ListPage'
import { proxyAddress, proxyLabel } from '../../components/proxy'
import { StatCards } from '../../components/StatCards'
import { useWorkspace } from '../../data/workspace'
import { AssignWindowsModal, type AssignMode } from './AssignWindowsModal'
import { ProxyFormModal } from './ProxyFormModal'
import { ProxyImportModal } from './ProxyImportModal'

type ProxyState = 'ok' | 'bad' | 'unknown'

export function proxyState(proxy: Pick<ProxyRecordView, 'check'>): ProxyState {
  return !proxy.check ? 'unknown' : proxy.check.ok ? 'ok' : 'bad'
}

export function proxiesSubtitle(): string {
  return t("统一管理代理，新建窗口时直接选用")
}

const ALL = '__all__'

/** Proxy library (design: Proxy.dc.html). Windows refer to these proxies by id. */
export function ProxiesPage() {
  const ws = useWorkspace()
  const { proxies, profiles, notify, locale } = ws
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState(ALL)
  const [countryFilter, setCountryFilter] = useState(ALL)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<ProxyRecordView | undefined>()
  const [formOpen, setFormOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [assign, setAssign] = useState<{ proxies: ProxyRecordView[]; mode: AssignMode } | null>(null)
  const [removing, setRemoving] = useState<ProxyRecordView | undefined>()

  const windowName = new Map(profiles.map((profile) => [profile.id, profile.name]))
  const countries = [...new Set(proxies.map((proxy) => proxy.check?.ok ? proxy.check.countryCode : undefined).filter((code): code is string => Boolean(code)))].sort()
  const stats = {
    total: proxies.length,
    ok: proxies.filter((proxy) => proxyState(proxy) === 'ok').length,
    bad: proxies.filter((proxy) => proxyState(proxy) === 'bad').length,
    unknown: proxies.filter((proxy) => proxyState(proxy) === 'unknown').length
  }

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return proxies.filter((proxy) => {
      if (typeFilter !== ALL && proxy.protocol !== typeFilter) return false
      if (countryFilter !== ALL && proxy.check?.countryCode !== countryFilter) return false
      if (!normalized) return true
      return [proxyAddress(proxy), proxy.username, proxy.note, proxy.check?.ip ?? ''].some((value) => value.toLowerCase().includes(normalized))
    })
  }, [proxies, query, typeFilter, countryFilter])

  async function check(ids: string[]): Promise<void> {
    if (!ids.length) return
    setChecking((current) => new Set([...current, ...ids]))
    let ok = 0
    let failed = 0
    try {
      for (let index = 0; index < ids.length; index += 5) {
        await Promise.all(ids.slice(index, index + 5).map(async (id) => {
          try {
            const result = await window.browserApi.proxy.check(id)
            if (result.check?.ok) ok += 1
            else failed += 1
          } catch {
            failed += 1
          } finally {
            setChecking((current) => {
              const next = new Set(current)
              next.delete(id)
              return next
            })
          }
        }))
      }
      await ws.reloadLibraries()
      // Windows using these proxies show the new result too.
      await ws.reloadProfiles()
      notify.success(t("检测完成：可用 {0}，失败 {1}", ok, failed))
    } catch (error) {
      ws.fail(error)
    }
  }

  async function save(draft: ProxyDraft): Promise<void> {
    setBusy(true)
    try {
      if (editing) await window.browserApi.proxy.update(editing.id, draft)
      else await window.browserApi.proxy.create(draft)
      await Promise.all([ws.reloadLibraries(), ws.reloadProfiles()])
      setFormOpen(false)
      notify.success(editing ? t("代理已更新") : t("代理已添加"))
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function importMany(drafts: ProxyDraft[]): Promise<void> {
    setBusy(true)
    try {
      const result = await window.browserApi.proxy.createMany(drafts)
      await ws.reloadLibraries()
      setImportOpen(false)
      notify.success(t("已导入 {0} 个代理，跳过重复 {1} 个，失败 {2} 个", result.created.length, result.duplicates, result.errors.length))
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function remove(proxy: ProxyRecordView, replaceWith?: string): Promise<void> {
    setBusy(true)
    try {
      await window.browserApi.proxy.remove(proxy.id, replaceWith)
      await Promise.all([ws.reloadLibraries(), ws.reloadProfiles()])
      setSelectedIds((current) => current.filter((id) => id !== proxy.id))
      setRemoving(undefined)
      notify.success(t("代理已删除"))
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  function confirmRemove(proxy: ProxyRecordView): void {
    // A proxy in use needs a replacement first; that is asked in the assign dialog.
    if (proxy.profileIds.length) {
      setRemoving(proxy)
      return
    }
    Modal.confirm({
      title: t("删除代理 {0}？", proxyAddress(proxy)),
      okText: t("删除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: () => remove(proxy)
    })
  }

  function removeFailed(): void {
    const failed = proxies.filter((proxy) => proxyState(proxy) === 'bad')
    const unused = failed.filter((proxy) => !proxy.profileIds.length)
    if (!failed.length) {
      notify.info(t("没有检测失败的代理"))
      return
    }
    Modal.confirm({
      title: t("删除 {0} 个失效代理？", unused.length),
      content: unused.length < failed.length ? t("另有 {0} 个失效代理正在被窗口使用，不会删除，请先给这些窗口换代理。", failed.length - unused.length) : undefined,
      okText: t("删除"),
      okButtonProps: { danger: true, disabled: !unused.length },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          for (const proxy of unused) await window.browserApi.proxy.remove(proxy.id)
          await ws.reloadLibraries()
          notify.success(t("已删除 {0} 个失效代理", unused.length))
        } catch (error) {
          notify.error(humanError(error))
        }
      }
    })
  }

  const columns: TableColumnsType<ProxyRecordView> = [
    {
      title: t("代理地址"),
      key: 'address',
      width: 210,
      sorter: (a, b) => proxyAddress(a).localeCompare(proxyAddress(b), undefined, { numeric: true }),
      render: (_value, proxy) => (
        <div className="fb-two-line">
          <span className="fb-mono">{proxy.apiUrl ? t("API 提取") : proxyAddress(proxy)}</span>
          <small className="fb-ellipsis" title={proxy.apiUrl}>{proxy.apiUrl ? `${t("上次")} ${proxyAddress(proxy)}${proxy.note ? ` · ${proxy.note}` : ''}` : proxy.note || proxy.username || '—'}</small>
        </div>
      )
    },
    { title: t("类型"), dataIndex: 'protocol', width: 90, render: (protocol: string, proxy) => proxy.apiUrl ? `API · ${protocol.toUpperCase()}` : protocol.toUpperCase() },
    {
      title: t("出口 IP / 地区"),
      key: 'exit',
      width: 190,
      render: (_value, proxy) => (
        <div className="fb-proxy-cell">
          <div>
            <span className={`fb-cc${proxy.check?.ok && proxy.check.countryCode ? '' : ' muted'}`}>{proxy.check?.ok && proxy.check.countryCode ? proxy.check.countryCode : '—'}</span>
            <span className="fb-mono">{proxy.check?.ok && proxy.check.ip ? proxy.check.ip : '—'}</span>
          </div>
          <small className="fb-ellipsis">{proxy.check?.ok ? [proxy.check.country, proxy.check.city].filter(Boolean).join(' · ') || '—' : '—'}</small>
        </div>
      )
    },
    {
      title: t("延迟"),
      key: 'latency',
      width: 90,
      sorter: (a, b) => (a.check?.ok ? a.check.latencyMs : Infinity) - (b.check?.ok ? b.check.latencyMs : Infinity),
      render: (_value, proxy) => {
        if (!proxy.check?.ok) return <span className="fb-muted">—</span>
        const ms = proxy.check.latencyMs
        return <span className={ms < 250 ? 'fb-good' : ms < 600 ? 'fb-warn' : 'fb-bad'}>{ms} ms</span>
      }
    },
    {
      title: t("状态"),
      key: 'state',
      width: 90,
      render: (_value, proxy) => {
        const state = proxyState(proxy)
        const label = { ok: t("可用"), bad: t("失效"), unknown: t("未检测") }[state]
        return <span className={`fb-badge is-${state}`}>{label}</span>
      }
    },
    {
      title: t("绑定窗口"),
      key: 'windows',
      width: 160,
      sorter: (a, b) => a.profileIds.length - b.profileIds.length,
      render: (_value, proxy) => proxy.profileIds.length
        ? (
            <div className="fb-two-line">
              <span className="fb-ellipsis">{windowName.get(proxy.profileIds[0])}</span>
              {proxy.profileIds.length > 1 && (
                <Tooltip title={proxy.profileIds.slice(1).map((id) => windowName.get(id)).join(', ')}>
                  <small className="fb-proxy-warn">{t("+{0} 个窗口", proxy.profileIds.length - 1)}</small>
                </Tooltip>
              )}
            </div>
          )
        : <span className="fb-muted">{t("未绑定")}</span>
    },
    {
      title: t("最后检测"),
      key: 'checked',
      width: 110,
      render: (_value, proxy) => <span className="fb-muted">{relativeTime(proxy.check?.checkedAt, locale, t("从未"))}</span>
    },
    {
      title: t("操作"),
      key: 'actions',
      width: 230,
      fixed: 'right',
      align: 'right',
      render: (_value, proxy) => (
        <Space size={2}>
          <Button size="small" onClick={() => setAssign({ proxies: [proxy], mode: 'single' })}>{t("分配窗口")}</Button>
          <Button size="small" type="link" autoInsertSpace={false} loading={checking.has(proxy.id)} onClick={() => void check([proxy.id])}>{t("检测")}</Button>
          <Button size="small" type="link" autoInsertSpace={false} onClick={() => { setEditing(proxy); setFormOpen(true) }}>{t("编辑")}</Button>
          <Button size="small" type="link" danger autoInsertSpace={false} onClick={() => confirmRemove(proxy)}>{t("删除")}</Button>
        </Space>
      )
    }
  ]

  const selected = proxies.filter((proxy) => selectedIds.includes(proxy.id))
  return (
    <>
      <ListPage<ProxyRecordView>
        header={(
          <StatCards stats={[
            { label: t("代理总数"), value: stats.total },
            { label: t("可用"), value: stats.ok, tone: 'success' },
            { label: t("失效"), value: stats.bad, tone: 'danger' },
            { label: t("未检测"), value: stats.unknown, tone: 'warning' }
          ]} />
        )}
        toolbar={(
          <>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(undefined); setFormOpen(true) }}>{t("添加代理")}</Button>
            <Button onClick={() => setImportOpen(true)}>{t("批量导入")}</Button>
            <Tooltip title={selected.length ? undefined : t("先勾选要分配的代理")}>
              <Button disabled={!selected.length} onClick={() => setAssign({ proxies: selected, mode: 'batch' })}>{t("批量分配到窗口")}</Button>
            </Tooltip>
            <Button disabled={!proxies.length} loading={checking.size > 0} onClick={() => void check(proxies.map((proxy) => proxy.id))}>{t("全部检测")}</Button>
            <Button danger disabled={!stats.bad} onClick={removeFailed}>{t("删除失效代理")}</Button>
          </>
        )}
        filters={(
          <>
            <Select
              value={typeFilter}
              onChange={setTypeFilter}
              className="fb-filter-select"
              aria-label={t("按类型筛选")}
              options={[{ value: ALL, label: t("全部类型") }, { value: 'socks5', label: 'SOCKS5' }, { value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }]}
            />
            <Select
              value={countryFilter}
              onChange={setCountryFilter}
              className="fb-filter-select"
              aria-label={t("按国家筛选")}
              options={[{ value: ALL, label: t("全部国家") }, ...countries.map((code) => ({ value: code, label: code }))]}
            />
            <Input allowClear prefix={<SearchOutlined />} placeholder={t("搜索 IP / 备注")} value={query} onChange={(event) => setQuery(event.target.value)} className="search-input" />
          </>
        )}
        selection={{
          ids: selectedIds,
          onChange: setSelectedIds,
          label: (count) => t("已选 {0} 个代理", count),
          actions: (
            <>
              <Button size="small" type="link" onClick={() => setAssign({ proxies: selected, mode: selected.length === 1 ? 'single' : 'batch' })}>{t("分配到窗口")}</Button>
              <Button size="small" type="link" loading={checking.size > 0} onClick={() => void check(selectedIds)}>{t("检测")}</Button>
            </>
          )
        }}
        columns={columns}
        rows={visible}
        loading={ws.loading}
        scrollX={1180}
        emptyText={proxies.length ? t("没有符合条件的代理") : t("代理库还是空的")}
        emptyAction={!proxies.length && <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(undefined); setFormOpen(true) }}>{t("添加第一个代理")}</Button>}
      />
      <ProxyFormModal open={formOpen} proxy={editing} busy={busy} onSubmit={save} onClose={() => setFormOpen(false)} />
      <ProxyImportModal open={importOpen} busy={busy} onSubmit={importMany} onClose={() => setImportOpen(false)} />
      <AssignWindowsModal open={Boolean(assign)} proxies={assign?.proxies ?? []} initialMode={assign?.mode ?? 'single'} onClose={() => setAssign(null)} />
      <AssignModal
        open={Boolean(removing)}
        title={removing ? t("删除代理 {0}", proxyAddress(removing)) : ''}
        description={removing && (
          <Alert type="warning" showIcon title={t("有 {0} 个窗口正在使用这个代理，删除前请选择它们改用的代理。", removing.profileIds.length)} />
        )}
        options={proxies.filter((proxy) => proxy.id !== removing?.id).map((proxy) => ({ value: proxy.id, label: proxyLabel(proxy), search: `${proxyAddress(proxy)}\n${proxy.note}` }))}
        noneLabel={t("改为直连（不使用代理）")}
        placeholder={t("选择替换的代理")}
        busy={busy}
        onSubmit={(value) => removing && remove(removing, value)}
        onClose={() => setRemoving(undefined)}
      />
    </>
  )
}
