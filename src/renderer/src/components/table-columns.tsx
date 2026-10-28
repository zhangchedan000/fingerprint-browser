import { HolderOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Checkbox, Popover, Tooltip, type TableColumnsType } from 'antd'
import { useMemo, useState, type DragEvent, type MouseEvent, type ReactNode, type ThHTMLAttributes } from 'react'
import { t } from '../../../shared/i18n'

/**
 * Columns the user arranges, per table and per computer: drag a header edge to change one
 * column's width (the others keep theirs), drag a header to move it, and hide columns in the
 * column settings. The checkbox column and pinned columns (fixed: left/right, e.g. 操作) stay put.
 */

const MIN_WIDTH = 56
const STORE_PREFIX = 'fb.columns.'
const OLD_WIDTHS_PREFIX = 'fb.columnWidths.'
const FILL_KEY = '__fill'
const FALLBACK_WIDTH = 140

interface Layout {
  widths: Record<string, number>
  order: string[]
  hidden: string[]
}

const EMPTY: Layout = { widths: {}, order: [], hidden: [] }

type Column<T> = TableColumnsType<T>[number]

function columnId(column: Column<never>, index: number): string {
  if (column.key !== undefined) return String(column.key)
  if ('dataIndex' in column && column.dataIndex !== undefined) return String(column.dataIndex)
  return String(index)
}

function isPinned(column: Column<never>): boolean {
  return column.fixed === 'left' || column.fixed === 'right' || column.fixed === true
}

/** The window name and similar: hiding it would leave rows nobody can tell apart. */
function isRequired(column: Column<never>): boolean {
  return 'dataIndex' in column && column.dataIndex === 'name'
}

function load(key: string): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_PREFIX + key) || 'null') as Partial<Layout> | null
    if (value && typeof value === 'object') {
      return { widths: value.widths ?? {}, order: value.order ?? [], hidden: value.hidden ?? [] }
    }
    // Widths saved by 0.5.8 – 0.5.11.
    const widths = JSON.parse(localStorage.getItem(OLD_WIDTHS_PREFIX + key) || 'null') as Record<string, number> | null
    if (widths && typeof widths === 'object') return { ...EMPTY, widths }
  } catch {
    // Unreadable: the default layout.
  }
  return EMPTY
}

function store(key: string, layout: Layout): void {
  try {
    const empty = !Object.keys(layout.widths).length && !layout.order.length && !layout.hidden.length
    if (empty) localStorage.removeItem(STORE_PREFIX + key)
    else localStorage.setItem(STORE_PREFIX + key, JSON.stringify(layout))
    localStorage.removeItem(OLD_WIDTHS_PREFIX + key)
  } catch {
    // A convenience; without storage the layout lasts until the page is left.
  }
}

interface HeaderCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  'data-col-id'?: string
  onResizeStart?: (widths: Record<string, number>) => void
  onResizeWidth?: (width: number) => void
  onResizeEnd?: () => void
  onResizeReset?: () => void
  onMove?: (from: string, before: boolean) => void
}

const DRAG_TYPE = 'application/x-fb-column'

