import { readFileSync, writeFileSync } from 'node:fs'

/** The launcher window as it was last left: its normal (not maximized) bounds and whether it was maximized. */
export interface SavedWindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface Rect { x: number; y: number; width: number; height: number }

/** How the window opens: no x/y means centered by Electron. */
export interface WindowPlacement { x?: number; y?: number; width: number; height: number; maximized: boolean }

export function readWindowState(file: string): SavedWindowState | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<SavedWindowState>
    const numbers = [value.x, value.y, value.width, value.height]
    if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))) return undefined
    return { x: value.x!, y: value.y!, width: value.width!, height: value.height!, maximized: value.maximized === true }
  } catch {
    return undefined
  }
}

export function writeWindowState(file: string, state: SavedWindowState): void {
  try {
    writeFileSync(file, JSON.stringify(state))
  } catch { /* the size is only a convenience */ }
}

/**
 * Where the window opens: the saved size and place when its title bar is still on one of the
 * screens (a monitor unplugged or rearranged since would leave it out of reach), at least the
 * minimum size and no larger than that screen; otherwise the default size, centered.
 */
export function windowPlacement(
  saved: SavedWindowState | undefined,
  workAreas: readonly Rect[],
  defaults: { width: number; height: number },
  minimum: { width: number; height: number }
): WindowPlacement {
  const fallback = { width: defaults.width, height: defaults.height, maximized: saved?.maximized ?? false }
  if (!saved) return fallback
  // The title bar: the top 40 pixels, at least 100 of them across inside a work area.
  const area = workAreas.find((work) => {
    const left = Math.max(saved.x, work.x)
    const right = Math.min(saved.x + saved.width, work.x + work.width)
    return right - left >= 100 && saved.y >= work.y && saved.y + 40 <= work.y + work.height
  })
  if (!area) return fallback
  const width = Math.min(Math.max(Math.round(saved.width), minimum.width), area.width)
  const height = Math.min(Math.max(Math.round(saved.height), minimum.height), area.height)
  return { x: Math.round(saved.x), y: Math.round(saved.y), width, height, maximized: saved.maximized }
}
