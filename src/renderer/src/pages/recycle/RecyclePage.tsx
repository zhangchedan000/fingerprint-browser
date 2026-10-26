import { DeleteOutlined, UndoOutlined } from '@ant-design/icons'
import { Button, Modal, Select, Space, type TableColumnsType } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { t } from '../../../../shared/i18n'
import type { AppSettings, DeletedProfileSummary } from '../../../../shared/types'
import { formatBytes } from '../../components/format'
import { ListPage } from '../../components/ListPage'
import { useWorkspace } from '../../data/workspace'
import { daysLeft } from './retention'

type Retention = AppSettings['recycleRetentionDays']
type TrashRow = DeletedProfileSummary & { id: string }

/** Recycle bin (design: Recycle.dc.html). Deleted windows keep their cookies and cache here. */
export function RecyclePage() {
  const ws = useWorkspace()
  const { notify, locale } = ws
  const [items, setItems] = useState<DeletedProfileSummary[]>([])
  const [retention, setRetention] = useState<Retention>(0)
  const [loading, setLoading] = useState(true)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [trash, days] = await Promise.all([window.browserApi.profiles.trash(), window.browserApi.profiles.recycleRetention()])
      setItems(trash)
      setRetention(days)
    } catch (error) {
      ws.fail(error)
    } finally {
      setLoading(false)
    }
  }, [ws.fail])

  useEffect(() => { void refresh() }, [refresh])

  async function restore(ids: string[]): Promise<void> {
    setBusy('restore')
    let restored = 0
    try {
      for (const trashId of ids) {
        ws.upsertProfiles([await window.browserApi.profiles.restore(trashId)])
        restored += 1
      }
      notify.success(t("已恢复 {0} 个窗口", restored))
    } catch (error) {
      ws.fail(error)
    } finally {
      setSelectedIds([])
      setBusy(null)
      await refresh()
    }
  }

  function confirmPurge(item: DeletedProfileSummary): void {
    Modal.confirm({
      title: t("彻底删除“{0}”？", item.name),
      content: t("窗口的 Cookie、缓存和浏览数据会一起删除，无法恢复。"),
      okText: t("彻底删除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          await window.browserApi.profiles.purgeTrash(item.trashId)
          notify.success(t("“{0}”已永久删除", item.name))
          await refresh()
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  function confirmEmpty(): void {
    Modal.confirm({
      title: t("清空回收站？"),
      content: t("{0} 个窗口及其浏览数据会被永久删除，无法恢复。", items.length),
      okText: t("清空"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          const count = await window.browserApi.profiles.emptyTrash()
          notify.success(t("已永久删除 {0} 个环境", count))
          await refresh()
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  async function changeRetention(days: Retention): Promise<void> {
    try {
      setRetention(await window.browserApi.profiles.setRecycleRetention(days))
      await refresh()
    } catch (error) {
      ws.fail(error)
    }
  }

  const columns: TableColumnsType<TrashRow> = [
    {
      title: t("窗口名称"),
      dataIndex: 'name',
      render: (name: string, item) => <span><strong>{name}</strong>{item.serialNumber !== undefined && <span className="fb-muted"> #{item.serialNumber}</span>}</span>
    },
    { title: t("原分组"), dataIndex: 'group', width: 160, render: (group?: string) => group || <span className="fb-muted">{t("未分组")}</span> },
    { title: t("数据大小"), dataIndex: 'sizeBytes', width: 120, sorter: (a, b) => a.sizeBytes - b.sizeBytes, render: (bytes: number) => formatBytes(bytes) },
    {
      title: t("删除时间"),
      dataIndex: 'deletedAt',
      width: 160,
      sorter: (a, b) => a.deletedAt.localeCompare(b.deletedAt),
      render: (value: string) => new Date(value).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    },
    {
      title: t("剩余"),
      key: 'left',
      width: 100,
      render: (_value, item) => {
        const left = daysLeft(item.deletedAt, retention)
        return left === undefined ? <span className="fb-muted">{t("长期保留")}</span> : <span className={left <= 3 ? 'fb-bad' : 'fb-muted'}>{t("{0} 天", left)}</span>
      }
    },
    {
      title: t("操作"),
      key: 'actions',
      width: 170,
      align: 'right',
      render: (_value, item) => (
        <Space size={2}>
          <Button size="small" type="link" autoInsertSpace={false} loading={busy === 'restore'} onClick={() => void restore([item.trashId])}>{t("恢复")}</Button>
          <Button size="small" type="link" danger autoInsertSpace={false} onClick={() => confirmPurge(item)}>{t("彻底删除")}</Button>
        </Space>
      )
    }
  ]

  return (
    <ListPage<TrashRow>
      toolbar={(
        <>
          <Button type="primary" icon={<UndoOutlined />} disabled={!selectedIds.length} loading={busy === 'restore'} onClick={() => void restore(selectedIds)}>{t("恢复所选")}</Button>
          <Button danger icon={<DeleteOutlined />} disabled={!items.length} onClick={confirmEmpty}>{t("清空回收站")}</Button>
        </>
      )}
      filters={(
        <label className="fb-inline-fields fb-no-margin">
          <span>{t("自动彻底删除")}</span>
          <Select<Retention>
            value={retention}
            onChange={(days) => void changeRetention(days)}
            className="fb-filter-select"
            options={[
              { value: 7, label: t("{0} 天后", 7) },
              { value: 30, label: t("{0} 天后", 30) },
              { value: 90, label: t("{0} 天后", 90) },
              { value: 0, label: t("从不") }
            ]}
          />
        </label>
      )}
      selection={{
        ids: selectedIds,
        onChange: setSelectedIds,
        label: (count) => t("已选 {0} 个窗口", count),
        actions: <Button size="small" type="link" onClick={() => void restore(selectedIds)}>{t("恢复")}</Button>
      }}
      columns={columns}
      rows={items.map((item) => ({ ...item, id: item.trashId }))}
      loading={loading}
      emptyText={t("回收站是空的")}
      footnote={t("恢复的窗口回到原分组；原分组已删除时放入“未分组”。")}
    />
  )
}
