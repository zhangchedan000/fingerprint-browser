import { Button, Empty, Spin, Table, Tabs, type TableColumnsType } from 'antd'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { t } from '../../../shared/i18n'

export interface ListTab {
  key: string
  label: string
  count?: number
  /** 'danger' shows the tab in the danger colour (e.g. "needs attention"). */
  tone?: 'danger'
}

export interface ListSelection {
  ids: string[]
  onChange: (ids: string[]) => void
  /** "已选 3 个窗口" — each page names its own records. */
  label: (count: number) => string
  /** Buttons shown in the batch bar while something is selected. */
  actions: ReactNode
}

export interface ListPageProps<T extends { id: string }> {
  /** Buttons on the left of the toolbar. */
  toolbar: ReactNode
  /** Filters and search on the right of the toolbar. */
  filters?: ReactNode
  /** Shown between the toolbar and the tabs (summary cards, alerts). */
  header?: ReactNode
  tabs?: ListTab[]
  activeTab?: string
  onTabChange?: (key: string) => void
  selection?: ListSelection
  columns: TableColumnsType<T>
  rows: T[]
  loading?: boolean
  /** What an empty list says; emptyAction is offered only when nothing exists at all. */
  emptyText: string
  emptyAction?: ReactNode
  /** Width the table scrolls at. */
  scrollX?: number
}

/**
 * The list template every management page uses: toolbar, tabs, batch bar, table and paging.
 * A page only supplies its columns, buttons and filters.
 */
export function ListPage<T extends { id: string }>({
  toolbar, filters, header, tabs, activeTab, onTabChange, selection, columns, rows, loading, emptyText, emptyAction, scrollX
}: ListPageProps<T>) {
  const [pageSize, setPageSize] = useState(20)
  const selected = new Set(selection?.ids ?? [])
  return (
    <>
      <div className="fb-toolbar">
        {toolbar}
        {filters && <div className="fb-toolbar-filters">{filters}</div>}
      </div>
      {header}
      {tabs && (
        <Tabs
          className="fb-tabs"
          activeKey={activeTab}
          onChange={onTabChange}
          items={tabs.map((tab) => ({
            key: tab.key,
            label: tab.tone === 'danger'
              ? <span className="fb-attention">{tab.label} {tab.count ?? ''}</span>
              : <>{tab.label}{tab.count !== undefined && <> <span className="fb-muted">{tab.count}</span></>}</>
          }))}
        />
      )}
      {selection && selection.ids.length > 0 && (
        <div className="fb-batch-bar" role="toolbar" aria-label={t("批量操作")}>
          <span>{selection.label(selection.ids.length)}</span>
          {selection.actions}
          <Button size="small" type="link" className="fb-batch-clear" onClick={() => selection.onChange([])}>{t("取消选择")}</Button>
        </div>
      )}
      <section className="fb-table-panel">
        <Spin spinning={Boolean(loading)}>
          <Table<T>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={rows}
            rowClassName={(row) => selected.has(row.id) ? 'fb-row-selected' : ''}
            rowSelection={selection && {
              selectedRowKeys: selection.ids,
              preserveSelectedRowKeys: true,
              onChange: (keys) => selection.onChange(keys.map(String))
            }}
            pagination={{
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              onShowSizeChange: (_current, size) => setPageSize(size),
              showTotal: (total) => t("共 {0} 条", total),
              hideOnSinglePage: false
            }}
            scroll={scrollX ? { x: scrollX } : undefined}
            locale={{ emptyText: <Empty description={emptyText}>{emptyAction}</Empty> }}
          />
        </Spin>
      </section>
    </>
  )
}
