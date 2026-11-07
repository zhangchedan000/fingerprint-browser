import { DeleteOutlined, EditOutlined, HolderOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Checkbox, Input, Popconfirm, Popover, Select, Space, Tooltip, type TableColumnsType, type TableProps } from 'antd'
import { useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type MouseEvent, type ReactNode, type ThHTMLAttributes } from 'react'
import { t } from '../../../shared/i18n'
import { arrangeRows, CUSTOM_COLUMN_PREFIX, matchDataField, movedRows, type CustomColumn, type DataFieldName, type TableUiPrefs } from '../../../shared/ui-prefs'
import { useWorkspace } from '../data/workspace'
import type { DataField } from './data-fields'

/**
 * Columns and rows the user arranges, per table: drag a header edge to change one column's width
 * (the others keep theirs), drag a header to move it; in the column settings hide, reorder, rename,
 * add their own columns (each row written in by hand, or showing one of the table's data fields
 * matched by the name typed — 出口 IP, 时区… — and sorted by them) and delete those; drag rows
 * by their handle to put them in their own order. The checkbox column and pinned columns
 * (fixed: left/right, e.g. 操作) stay put. All of it follows the account (user 11-07), see ui-prefs.ts.
 * Every list or table of the launcher has these (rule of 11-07 in CLAUDE.md).
 */

const MIN_WIDTH = 56
const STORE_PREFIX = 'fb.columns.'
const OLD_WIDTHS_PREFIX = 'fb.columnWidths.'
const FILL_KEY = '__fill'
const DRAG_KEY = '__drag'
const FALLBACK_WIDTH = 140
const CUSTOM_WIDTH = 160
/** Typing in a cell or dragging a width saves once it has been still this long. */
const SAVE_DELAY_MS = 600

interface Layout {
  widths: Record<string, number>
  order: string[]
  hidden: string[]
  titles: Record<string, string>
  custom: CustomColumn[]
  values: Record<string, Record<string, string>>
  rows: string[]
}

const EMPTY: Layout = { widths: {}, order: [], hidden: [], titles: {}, custom: [], values: {}, rows: [] }

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
  return ('dataIndex' in column && column.dataIndex === 'name') || column.key === 'name'
}

function fromPrefs(table: TableUiPrefs | undefined): Layout {
  return {
    widths: table?.widths ?? {}, order: table?.order ?? [], hidden: table?.hidden ?? [], titles: table?.titles ?? {},
    custom: table?.custom ?? [], values: table?.values ?? {}, rows: table?.rows ?? []
  }
}

function toPrefs(layout: Layout): TableUiPrefs | undefined {
  const table: TableUiPrefs = {
    ...(Object.keys(layout.widths).length ? { widths: layout.widths } : {}),
    ...(layout.order.length ? { order: layout.order } : {}),
    ...(layout.hidden.length ? { hidden: layout.hidden } : {}),
    ...(Object.keys(layout.titles).length ? { titles: layout.titles } : {}),
    ...(layout.custom.length ? { custom: layout.custom } : {}),
    ...(Object.keys(layout.values).length ? { values: layout.values } : {}),
    ...(layout.rows.length ? { rows: layout.rows } : {})
  }
  return Object.keys(table).length ? table : undefined
}

/** What 0.5.78 and earlier kept on this computer only; moved to the account the first time it is used. */
function loadLocal(key: string): Layout | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_PREFIX + key) || 'null') as Partial<Layout> | null
    if (value && typeof value === 'object') return { ...EMPTY, widths: value.widths ?? {}, order: value.order ?? [], hidden: value.hidden ?? [] }
    // Widths saved by 0.5.8 – 0.5.11.
    const widths = JSON.parse(localStorage.getItem(OLD_WIDTHS_PREFIX + key) || 'null') as Record<string, number> | null
    if (widths && typeof widths === 'object') return { ...EMPTY, widths }
  } catch {
    // Unreadable: the default layout.
  }
  return undefined
}

