import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Button, Empty, Input, Modal, Space, Tooltip, type TableColumnsType } from 'antd'
import { useMemo, useState } from 'react'
import { t } from '../../../../shared/i18n'
import type { BrowserProfileView, GroupDraft } from '../../../../shared/types'
import { ACTIVE_STATUSES } from '../../components/format'
import { ListPage } from '../../components/ListPage'
import { PickWindowsModal } from '../../components/PickWindowsModal'
import { proxyAddress } from '../../components/proxy'
import { StatusDot } from '../../components/StatusDot'
import { useWindowLauncher } from '../../data/window-actions'
import { useWorkspace } from '../../data/workspace'
import type { PageProps } from '../registry'
import { GroupFormModal } from './GroupFormModal'

/** A row of the group list; the built-in "未分组" row has groupId ''. */
interface GroupRow {
  id: string
  groupId: string
  name: string
  color?: string
  note: string
  windows: BrowserProfileView[]
  running: number
  system: boolean
}

const UNGROUPED = '__ungrouped__'
const MEMBER_PREVIEW = 50

function windowAddress(window: BrowserProfileView): string {
  if (window.proxyMissing) return t("代理已删除")
  if (window.proxy.protocol === 'direct') return t("直连")
  return window.proxyCheck?.ok && window.proxyCheck.ip ? window.proxyCheck.ip : proxyAddress(window.proxy)
}

