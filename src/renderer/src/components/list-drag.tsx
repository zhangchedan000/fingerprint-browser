import { HolderOutlined } from '@ant-design/icons'
import { Tooltip } from 'antd'
import { useState, type DragEvent, type HTMLAttributes } from 'react'
import { t } from '../../../shared/i18n'

const LIST_DRAG_TYPE = 'application/x-fb-list'

/** The items with `from` moved before / after `to`. */
export function movedItem<T extends { id: string }>(items: T[], from: string, to: string, before: boolean): T[] {
  const moving = items.find((item) => item.id === from)
  if (!moving || from === to) return items
  const rest = items.filter((item) => item.id !== from)
  const at = rest.findIndex((item) => item.id === to)
  if (at < 0) return items
  rest.splice(before ? at : at + 1, 0, moving)
  return rest
}

/**
 * A list whose rows are dragged by their handle into another order (检测网站 lists and the like;
 * rule of 11-07: every list can be put in the user's own order). `onMove` gets the new order.
 */
export function useListDrag<T extends { id: string }>(items: T[], onMove: (next: T[]) => void) {
  const [dragging, setDragging] = useState<string>()
  const [over, setOver] = useState<{ id: string; before: boolean }>()
  const side = (event: DragEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return event.clientY < box.top + box.height / 2
  }
  return {
    /** Spread on each row. */
    rowProps: (id: string): HTMLAttributes<HTMLDivElement> => ({
      className: [dragging === id ? 'is-dragging' : '', over?.id === id && dragging !== id ? (over.before ? 'drop-before' : 'drop-after') : ''].filter(Boolean).join(' '),
      onDragOver: (event) => {
        if (!event.dataTransfer.types.includes(LIST_DRAG_TYPE)) return
        event.preventDefault()
        const before = side(event)
        if (over?.id !== id || over.before !== before) setOver({ id, before })
      },
      onDrop: (event) => {
        if (!event.dataTransfer.types.includes(LIST_DRAG_TYPE)) return
        event.preventDefault()
        const from = event.dataTransfer.getData(LIST_DRAG_TYPE)
        const before = side(event)
        setDragging(undefined)
        setOver(undefined)
        if (from && from !== id) onMove(movedItem(items, from, id, before))
      }
    }),
    /** The handle at the start of each row. */
    handle: (id: string) => (
      <Tooltip title={t("按住拖动，调整顺序")} mouseEnterDelay={0.6}>
        <span
          className="fb-row-handle"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(LIST_DRAG_TYPE, id)
            event.dataTransfer.effectAllowed = 'move'
            const row = (event.currentTarget as HTMLElement).parentElement
            if (row) event.dataTransfer.setDragImage(row, 16, 16)
            setDragging(id)
          }}
          onDragEnd={() => { setDragging(undefined); setOver(undefined) }}
        >
          <HolderOutlined />
        </span>
      </Tooltip>
    )
  }
}