function forgetLocal(key: string): void {
  try {
    localStorage.removeItem(STORE_PREFIX + key)
    localStorage.removeItem(OLD_WIDTHS_PREFIX + key)
  } catch {
    // Nothing kept here to forget.
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

const ROW_DRAG_TYPE = 'application/x-fb-row'

/** A row that rows dragged by their handle can be dropped on (above or below it). */
function DropRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement> & { 'data-row-key'?: string }) {
  return <tr className={className} {...props} />
}

export interface TableColumnsResult<T> {
  columns: TableColumnsType<T>
  scrollX?: number
  /** Fixed layout once widths are set, so the other columns keep theirs. */
  tableLayout?: 'fixed'
  /** The 列设置 button. */
  settings: ReactNode
  /** The rows in the user's order (the page's own order for rows not dragged yet). */
  arrange: <R extends T & { id: string }>(rows: R[]) => R[]
  /** For the table's onRow: rows take dragged rows; merge with the page's own handlers. */
  rowProps: (row: T & { id: string }, shown: Array<T & { id: string }>) => HTMLAttributes<HTMLTableRowElement>
  /** For the table's rowClassName: where a dragged row would land. */
  rowClass: (row: T & { id: string }) => string
  /** For the table's onChange: while a header sort is on, rows cannot be dragged. */
  onChange: TableProps<T>['onChange']
  /** Header and row components for the table. */
  components: TableProps<T>['components']
}

export interface TableColumnsOptions {
  /** A title for the column settings when a page has two tables (订阅 / 节点). */
  settingsTitle?: string
  /** Rows can be dragged into the user's own order (needs rows with an id). */
  rowDrag?: boolean
  /** Data the user's own columns can show (data-fields.ts); a new column's name is matched against them. */
  dataFields?: DataField<never>[]
}

/** A field's value as shown, and as sorted (numbers as numbers, empty last). */
function fieldText(field: DataField<never>, row: unknown): string {
  const value = field.value(row as never)
  if (value === undefined || value === '') return ''
  return typeof value === 'number' ? (field.format ? field.format(value) : String(value)) : value
}

function compareField(field: DataField<never>, first: unknown, second: unknown): number {
  const a = field.value(first as never)
  const b = field.value(second as never)
  const emptyA = a === undefined || a === ''
  const emptyB = b === undefined || b === ''
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/** Each table is keyed by its column set, so pages need no names of their own. */
export function useTableColumns<T>(columns: TableColumnsType<T>, minScrollX?: number, options: TableColumnsOptions | string = {}): TableColumnsResult<T> {
  const { settingsTitle, rowDrag, dataFields } = typeof options === 'string' ? { settingsTitle: options, rowDrag: false, dataFields: undefined } : options
  const ws = useWorkspace()
  const ids = columns.map((column, index) => columnId(column as never, index))
  const key = ids.join('|')
  const accountTable = ws.preferences.uiPrefs?.tables?.[key]
  // This computer's layout from before (0.5.78 and earlier), until the account has one for the table.
  const local = useMemo(() => accountTable ? undefined : loadLocal(key), [key, accountTable])
  const fromAccount = useMemo(() => fromPrefs(accountTable), [accountTable])
  const [draft, setDraft] = useState<{ key: string; layout: Layout }>()
  const layout = draft?.key === key ? draft.layout : local ?? fromAccount
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [sorted, setSorted] = useState(false)
  const [dragging, setDragging] = useState<string>()
  const [over, setOver] = useState<{ id: string; before: boolean }>()

  // The earlier layout goes to the account once, so other computers of the account get it too.
  useEffect(() => {
    if (!local) return
    void ws.setTablePrefs(key, toPrefs(local)).then(() => forgetLocal(key)).catch(() => undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per table key
  }, [key, Boolean(local)])

  // The account's copy changed (another computer, a reset): shown once nothing is waiting to be saved.
  useEffect(() => {
    if (!saveTimer.current) setDraft(undefined)
  }, [accountTable])

  function persist(next: Layout, delay: number): void {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined
      void ws.setTablePrefs(key, toPrefs(next)).catch((reason) => ws.fail(reason))
    }, delay)
  }

  // Several changes in a row (a width drag) each build on the one before, not on what was rendered.
  const base = local ?? fromAccount
  function update(change: (current: Layout) => Layout, save: boolean | 'later' = true): void {
    setDraft((previous) => {
      const next = change(previous?.key === key ? previous.layout : base)
      if (save) persist(next, save === 'later' ? SAVE_DELAY_MS : 0)
      return { key, layout: next }
    })
  }

  return useMemo(() => {
    const customIds = layout.custom.map((column) => column.id)
    const allIds = [...ids, ...customIds]
    const customById = new Map(layout.custom.map((column) => [column.id, column]))
    const byId = new Map<string, Column<T>>(columns.map((column, index) => [ids[index], column]))
    const fieldById = new Map((dataFields ?? []).map((field) => [field.id, field]))
    // The user's own columns: a data field, or a cell to write in, sorted by what it shows.
    for (const custom of layout.custom) {
      const field = custom.field ? fieldById.get(custom.field) : undefined
      if (field) {
        byId.set(custom.id, {
          key: custom.id,
          title: custom.title,
          width: CUSTOM_WIDTH,
          ellipsis: true,
          sorter: (first: unknown, second: unknown) => compareField(field, first, second),
          render: (_value: unknown, row: unknown) => {
            const text = fieldText(field, row)
            return text ? <span className="fb-field-cell" title={text}>{text}</span> : <span className="fb-muted">—</span>
          }
        } as Column<T>)
        continue
      }
      byId.set(custom.id, {
        key: custom.id,
        title: custom.title,
        width: CUSTOM_WIDTH,
        sorter: (first: unknown, second: unknown) => (layout.values[(first as { id: string }).id]?.[custom.id] ?? '')
          .localeCompare(layout.values[(second as { id: string }).id]?.[custom.id] ?? '', undefined, { numeric: true }),
        render: (_value: unknown, row: unknown) => {
          const rowId = (row as { id?: string }).id
          if (!rowId) return null
          return (
            <CustomCell
              value={layout.values[rowId]?.[custom.id] ?? ''}
              onSave={(text) => update((current) => {
                const cells = { ...(current.values[rowId] ?? {}) }
                if (text.trim()) cells[custom.id] = text.trim()
                else delete cells[custom.id]
                const values = { ...current.values }
                if (Object.keys(cells).length) values[rowId] = cells
                else delete values[rowId]
                return { ...current, values }
              })}
            />
          )
        }
      } as Column<T>)
    }
    const pinnedLeft = ids.filter((id) => byId.get(id)!.fixed === 'left' || byId.get(id)!.fixed === true)
    const pinnedRight = ids.filter((id) => byId.get(id)!.fixed === 'right')
    const movable = allIds.filter((id) => !isPinned(byId.get(id) as never))
    // Saved order first; columns added since keep their default place among the rest.
    const ordered = [...layout.order.filter((id) => movable.includes(id))]
    movable.forEach((id, index) => {
      if (ordered.includes(id)) return
      const after = movable.slice(0, index).reverse().find((previous) => ordered.includes(previous))
      ordered.splice(after ? ordered.indexOf(after) + 1 : 0, 0, id)
    })
    const hidden = new Set(layout.hidden.filter((id) => movable.includes(id) && !isRequired(byId.get(id) as never)))
    const sized = Object.keys(layout.widths).length > 0
    const titleOf = (id: string): ReactNode => customById.get(id)?.title ?? layout.titles[id] ?? byId.get(id)!.title as ReactNode

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
      // The row buttons keep the width the page gives them: a width saved by dragging another
      // column could be narrower than the buttons, which then spilled into the next cell.
      const ownWidth = column.key === 'actions'
      const width = (ownWidth ? undefined : layout.widths[id]) ?? (typeof column.width === 'number' ? column.width : undefined)
      total += width ?? FALLBACK_WIDTH
      const canMove = movable.includes(id)
      if (ownWidth) return { ...column, width } as Column<T>
      return {
        ...column,
        title: titleOf(id),
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

    // The drag handle: first, pinned left; off while a header sort decides the order.
    const handle: Column<T> = {
      key: DRAG_KEY,
      title: '',
      width: 34,
      fixed: 'left',
      className: 'fb-row-drag-cell',
      render: (_value: unknown, row: unknown) => {
        const rowId = (row as { id?: string }).id
        if (!rowId) return null
        return (
          <Tooltip title={sorted ? t("点表头取消排序后，可以拖动调整顺序") : t("按住拖动，调整顺序")} mouseEnterDelay={0.6}>
            <span
              className={sorted ? 'fb-row-handle is-off' : 'fb-row-handle'}
              draggable={!sorted}
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => {
                event.stopPropagation()
                event.dataTransfer.setData(ROW_DRAG_TYPE, rowId)
                event.dataTransfer.effectAllowed = 'move'
                const tr = (event.currentTarget as HTMLElement).closest('tr')
                if (tr) event.dataTransfer.setDragImage(tr, 16, 16)
                setDragging(rowId)
              }}
              onDragEnd={() => { setDragging(undefined); setOver(undefined) }}
            >
              <HolderOutlined />
            </span>
          </Tooltip>
        )
      }
    } as Column<T>

    const visible = ordered.filter((id) => !hidden.has(id))
    const next: Column<T>[] = [...(rowDrag ? [handle] : []), ...pinnedLeft.map(build), ...visible.map(build)]
    // Once widths are fixed, space the columns leave takes this blank column, before 操作.
    if (sized) next.push({ key: FILL_KEY, title: '', render: () => null, className: 'fb-col-fill' } as Column<T>)
    next.push(...pinnedRight.map(build))

    const settings = (
      <ColumnSettings
        items={ordered.map((id) => ({
          id,
          title: titleOf(id),
          defaultTitle: customById.has(id) ? undefined : byId.get(id)!.title as ReactNode,
          renamed: Boolean(layout.titles[id]),
          custom: customById.has(id),
          field: (() => { const field = customById.get(id)?.field; return field && fieldById.has(field) ? t(fieldById.get(field)!.label) : undefined })(),
          hidden: hidden.has(id),
          required: isRequired(byId.get(id) as never)
        }))}
        onToggle={(id, show) => update((current) => ({ ...current, hidden: show ? current.hidden.filter((item) => item !== id) : [...current.hidden.filter((item) => item !== id), id] }))}
        onMove={(from, to, before) => move(from, to, before)}
        onRename={(id, title) => update((current) => {
          const clean = title.trim().slice(0, 40)
          if (customById.has(id)) return clean ? { ...current, custom: current.custom.map((column) => column.id === id ? { ...column, title: clean } : column) } : current
          const titles = { ...current.titles }
          if (clean) titles[id] = clean
          else delete titles[id]
          return { ...current, titles }
        })}
        onAdd={(title, field) => update((current) => current.custom.length >= 20 ? current : ({
          ...current,
          custom: [...current.custom, { id: `${CUSTOM_COLUMN_PREFIX}${Date.now().toString(36)}`, title: title.trim().slice(0, 40), ...(field ? { field } : {}) }]
        }))}
        fields={(dataFields ?? []).map((field) => ({ id: field.id, label: t(field.label), names: [field.label, t(field.label), ...field.aliases] }))}
        takenFields={layout.custom.map((column) => column.field).filter((field): field is string => Boolean(field && fieldById.has(field)))}
        onDelete={(id) => update((current) => ({
          ...current,
          custom: current.custom.filter((column) => column.id !== id),
          order: current.order.filter((item) => item !== id),
          hidden: current.hidden.filter((item) => item !== id),
          values: Object.fromEntries(Object.entries(current.values)
            .map(([row, cells]) => [row, Object.fromEntries(Object.entries(cells).filter(([column]) => column !== id))] as const)
            .filter(([, cells]) => Object.keys(cells).length > 0))
        }))}
        canAdd={layout.custom.length < 20}
        // Back to the page's own columns; the user's own columns, what is written in them and the row order stay.
        onReset={() => update((current) => ({ ...EMPTY, custom: current.custom, values: current.values, rows: current.rows }))}
        changed={sized || layout.order.length > 0 || hidden.size > 0 || Object.keys(layout.titles).length > 0}
        title={settingsTitle}
      />
    )

    return {
      columns: next as TableColumnsType<T>,
      scrollX: sized ? Math.max(minScrollX ?? 0, total + 48 + (rowDrag ? 34 : 0)) : minScrollX,
      tableLayout: sized ? 'fixed' : undefined,
      settings,
      arrange: (rows) => rowDrag ? arrangeRows(rows, layout.rows) : rows,
      rowProps: (row, shown) => !rowDrag ? {} : {
        onDragOver: (event: DragEvent<HTMLTableRowElement>) => {
          if (!event.dataTransfer.types.includes(ROW_DRAG_TYPE)) return
          event.preventDefault()
          const box = event.currentTarget.getBoundingClientRect()
          const before = event.clientY < box.top + box.height / 2
          if (over?.id !== row.id || over.before !== before) setOver({ id: row.id, before })
        },
        onDrop: (event: DragEvent<HTMLTableRowElement>) => {
          if (!event.dataTransfer.types.includes(ROW_DRAG_TYPE)) return
          event.preventDefault()
          const from = event.dataTransfer.getData(ROW_DRAG_TYPE)
          const box = event.currentTarget.getBoundingClientRect()
          const before = event.clientY < box.top + box.height / 2
          setDragging(undefined)
          setOver(undefined)
          if (!from || from === row.id) return
          update((current) => ({ ...current, rows: movedRows(current.rows, shown.map((item) => item.id), from, row.id, before) }))
        }
      },
      rowClass: (row) => !rowDrag ? '' : [
        dragging === row.id ? 'fb-row-dragging' : '',
        over?.id === row.id && dragging !== row.id ? (over.before ? 'fb-row-drop-before' : 'fb-row-drop-after') : ''
      ].filter(Boolean).join(' '),
      onChange: (_pagination, _filters, sorter) => {
        const sorts = Array.isArray(sorter) ? sorter : [sorter]
        setSorted(sorts.some((item) => Boolean(item?.order)))
      },
      components: { ...tableHeaderComponents, body: { row: DropRow } }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ids follow columns and key
  }, [columns, layout, key, minScrollX, settingsTitle, rowDrag, dataFields, sorted, dragging, over])
}

/** A cell of a column the user added: the text, and a box to write in when clicked. */
function CustomCell({ value, onSave }: { value: string; onSave: (text: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  if (!editing) {
    return (
      <span
        className={value ? 'fb-custom-cell' : 'fb-custom-cell is-empty'}
        role="button"
        tabIndex={0}
        title={t("点击填写")}
        onClick={(event) => { event.stopPropagation(); setText(value); setEditing(true) }}
        onKeyDown={(event) => { if (event.key === 'Enter') { setText(value); setEditing(true) } }}
      >
        {value || t("点击填写")}
      </span>
    )
  }
  const done = () => {
    setEditing(false)
    if (text.trim() !== value) onSave(text)
  }
  return (
    <Input
      size="small"
      autoFocus
      maxLength={500}
      value={text}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setText(event.target.value)}
      onBlur={done}
      onPressEnter={done}
      onKeyDown={(event) => { if (event.key === 'Escape') { setText(value); setEditing(false) } }}
    />
  )
}

interface SettingsItem {
  id: string
  title: ReactNode
  /** The page's own title (for a column the user renamed). */
  defaultTitle?: ReactNode
  renamed: boolean
  custom: boolean
  /** The data field an added column shows (its label); unset: written by hand. */
  field?: string
  hidden: boolean
  required: boolean
}

/** 列设置: drag rows to reorder, tick to show, rename, add and delete the user's own columns, back to the default layout. */
function ColumnSettings({ items, onToggle, onMove, onRename, onAdd, onDelete, canAdd, onReset, changed, title, fields, takenFields }: {
  items: SettingsItem[]
  onToggle: (id: string, show: boolean) => void
  onMove: (from: string, to: string, before: boolean) => void
  onRename: (id: string, title: string) => void
  onAdd: (title: string, field?: string) => void
  onDelete: (id: string) => void
  canAdd: boolean
  onReset: () => void
  changed: boolean
  /** A page with two tables names which one (订阅 / 节点). */
  title?: string
  /** Data a new column can show, with the names it is matched by. */
  fields: Array<DataFieldName & { label: string }>
  /** Fields another added column shows already: not offered again. */
  takenFields: string[]
}) {
  const [dragging, setDragging] = useState<string>()
  const [over, setOver] = useState<{ id: string; before: boolean }>()
  const [renaming, setRenaming] = useState<{ id: string; text: string }>()
  const [adding, setAdding] = useState('')
  // What the new column shows: '' = written by hand. Follows the name typed until the user picks.
  const [content, setContent] = useState<{ field: string; byHand: boolean }>({ field: '', byHand: false })
  const freeFields = fields.filter((field) => !takenFields.includes(field.id))
  const typeName = (name: string) => {
    setAdding(name)
    if (!content.byHand) setContent({ field: matchDataField(name, freeFields) ?? '', byHand: false })
  }
  const pickContent = (field: string) => {
    setContent({ field, byHand: true })
    // A field picked before a name is typed names the column.
    if (field && !adding.trim()) setAdding(fields.find((item) => item.id === field)?.label ?? '')
  }
  const chosen = freeFields.find((field) => field.id === content.field)
  const shown = items.filter((item) => !item.hidden).length
  const finishRename = () => {
    if (renaming) onRename(renaming.id, renaming.text)
    setRenaming(undefined)
  }
  const add = () => {
    if (!adding.trim()) return
    onAdd(adding, chosen?.id)
    setAdding('')
    setContent({ field: '', byHand: false })
  }
  const panel = (
    <div className="fb-colset">
      <ul>
        {items.map((item) => (
          <li
            key={item.id}
            draggable={renaming?.id !== item.id}
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
            {renaming?.id === item.id ? (
              <Input
                size="small"
                autoFocus
                maxLength={40}
                value={renaming.text}
                placeholder={typeof item.defaultTitle === 'string' ? item.defaultTitle : t("列名")}
                onChange={(event) => setRenaming({ id: item.id, text: event.target.value })}
                onBlur={finishRename}
                onPressEnter={finishRename}
                onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(undefined) }}
              />
            ) : (
              <Checkbox
                className="fb-colset-check"
                checked={!item.hidden}
                disabled={item.required || (!item.hidden && shown <= 1)}
                onChange={(event) => onToggle(item.id, event.target.checked)}
              >
                {item.title || <span className="fb-muted">{t("（无标题）")}</span>}
                {item.custom && <span className="fb-colset-tag" title={item.field ? t("显示数据：{0}", item.field) : t("每行自己填写")}>{item.field ?? t("自定义")}</span>}
              </Checkbox>
            )}
            {renaming?.id !== item.id && (
              <span className="fb-colset-tools">
                <Tooltip title={item.renamed ? t("改名（清空恢复原名）") : t("改名")}>
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label={t("改名")}
                    onClick={() => setRenaming({ id: item.id, text: typeof item.title === 'string' ? item.title : '' })} />
                </Tooltip>
                {item.custom && (
                  <Popconfirm title={t("删除这一列？已填写的内容也会删掉")} okText={t("删除")} cancelText={t("取消")} okButtonProps={{ danger: true }} onConfirm={() => onDelete(item.id)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={t("删除")} />
                  </Popconfirm>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <Space.Compact className="fb-colset-add">
        <Input size="small" maxLength={40} placeholder={t("新建列的名称")} value={adding} disabled={!canAdd} onChange={(event) => typeName(event.target.value)} onPressEnter={add} />
        <Button size="small" icon={<PlusOutlined />} disabled={!canAdd || !adding.trim()} onClick={add}>{t("新建列")}</Button>
      </Space.Compact>
      {fields.length > 0 && canAdd && (
        <div className="fb-colset-content">
          <span className="fb-muted">{t("内容")}</span>
          <Select
            size="small"
            showSearch
            optionFilterProp="label"
            value={chosen?.id ?? ''}
            onChange={pickContent}
            popupMatchSelectWidth={false}
            options={[{ value: '', label: t("自己填写") }, ...freeFields.map((field) => ({ value: field.id, label: field.label }))]}
          />
        </div>
      )}
      {fields.length > 0 && canAdd && adding.trim() && (
        <div className="fb-muted fb-colset-hint">
          {chosen
            ? (content.byHand ? t("每行显示「{0}」", chosen.label) : t("已按名称匹配到「{0}」，每行自动显示；不对可以在上面改", chosen.label))
            : t("没有匹配的数据，每行自己填写；也可以在上面选要显示的数据")}
        </div>
      )}
      {!canAdd && <div className="fb-muted fb-colset-limit">{t("最多 20 个自定义列")}</div>}
      <div className="fb-colset-foot">
        <span className="fb-muted">{t("拖动调整顺序")}</span>
        <Button size="small" type="link" disabled={!changed} onClick={onReset}>{t("恢复默认")}</Button>
      </div>
    </div>
  )
  return (
    <Popover trigger="click" placement="bottomRight" title={title ?? t("列设置")} content={panel} arrow={false}>
      <Tooltip title={title ? t("{0}：顺序、显示、宽度、列名和自定义列", title) : t("列设置：顺序、显示、宽度、列名和自定义列")}>
        <Button icon={<SettingOutlined />} aria-label={title ?? t("列设置")} className={changed ? 'fb-colset-button is-changed' : 'fb-colset-button'}>{title ? title : null}</Button>
      </Tooltip>
    </Popover>
  )
}
