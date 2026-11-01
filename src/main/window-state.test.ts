import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWindowState, windowPlacement, writeWindowState } from './window-state'

const screen = [{ x: 0, y: 0, width: 2560, height: 1392 }]
const defaults = { width: 1320, height: 820 }
const minimum = { width: 1040, height: 680 }

describe('launcher window size', () => {
  it('opens at the default size the first time', () => {
    expect(windowPlacement(undefined, screen, defaults, minimum)).toEqual({ width: 1320, height: 820, maximized: false })
  })

  it('opens where it was last left, maximized again when it was', () => {
    const saved = { x: 300, y: 120, width: 1800, height: 1100, maximized: false }
    expect(windowPlacement(saved, screen, defaults, minimum)).toEqual({ x: 300, y: 120, width: 1800, height: 1100, maximized: false })
    expect(windowPlacement({ ...saved, maximized: true }, screen, defaults, minimum).maximized).toBe(true)
  })

  it('falls back to the default when the saved place is on a screen no longer there', () => {
    const onSecondScreen = { x: 2800, y: 100, width: 1400, height: 900, maximized: false }
    expect(windowPlacement(onSecondScreen, screen, defaults, minimum)).toEqual({ width: 1320, height: 820, maximized: false })
    const twoScreens = [...screen, { x: 2560, y: 0, width: 1920, height: 1032 }]
    expect(windowPlacement(onSecondScreen, twoScreens, defaults, minimum)).toMatchObject({ x: 2800, width: 1400 })
  })

  it('keeps the size between the minimum and the screen', () => {
    expect(windowPlacement({ x: 0, y: 0, width: 600, height: 400, maximized: false }, screen, defaults, minimum)).toMatchObject({ width: 1040, height: 680 })
    expect(windowPlacement({ x: 0, y: 0, width: 4000, height: 3000, maximized: false }, screen, defaults, minimum)).toMatchObject({ width: 2560, height: 1392 })
  })

  it('reads back what it wrote, and nothing from a damaged file', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'window-state-'))
    try {
      const file = join(folder, 'window-state.json')
      expect(readWindowState(file)).toBeUndefined()
      writeWindowState(file, { x: 10, y: 20, width: 1500, height: 900, maximized: true })
      expect(readWindowState(file)).toEqual({ x: 10, y: 20, width: 1500, height: 900, maximized: true })
      writeWindowState(file, { x: Number.NaN, y: 0, width: 1, height: 1, maximized: false })
      expect(readWindowState(file)).toBeUndefined()
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