/** Group management (design: Groups.dc.html). Windows refer to groups by id. */
export function GroupsPage({ navigate }: PageProps) {
  const ws = useWorkspace()
  const { profiles, groups, notify } = ws
  const { openMany } = useWindowLauncher()
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string>()
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [moveOpen, setMoveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)

  const rows = useMemo<GroupRow[]>(() => {
    const row = (groupId: string, name: string, note: string, color: string | undefined, system: boolean): GroupRow => {
      const windows = profiles.filter((profile) => profile.groupId === groupId)
      return { id: system ? UNGROUPED : groupId, groupId, name, note, color, windows, running: windows.filter((window) => ACTIVE_STATUSES.has(window.status)).length, system }
    }
    return [
      ...groups.map((group) => row(group.id, group.name, group.note, group.color, false)),
      row('', t("未分组"), t("系统默认"), undefined, true)
    ]
  }, [groups, profiles])

  const visible = rows.filter((row) => !query.trim() || row.name.toLowerCase().includes(query.trim().toLowerCase()))
  const active = rows.find((row) => row.id === activeId) ?? rows[0]
  const editing = groups.find((group) => group.id === editingId)

  async function save(draft: GroupDraft): Promise<void> {
    setBusy(true)
    try {
      if (editing) await window.browserApi.groups.update(editing.id, draft)
      else setActiveId((await window.browserApi.groups.create(draft)).id)
      await Promise.all([ws.reloadLibraries(), ws.reloadProfiles()])
      setFormOpen(false)
      notify.success(editing ? t("分组已更新") : t("分组已创建"))
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  function confirmRemove(row: GroupRow): void {
    Modal.confirm({
      title: t("删除分组“{0}”？", row.name),
      content: t("删除分组不会删除窗口，窗口会移到“未分组”。"),
      okText: t("删除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          await window.browserApi.groups.remove(row.groupId)
          await Promise.all([ws.reloadLibraries(), ws.reloadProfiles()])
          if (activeId === row.id) setActiveId(undefined)
          notify.success(t("分组已删除"))
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  /** Moving windows in or out is the same assignment as anywhere else: point groupId somewhere. */
  async function assign(ids: string[], groupId: string): Promise<void> {
    setBusy(true)
    try {
      ws.upsertProfiles(await window.browserApi.profiles.assignMany(ids, { groupId }))
      setMoveOpen(false)
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function openGroup(row: GroupRow): Promise<void> {
    setOpening(true)
    try {
      const result = await openMany(row.windows.filter((window) => ws.canLaunch(window)))
      if (!result.total) notify.info(t("本组没有可打开的窗口"))
      else if (result.errors.length) notify.warning(t("完成 {0} 个，失败 {1} 个", result.succeeded, result.errors.length))
      else notify.success(t("已启动 {0} 个环境", result.total))
    } finally {
      setOpening(false)
    }
  }

  const columns: TableColumnsType<GroupRow> = [
    {
      title: t("分组名称"),
      key: 'name',
      render: (_value, row) => (
        <div className="fb-group-name">
          <span className={`fb-dot${row.system ? ' is-system' : ''}`} style={row.color ? { background: row.color } : undefined} />
          <strong>{row.name}</strong>
        </div>
      )
    },
    { title: t("窗口数"), key: 'count', width: 90, sorter: (a, b) => a.windows.length - b.windows.length, render: (_value, row) => row.windows.length },
    { title: t("运行中"), key: 'running', width: 90, render: (_value, row) => <span className={row.running ? 'fb-good' : 'fb-muted'}>{row.running}</span> },
    { title: t("备注"), dataIndex: 'note', ellipsis: true, render: (note: string) => note || <span className="fb-muted">—</span> },
    {
      title: t("操作"),
      key: 'actions',
      width: 210,
      align: 'right',
      render: (_value, row) => (
        <Space size={2} onClick={(event) => event.stopPropagation()}>
          <Button size="small" type="link" autoInsertSpace={false} onClick={() => navigate('windows', { groupId: row.groupId })}>{t("查看窗口")}</Button>
          <Tooltip title={row.system ? t("系统默认分组不能修改") : undefined}>
            <Button size="small" type="link" autoInsertSpace={false} disabled={row.system} onClick={() => { setEditingId(row.groupId); setFormOpen(true) }}>{t("重命名")}</Button>
          </Tooltip>
          <Button size="small" type="link" danger autoInsertSpace={false} disabled={row.system} onClick={() => confirmRemove(row)}>{t("删除")}</Button>
        </Space>
      )
    }
  ]

  const preview = active ? [...active.windows].sort((a, b) => b.serialNumber - a.serialNumber).slice(0, MEMBER_PREVIEW) : []
  return (
    <div className="fb-split">
      <div className="fb-split-main">
        <ListPage<GroupRow>
          toolbar={<Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingId(undefined); setFormOpen(true) }}>{t("新建分组")}</Button>}
          filters={<Input allowClear prefix={<SearchOutlined />} placeholder={t("搜索分组名称")} value={query} onChange={(event) => setQuery(event.target.value)} className="search-input" />}
          columns={columns}
          rows={visible}
          loading={ws.loading}
          paginate={false}
          onRowClick={(row) => setActiveId(row.id)}
          activeRowId={active?.id}
          emptyText={t("没有符合条件的分组")}
          footnote={t("删除分组不会删除窗口，窗口会移到“未分组”。")}
        />
      </div>
      {active && (
        <aside className="fb-detail" aria-label={t("分组详情")}>
          <div className="fb-detail-head">
            <div className="fb-group-name">
              <span className={`fb-dot${active.system ? ' is-system' : ''}`} style={active.color ? { background: active.color } : undefined} />
              <strong>{active.name}</strong>
              <span className="fb-muted">{t("{0} 个窗口", active.windows.length)}</span>
            </div>
            {active.note && <span className="fb-muted">{active.note}</span>}
          </div>
          <div className="fb-detail-actions">
            <Button onClick={() => setMoveOpen(true)}>{t("从其他分组移入")}</Button>
            <Button loading={opening} disabled={!active.windows.length} onClick={() => void openGroup(active)}>{t("批量打开本组")}</Button>
          </div>
          {preview.length
            ? (
                <ul className="fb-member-list">
                  {preview.map((window) => (
                    <li key={window.id}>
                      <StatusDot status={window.status} error={window.lastError} />
                      <strong className="fb-ellipsis">{window.name}</strong>
                      <span className="fb-mono fb-muted">{windowAddress(window)}</span>
                      {!active.system && <Button size="small" type="link" autoInsertSpace={false} onClick={() => void assign([window.id], '')}>{t("移出")}</Button>}
                    </li>
                  ))}
                </ul>
              )
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("这个分组还没有窗口")} />}
          {active.windows.length > 0 && (
            <Button type="link" className="fb-detail-more" onClick={() => navigate('windows', { groupId: active.groupId })}>
              {t("查看全部 {0} 个 →", active.windows.length)}
            </Button>
          )}
        </aside>
      )}
      <GroupFormModal open={formOpen} group={editing} busy={busy} onSubmit={save} onClose={() => setFormOpen(false)} />
      <PickWindowsModal
        open={moveOpen}
        title={active ? t("移入“{0}”", active.name) : ''}
        windows={profiles.filter((profile) => profile.groupId !== active?.groupId)}
        detailTitle={t("代理 IP")}
        detail={(window) => <span className="fb-mono fb-muted">{windowAddress(window)}</span>}
        okText={t("移入")}
        busy={busy}
        onSubmit={(ids) => active && assign(ids, active.groupId)}
        onClose={() => setMoveOpen(false)}
      />
    </div>
  )
}