/** A header cell with a width handle on its right edge; movable columns can be dragged by their title. */
function HeaderCell({ onResizeStart, onResizeWidth, onResizeEnd, onResizeReset, onMove, children, className, ...props }: HeaderCellProps) {
  const [drop, setDrop] = useState<'before' | 'after'>()
  if (!onResizeWidth) return <th className={className} {...props}>{children}</th>

  function startResize(event: MouseEvent<HTMLSpanElement>): void {
    // Also keeps the header from starting a column drag.
    event.preventDefault()
    event.stopPropagation()
    const cell = event.currentTarget.parentElement
    if (!cell || !onResizeWidth) return
    // Every column keeps the width it has on screen; only this one follows the mouse.
    const widths: Record<string, number> = {}
    cell.parentElement?.querySelectorAll<HTMLElement>('th[data-col-id]').forEach((th) => {
      widths[th.dataset.colId!] = Math.round(th.getBoundingClientRect().width)
    })
    onResizeStart?.(widths)
    const startX = event.clientX
    const startWidth = cell.getBoundingClientRect().width
    const resize = onResizeWidth
    document.body.classList.add('fb-col-resizing')
    const move = (moveEvent: globalThis.MouseEvent) => resize(Math.max(MIN_WIDTH, Math.round(startWidth + moveEvent.clientX - startX)))
    const stop = () => {
      document.body.classList.remove('fb-col-resizing')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
      onResizeEnd?.()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
  }

  const id = props['data-col-id']
  const dragProps = onMove && id ? {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLTableCellElement>) => {
      event.dataTransfer.setData(DRAG_TYPE, id)
      event.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (event: DragEvent<HTMLTableCellElement>) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
      event.preventDefault()
      const box = event.currentTarget.getBoundingClientRect()
      setDrop(event.clientX < box.left + box.width / 2 ? 'before' : 'after')
    },
    onDragLeave: () => setDrop(undefined),
    onDrop: (event: DragEvent<HTMLTableCellElement>) => {
      event.preventDefault()
      const from = event.dataTransfer.getData(DRAG_TYPE)
      setDrop(undefined)
      if (from && from !== id) onMove(from, drop !== 'after')
    }
  } : {}

  return (
    <th className={[className, onMove ? 'fb-col-movable' : '', drop ? `fb-col-drop-${drop}` : ''].filter(Boolean).join(' ')} {...props} {...dragProps}>
      {children}
      <span
        className="fb-col-resize"
        aria-hidden="true"
        draggable={false}
        onMouseDown={startResize}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => { event.stopPropagation(); onResizeReset?.() }}
      />
    </th>
  )
}

export const tableHeaderComponents = { header: { cell: HeaderCell } }

export interface TableColumnsResult<T> {
  columns: TableColumnsType<T>
  scrollX?: number
  /** Fixed layout once widths are set, so the other columns keep theirs. */
  tableLayout?: 'fixed'
  /** The 列设置 button. */
  settings: ReactNode
}

