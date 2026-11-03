import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { latestProfileWrite, waitForBrowserExit, type StuckChoice } from './browser-exit'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

/** A process stand-in: `exit()` settles it. */
function fakeExit() {
  let exit!: () => void
  const exited = new Promise<void>((resolve) => { exit = resolve })
  return { exited, exit }
}

describe('waitForBrowserExit', () => {
  it('returns as soon as the browser exits by itself, without asking', async () => {
    const { exited, exit } = fakeExit()
    const asked: number[] = []
    setTimeout(exit, 30)
    const wait = await waitForBrowserExit(exited, '/nowhere', { pollMs: 5, stuckAfterMs: 1000, quietMs: 1000, latestWrite: async () => 0, onStuck: async (s) => { asked.push(s); return 'force' } })
    expect(wait.forced).toBe(false)
    expect(wait.stuckPrompts).toBe(0)
    expect(asked).toEqual([])
  })

  it('keeps waiting while the data folder is still being written, and never ends it on time alone', async () => {
    const { exited, exit } = fakeExit()
    let write = 0
    const asked: number[] = []
    // Writes every poll for 120 ms (well past stuckAfterMs), then exits by itself.
    const writer = setInterval(() => { write += 1 }, 4)
    setTimeout(() => { clearInterval(writer); exit() }, 120)
    const wait = await waitForBrowserExit(exited, '/nowhere', { pollMs: 5, stuckAfterMs: 20, quietMs: 40, latestWrite: async () => write, onStuck: async (s) => { asked.push(s); return 'force' } })
    expect(wait.forced).toBe(false)
    expect(asked).toEqual([])
  })

  it('asks when nothing is written for a while; 继续等 keeps waiting, 强制结束 ends it', async () => {
    const { exited, exit } = fakeExit()
    const choices: StuckChoice[] = ['wait', 'force']
    let killed = false
    const wait = await waitForBrowserExit(exited, '/nowhere', {
      pollMs: 5,
      stuckAfterMs: 20,
      quietMs: 10,
      latestWrite: async () => 1,
      onStuck: async () => choices.shift()!,
      kill: () => { killed = true; exit() }
    })
    expect(wait.stuckPrompts).toBe(2)
    expect(wait.forced).toBe(true)
    expect(killed).toBe(true)
  })

  it('with no one to ask, only waits', async () => {
    const { exited, exit } = fakeExit()
    setTimeout(exit, 80)
    const wait = await waitForBrowserExit(exited, '/nowhere', { pollMs: 5, stuckAfterMs: 10, quietMs: 5, latestWrite: async () => 1 })
    expect(wait).toMatchObject({ forced: false, stuckPrompts: 0 })
    expect(wait.seconds).toBeGreaterThanOrEqual(0.05)
  })
})

describe('latestProfileWrite', () => {
  it('reads the newest write among the files Chromium saves on the way out, ignoring caches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-exit-'))
    folders.push(dir)
    await mkdir(join(dir, 'Default', 'Network'), { recursive: true })
    await mkdir(join(dir, 'Default', 'Cache'), { recursive: true })
    await writeFile(join(dir, 'Default', 'Network', 'Cookies'), 'x')
    await writeFile(join(dir, 'Default', 'Cache', 'data_0'), 'x')
    const old = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-02-01T00:00:00Z')
    await utimes(join(dir, 'Default', 'Network', 'Cookies'), old, old)
    await utimes(join(dir, 'Default', 'Network'), old, old)
    await utimes(join(dir, 'Default', 'Cache', 'data_0'), newer, newer)
    expect(await latestProfileWrite(dir)).toBe(old.getTime())
    expect(await latestProfileWrite(join(dir, 'missing'))).toBe(0)
  })
})
