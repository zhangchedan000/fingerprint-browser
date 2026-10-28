import { DownOutlined } from '@ant-design/icons'
import { Button, Dropdown, Empty, Spin, Table, Tabs, Tooltip, type TableColumnsType } from 'antd'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { t } from '../../../shared/i18n'
import { tableHeaderComponents, useTableColumns } from './table-columns'

export interface ListTab {
  key: string
  label: string
  count?: number
  /** 'danger' shows the tab in the danger colour (e.g. "needs attention"). */
  tone?: 'danger'
}

/** Something done to every ticked row. */
export interface BatchAction {
  key: string
  label: ReactNode
  icon?: ReactNode
  danger?: boolean
  /** Not possible for the rows ticked now (it is always off while none are). */
  disabled?: boolean
  loading?: boolean
  onClick: () => void
}

export interface ListSelection {
  ids: string[]
  onChange: (ids: string[]) => void
  /** "已选 3 个窗口" — each page names its own records. */
  label: (count: number) => string
  /** The batch actions used most: buttons always in the toolbar, greyed until rows are ticked. */
  buttons?: BatchAction[]
  /** The others, in the 批量操作 menu beside them. */
  menu?: BatchAction[]
  /** Said on the greyed buttons, e.g. "先勾选窗口". */
  hint: string
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
  /** Width the table scrolls at; 'content': as wide as its columns need, scrolling only when the page is narrower. */
  scrollX?: number | 'content'
  /** Clicking a row selects it for a detail panel. */
  onRowClick?: (row: T) => void
  activeRowId?: string
  /** Small print under the table. */
  footnote?: ReactNode
  /** Rows per page; false shows all rows. */
  paginate?: boolean
}

/**
 * The list template every management page uses: toolbar, tabs, batch bar, table and paging.
 * A page only supplies its columns, buttons and filters.
 */
export function ListPage<T extends { id: string }>({
  toolbar, filters, header, tabs, activeTab, onTabChange, selection, columns, rows, loading, emptyText, emptyAction, scrollX,
  onRowClick, activeRowId, footnote, paginate = true
}: ListPageProps<T>) {
  const [pageSize, setPageSize] = useState(20)
  const table = useTableColumns(columns, scrollX === 'content' ? undefined : scrollX)
  const selected = new Set(selection?.ids ?? [])
  return (
    <>
      <div className="fb-toolbar">
        {toolbar}
        {selection && <BatchActions selection={selection} />}
        <div className="fb-toolbar-filters">{filters}{table.settings}</div>
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
      <section className="fb-table-panel">
        <Spin spinning={Boolean(loading)}>
          <Table<T>
            rowKey="id"
            size="middle"
            columns={table.columns}
            components={tableHeaderComponents}
            tableLayout={table.tableLayout}
            dataSource={rows}
            rowClassName={(row) => [
              selected.has(row.id) || row.id === activeRowId ? 'fb-row-selected' : '',
              onRowClick ? 'fb-row-clickable' : ''
            ].filter(Boolean).join(' ')}
            onRow={onRowClick && ((row) => ({ onClick: () => onRowClick(row) }))}
            rowSelection={selection && {
              selectedRowKeys: selection.ids,
              preserveSelectedRowKeys: true,
              onChange: (keys) => selection.onChange(keys.map(String))
            }}
            pagination={paginate && {
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              onShowSizeChange: (_current, size) => setPageSize(size),
              showTotal: (total) => selection?.ids.length ? t("共 {0} 条 · 已选 {1}", total, selection.ids.length) : t("共 {0} 条", total),
              hideOnSinglePage: false
            }}
            scroll={table.scrollX ? { x: table.scrollX } : scrollX === 'content' ? { x: 'max-content' } : undefined}
            locale={{ emptyText: <Empty className="fb-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText}>{emptyAction}</Empty> }}
          />
        </Spin>
      </section>
      {footnote && <p className="fb-footnote">{footnote}</p>}
    </>
  )
}

/**
 * Batch actions in a fixed place in the toolbar: always shown, greyed while no row is ticked, so
 * nothing appears or moves when rows are ticked. The count of ticked rows rides on the menu button.
 */
function BatchActions({ selection }: { selection: ListSelection }) {
  const count = selection.ids.length
  const none = count === 0
  const badge = count ? <span className="fb-batch-count">{count}</span> : null
  const menu = selection.menu ?? []
  const buttons = selection.buttons ?? []
  if (!buttons.length && !menu.length) return null
  return (
    <div className="fb-batch-group" role="group" aria-label={t("批量操作")}>
      {buttons.map((action, index) => (
        <Tooltip key={action.key} title={none ? selection.hint : undefined}>
          <Button icon={action.icon} danger={action.danger} disabled={none || action.disabled} loading={action.loading} onClick={action.onClick}>
            {action.label}{!menu.length && index === 0 && badge}
          </Button>
        </Tooltip>
      ))}
      {menu.length > 0 && (
        <Tooltip title={none ? selection.hint : undefined}>
          <Dropdown
            disabled={none}
            trigger={['click']}
            menu={{
              items: [
                { type: 'group', label: selection.label(count), children: menu.map((action) => ({ key: action.key, icon: action.icon, danger: action.danger, disabled: action.disabled || action.loading, label: action.label })) },
                { type: 'divider' },
                { key: '__clear', label: t("取消选择") }
              ],
              onClick: ({ key }) => key === '__clear' ? selection.onChange([]) : menu.find((action) => action.key === key)?.onClick()
            }}
          >
            <Button className="fb-batch-menu" disabled={none} loading={menu.some((action) => action.loading)}>
              {t("批量操作")}{badge}<DownOutlined className="fb-button-caret" />
            </Button>
          </Dropdown>
        </Tooltip>
      )}
    </div>
  )
}