/** Each table is keyed by its column set, so pages need no names of their own. */
export function useTableColumns<T>(columns: TableColumnsType<T>, minScrollX?: number): TableColumnsResult<T> {
  const ids = columns.map((column, index) => columnId(column as never, index))
  const key = ids.join('|')
  const [saved, setSaved] = useState<{ key: string; layout: Layout }>(() => ({ key, layout: load(key) }))
  const layout = saved.key === key ? saved.layout : load(key)

  function update(change: (current: Layout) => Layout, persist = true): void {
    setSaved((current) => {
      const next = change(current.key === key ? current.layout : load(key))
      if (persist) store(key, next)
      return { key, layout: next }
    })
  }

  return useMemo(() => {
    const byId = new Map(columns.map((column, index) => [ids[index], column]))
    const pinnedLeft = ids.filter((id) => byId.get(id)!.fixed === 'left' || byId.get(id)!.fixed === true)
    const pinnedRight = ids.filter((id) => byId.get(id)!.fixed === 'right')
    const movable = ids.filter((id) => !isPinned(byId.get(id) as never))
    // Saved order first; columns added since keep their default place among the rest.
    const ordered = [...layout.order.filter((id) => movable.includes(id))]
    movable.forEach((id, index) => {
      if (ordered.includes(id)) return
      const after = movable.slice(0, index).reverse().find((previous) => ordered.includes(previous))
      ordered.splice(after ? ordered.indexOf(after) + 1 : 0, 0, id)
    })
    const hidden = new Set(layout.hidden.filter((id) => movable.includes(id) && !isRequired(byId.get(id) as never)))
    const sized = Object.keys(layout.widths).length > 0

    function move(from: string, to: string, before: boolean): void {
      update((current) => {
        const order = ordered.filter((id) => id !== from)
        const at = order.indexOf(to)
        if (at < 0) return current
        order.splice(before ? at : at + 1, 0, from)
        return { ...current, order }
      })
    }

    let total = 0
    const build = (id: string): Column<T> => {
      const column = byId.get(id)!
      const width = layout.widths[id] ?? (typeof column.width === 'number' ? column.width : undefined)
      total += width ?? FALLBACK_WIDTH
      const canMove = movable.includes(id)
      return {
        ...column,
        width,
        onHeaderCell: (cell: unknown) => ({
          ...(column.onHeaderCell?.(cell as never) ?? {}),
          'data-col-id': id,
          onResizeStart: (widths: Record<string, number>) => update((current) => ({ ...current, widths: { ...widths, ...current.widths } }), false),
          onResizeWidth: (value: number) => update((current) => ({ ...current, widths: { ...current.widths, [id]: value } }), false),
          onResizeEnd: () => update((current) => current),
          onResizeReset: () => update((current) => {
            const { [id]: _removed, ...widths } = current.widths
            return { ...current, widths }
          }),
          onMove: canMove ? (from: string, before: boolean) => move(from, id, before) : undefined
        })
      } as Column<T>
    }

    const visible = ordered.filter((id) => !hidden.has(id))
    const next: Column<T>[] = [...pinnedLeft.map(build), ...visible.map(build)]
    // Once widths are fixed, space the columns leave takes this blank column, before 操作.
    if (sized) next.push({ key: FILL_KEY, title: '', render: () => null, className: 'fb-col-fill' } as Column<T>)
    next.push(...pinnedRight.map(build))

    const settings = (
      <ColumnSettings
        items={ordered.map((id) => ({ id, title: byId.get(id)!.title as ReactNode, hidden: hidden.has(id), required: isRequired(byId.get(id) as never) }))}
        onToggle={(id, show) => update((current) => ({ ...current, hidden: show ? current.hidden.filter((item) => item !== id) : [...current.hidden.filter((item) => item !== id), id] }))}
        onMove={(from, to, before) => move(from, to, before)}
        onReset={() => update(() => EMPTY)}
        changed={sized || layout.order.length > 0 || hidden.size > 0}
      />
    )

    return {
      columns: next as TableColumnsType<T>,
      scrollX: sized ? Math.max(minScrollX ?? 0, total + 48) : minScrollX,
      tableLayout: sized ? 'fixed' : undefined,
      settings
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ids follow columns and key
  }, [columns, layout, key, minScrollX])
}

interface SettingsItem {
  id: string
  title: ReactNode
  hidden: boolean
  required: boolean
}

/** 列设置: drag rows to reorder, tick to show, and go back to the default layout. */
function ColumnSettings({ items, onToggle, onMove, onReset, changed }: {
  items: SettingsItem[]
  onToggle: (id: string, show: boolean) => void
  onMove: (from: string, to: string, before: boolean) => void
  onReset: () => void
  changed: boolean
}) {
  const [dragging, setDragging] = useState<string>()
  const [over, setOver] = useState<{ id: string; before: boolean }>()
  const shown = items.filter((item) => !item.hidden).length
  const panel = (
    <div className="fb-colset">
      <ul>
        {items.map((item) => (
          <li
            key={item.id}
            draggable
            className={[dragging === item.id ? 'is-dragging' : '', over?.id === item.id ? (over.before ? 'drop-before' : 'drop-after') : ''].filter(Boolean).join(' ')}
            onDragStart={(event) => { setDragging(item.id); event.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => { setDragging(undefined); setOver(undefined) }}
            onDragOver={(event) => {
              if (!dragging) return
              event.preventDefault()
              const box = event.currentTarget.getBoundingClientRect()
              setOver({ id: item.id, before: event.clientY < box.top + box.height / 2 })
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dragging && over && dragging !== over.id) onMove(dragging, over.id, over.before)
              setDragging(undefined)
              setOver(undefined)
            }}
          >
            <HolderOutlined className="fb-colset-handle" />
            <Checkbox
              checked={!item.hidden}
              disabled={item.required || (!item.hidden && shown <= 1)}
              onChange={(event) => onToggle(item.id, event.target.checked)}
            >
              {item.title || <span className="fb-muted">{t("（无标题）")}</span>}
            </Checkbox>
          </li>
        ))}
      </ul>
      <div className="fb-colset-foot">
        <span className="fb-muted">{t("拖动调整顺序")}</span>
        <Button size="small" type="link" disabled={!changed} onClick={onReset}>{t("恢复默认")}</Button>
      </div>
    </div>
  )
  return (
    <Popover trigger="click" placement="bottomRight" title={t("列设置")} content={panel} arrow={false}>
      <Tooltip title={t("列设置：顺序、显示和宽度")}>
        <Button icon={<SettingOutlined />} aria-label={t("列设置")} className={changed ? 'fb-colset-button is-changed' : 'fb-colset-button'} />
      </Tooltip>
    </Popover>
  )
}
