/**
 * How the user arranged each table: column widths, order, hidden columns, renamed headers, columns
 * they added (and what they wrote in them) and the row order they dragged. They follow the account
 * (user 11-07: 「直接写到每个账户里边…跟随账号走」): kept in the settings and in the account's copy on
 * the team server, so the same account sees the same tables on every computer; other accounts are not
 * touched. Local mode keeps them on this computer.
 */

export interface CustomColumn {
  id: string
  title: string
}

export interface TableUiPrefs {
  widths?: Record<string, number>
  order?: string[]
  hidden?: string[]
  /** Headers the user renamed, by column id. */
  titles?: Record<string, string>
  /** Columns the user added. */
  custom?: CustomColumn[]
  /** What the user wrote in the added columns: row id → column id → text. */
  values?: Record<string, Record<string, string>>
  /** Row ids in the order the user dragged them. */
  rows?: string[]
}

export interface UiPrefs {
  tables?: Record<string, TableUiPrefs>
}

export const CUSTOM_COLUMN_PREFIX = 'custom:'
const MAX_TABLES = 100
const MAX_CUSTOM = 20
const MAX_TITLE = 40
const MAX_VALUE = 500
const MAX_ROWS = 5000
const MAX_ID = 200
/** The account's copy on the server holds 5 MB; the tables stay well under it. */
export const MAX_UI_PREFS_BYTES = 1_000_000

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const shortString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

function validTable(input: unknown): TableUiPrefs | undefined {
  if (!isRecord(input)) return undefined
  const table: TableUiPrefs = {}
  if (isRecord(input.widths)) {
    const widths = Object.fromEntries(Object.entries(input.widths)
      .filter(([id, width]) => id.length <= MAX_ID && typeof width === 'number' && Number.isFinite(width) && width >= 20 && width <= 4000)
      .map(([id, width]) => [id, Math.round(width as number)]))
    if (Object.keys(widths).length) table.widths = widths
  }
  const ids = (value: unknown, max: number) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => shortString(id, MAX_ID)))].slice(0, max) : []
  const order = ids(input.order, 200)
  if (order.length) table.order = order
  const hidden = ids(input.hidden, 200)
  if (hidden.length) table.hidden = hidden
  if (isRecord(input.titles)) {
    const titles = Object.fromEntries(Object.entries(input.titles)
      .filter(([id, title]) => id.length <= MAX_ID && shortString(typeof title === 'string' ? title.trim() : title, MAX_TITLE))
      .map(([id, title]) => [id, (title as string).trim()]))
    if (Object.keys(titles).length) table.titles = titles
  }
  if (Array.isArray(input.custom)) {
    const seen = new Set<string>()
    const custom = input.custom
      .filter((column): column is CustomColumn => isRecord(column) && shortString(column.id, MAX_ID) && column.id.startsWith(CUSTOM_COLUMN_PREFIX)
        && shortString(typeof column.title === 'string' ? column.title.trim() : column.title, MAX_TITLE))
      .filter((column) => !seen.has(column.id) && Boolean(seen.add(column.id)))
      .slice(0, MAX_CUSTOM)
      .map((column) => ({ id: column.id, title: column.title.trim() }))
    if (custom.length) table.custom = custom
  }
  if (isRecord(input.values)) {
    const columns = new Set((table.custom ?? []).map((column) => column.id))
    const values: Record<string, Record<string, string>> = {}
    for (const [row, cells] of Object.entries(input.values).slice(0, MAX_ROWS)) {
      if (row.length > MAX_ID || !isRecord(cells)) continue
      const kept = Object.fromEntries(Object.entries(cells)
        .filter(([column, text]) => columns.has(column) && typeof text === 'string' && text.trim() && text.length <= MAX_VALUE)
        .map(([column, text]) => [column, (text as string).trim()]))
      if (Object.keys(kept).length) values[row] = kept
    }
    if (Object.keys(values).length) table.values = values
  }
  const rows = ids(input.rows, MAX_ROWS)
  if (rows.length) table.rows = rows
  return Object.keys(table).length ? table : undefined
}

/** Keeps only well-formed tables, and none at all past the size limit. Undefined = nothing arranged. */
export function validUiPrefs(input: unknown): UiPrefs | undefined {
  if (!isRecord(input) || !isRecord(input.tables)) return undefined
  const tables: Record<string, TableUiPrefs> = {}
  for (const [key, value] of Object.entries(input.tables).slice(0, MAX_TABLES)) {
    if (!key || key.length > 2000) continue
    const table = validTable(value)
    if (table) tables[key] = table
  }
  if (!Object.keys(tables).length) return undefined
  const prefs = { tables }
  return JSON.stringify(prefs).length <= MAX_UI_PREFS_BYTES ? prefs : undefined
}

/** One table changed (undefined: back to the default), the others kept as they are. */
export function withTable(prefs: UiPrefs | undefined, key: string, table: TableUiPrefs | undefined): UiPrefs | undefined {
  const tables = { ...(prefs?.tables ?? {}) }
  const clean = validTable(table)
  if (clean) tables[key] = clean
  else delete tables[key]
  return validUiPrefs({ tables })
}

/**
 * The rows in the order the user dragged them. Rows not placed yet (new since) keep their default
 * place: right after the row before them in the default order, or first when none is placed.
 */
export function arrangeRows<T extends { id: string }>(rows: T[], saved: string[] | undefined): T[] {
  if (!saved?.length) return rows
  const position = new Map(saved.map((id, index) => [id, index]))
  const placed = rows.filter((row) => position.has(row.id)).sort((a, b) => position.get(a.id)! - position.get(b.id)!)
  const result = [...placed]
  rows.forEach((row, index) => {
    if (position.has(row.id)) return
    const before = rows.slice(0, index).reverse().find((previous) => result.includes(previous))
    result.splice(before ? result.indexOf(before) + 1 : 0, 0, row)
  })
  return result
}

/**
 * The saved row order after dragging `from` before / after `to`. The rows shown now (perhaps a
 * filtered part of the list) are merged into the saved order first, so rows not shown keep theirs.
 */
export function movedRows(saved: string[] | undefined, shown: string[], from: string, to: string, before: boolean): string[] {
  // Rows shown but not saved yet go where they are shown: after the shown row before them.
  const full = [...(saved ?? [])]
  shown.forEach((id, index) => {
    if (full.includes(id)) return
    const previous = shown.slice(0, index).reverse().find((item) => full.includes(item))
    full.splice(previous ? full.indexOf(previous) + 1 : 0, 0, id)
  })
  const order = full.filter((id) => id !== from)
  const at = order.indexOf(to)
  if (at < 0 || from === to) return full
  order.splice(before ? at : at + 1, 0, from)
  return order.slice(0, MAX_ROWS)
}
