import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { restoreWindowState, snapshotWindowState } from './chrome-preferences'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function profile(placement: unknown, sessions?: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prism-window-state-'))
  roots.push(root)
  await mkdir(join(root, 'Default'), { recursive: true })
  await writeFile(join(root, 'Default', 'Preferences'), JSON.stringify({ browser: placement === undefined ? {} : { window_placement: placement }, other: 1 }))
  if (sessions) {
    await mkdir(join(root, 'Default', 'Sessions'))
    for (const [name, text] of Object.entries(sessions)) await writeFile(join(root, 'Default', 'Sessions', name), text)
  }
  return root
}

/** What a headless Chrome that shut down properly leaves: its 800×600 size and an about:blank session. */
async function headlessRun(root: string): Promise<void> {
  const path = join(root, 'Default', 'Preferences')
  const prefs = JSON.parse(await readFile(path, 'utf8'))
  prefs.browser = { ...prefs.browser, window_placement: { left: 0, top: 0, right: 800, bottom: 600, maximized: false } }
  prefs.cookiesTouched = true
  await writeFile(path, JSON.stringify(prefs))
  await mkdir(join(root, 'Default', 'Sessions'), { recursive: true })
  await writeFile(join(root, 'Default', 'Sessions', 'Session_999'), 'about:blank')
}

const read = async (root: string) => JSON.parse(await readFile(join(root, 'Default', 'Preferences'), 'utf8'))

describe('window state around a headless cookie run', () => {
  it('keeps the size the user gave the window and its last session', async () => {
    const mine = { left: 100, top: 50, right: 2100, bottom: 1350, maximized: false }
    const root = await profile(mine, { Session_1: 'https://www.youtube.com/', Tabs_1: 'tabs' })
    const snapshot = await snapshotWindowState(root)
    await headlessRun(root)
    await restoreWindowState(root, snapshot)
    const prefs = await read(root)
    expect(prefs.browser.window_placement).toEqual(mine)
    expect(prefs.cookiesTouched).toBe(true)
    expect((await readdir(join(root, 'Default', 'Sessions'))).sort()).toEqual(['Session_1', 'Tabs_1'])
    expect(await readFile(join(root, 'Default', 'Sessions', 'Session_1'), 'utf8')).toBe('https://www.youtube.com/')
  })

  it('leaves a never-opened window without a size, so it opens at the Chrome default size', async () => {
    const root = await profile(undefined)
    const snapshot = await snapshotWindowState(root)
    await headlessRun(root)
    await restoreWindowState(root, snapshot)
    expect((await read(root)).browser.window_placement).toBeUndefined()
    await expect(readdir(join(root, 'Default', 'Sessions'))).rejects.toThrow()
  })

  it('drops a size a headless run left before (800×600, or the 780×580 Chrome made of it)', async () => {
    for (const left of [{ left: 0, top: 0, right: 800, bottom: 600 }, { left: 20, top: 20, right: 800, bottom: 600 }]) {
      const root = await profile({ ...left, maximized: false })
      const snapshot = await snapshotWindowState(root)
      await headlessRun(root)
      await restoreWindowState(root, snapshot)
      expect((await read(root)).browser.window_placement).toBeUndefined()
    }
  })
})
