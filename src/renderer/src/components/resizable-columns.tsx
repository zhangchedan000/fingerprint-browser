import type { TableColumnsType } from 'antd'
import { useMemo, useState, type MouseEvent, type ThHTMLAttributes } from 'react'

const MIN_WIDTH = 56
const STORE_PREFIX = 'fb.columnWidths.'

type Widths = Record<string, number>

function columnId(column: TableColumnsType<never>[number], index: number): string {
  if (column.key !== undefined) return String(column.key)
  if ('dataIndex' in column && column.dataIndex !== undefined) return String(column.dataIndex)
  return String(index)
}

function load(key: string): Widths {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_PREFIX + key) || '{}') as unknown
    return value && typeof value === 'object' ? value as Widths : {}
  } catch {
    return {}
  }
}

function store(key: string, widths: Widths): void {
  try {
    if (Object.keys(widths).length) localStorage.setItem(STORE_PREFIX + key, JSON.stringify(widths))
    else localStorage.removeItem(STORE_PREFIX + key)
  } catch {
    // Widths are a convenience; without storage they last until the page is left.
  }
}

interface ResizableHeaderProps extends ThHTMLAttributes<HTMLTableCellElement> {
  onResizeWidth?: (width: number) => void
  onResizeEnd?: () => void
  onResizeReset?: () => void
}

/**
 * A table header cell with a handle on its right edge: drag to change the column's width,
 * double-click to go back to the default one.
 */
function ResizableHeader({ onResizeWidth, onResizeEnd, onResizeReset, children, ...props }: ResizableHeaderProps) {
  if (!onResizeWidth) return <th {...props}>{children}</th>
  function start(event: MouseEvent<HTMLSpanElement>): void {
    event.preventDefault()
    event.stopPropagation()
    const cell = event.currentTarget.parentElement
    if (!cell || !onResizeWidth) return
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
  return (
    <th {...props}>
      {children}
      <span
        className="fb-col-resize"
        aria-hidden="true"
        onMouseDown={start}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => { event.stopPropagation(); onResizeReset?.() }}
      />
    </th>
  )
}

export const resizableHeaderComponents = { header: { cell: ResizableHeader } }

/**
 * Columns whose widths the user can drag; each table remembers its widths on this computer
 * (keyed by its column set, so tables need no names of their own).
 */
export function useResizableColumns<T>(columns: TableColumnsType<T>, minScrollX?: number): { columns: TableColumnsType<T>; scrollX?: number } {
  const key = columns.map((column, index) => columnId(column as never, index)).join('|')
  const [saved, setSaved] = useState<{ key: string; widths: Widths }>(() => ({ key, widths: load(key) }))
  const widths = saved.key === key ? saved.widths : load(key)

  return useMemo(() => {
    let total = 0
    let changed = false
    const next = columns.map((column, index) => {
      const id = columnId(column as never, index)
      const width = widths[id] ?? (typeof column.width === 'number' ? column.width : undefined)
      if (widths[id] !== undefined) changed = true
      total += width ?? 140
      const update = (patch: (current: Widths) => Widths, persist: boolean) => setSaved((current) => {
        const base = current.key === key ? current.widths : load(key)
        const result = patch(base)
        if (persist) store(key, result)
        return { key, widths: result }
      })
      return {
        ...column,
        width,
        onHeaderCell: (cell: unknown) => ({
          ...(column.onHeaderCell?.(cell as never) ?? {}),
          onResizeWidth: (value: number) => update((current) => ({ ...current, [id]: value }), false),
          onResizeEnd: () => update((current) => current, true),
          onResizeReset: () => update((current) => {
            const { [id]: _removed, ...rest } = current
            return rest
          }, true)
        })
      }
    }) as unknown as TableColumnsType<T>
    const scrollX = changed ? Math.max(minScrollX ?? 0, total) : minScrollX
    return { columns: next, scrollX }
  }, [columns, widths, key, minScrollX])
}
