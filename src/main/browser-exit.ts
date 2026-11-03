import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Waiting for a browser to finish and exit by itself. A Chromium that exits normally has written
 * everything it keeps (cookies changed in the last seconds, site storage, saved passwords), so its
 * exit is the sign it is done; ending it at a fixed time could cut a write off half way (the cookies
 * just imported were lost that way, 3.110). It is only ended when it looks stuck (still running after
 * `stuckAfterMs`, and nothing in its data folder written for `quietMs`) and the user (onStuck) says so.
 */

export type StuckChoice = 'wait' | 'force'

export interface ExitWait {
  /** Seconds from the close request to the exit (or to the forced end). */
  seconds: number
  /** Ended because the user chose 强制结束. */
  forced: boolean
  /** How many times it looked stuck. */
  stuckPrompts: number
}

export interface ExitWaitOptions {
  stuckAfterMs?: number
  quietMs?: number
  pollMs?: number
  /** Asked each time it looks stuck: 'wait' keeps waiting (asked again later), 'force' ends it. No hook: keeps waiting. */
  onStuck?: (seconds: number) => Promise<StuckChoice>
  /** Ends the process (on 'force'). */
  kill?: () => void
  /** The newest write time in the data folder (tests replace it). */
  latestWrite?: (dataDir: string) => Promise<number>
}

/** What Chromium writes while it shuts down: cookies, site storage, sessions, preferences, passwords, history. */
const WATCHED = [
  'Local State',
  join('Default', 'Network'),
  join('Default', 'Cookies'),
  join('Default', 'Local Storage'),
  join('Default', 'Session Storage'),
  join('Default', 'IndexedDB'),
  join('Default', 'Sessions'),
  join('Default', 'Preferences'),
  join('Default', 'Secure Preferences'),
  join('Default', 'Login Data'),
  join('Default', 'Web Data'),
  join('Default', 'History')
]
const MAX_FILES = 4000

/** The newest modification time of the files Chromium writes on the way out (0 when none). */
export async function latestProfileWrite(dataDir: string): Promise<number> {
  let newest = 0
  let seen = 0
  const visit = async (path: string): Promise<void> => {
    if (seen >= MAX_FILES) return
    let info
    try {
      info = await stat(path)
    } catch {
      return
    }
    seen += 1
    newest = Math.max(newest, info.mtimeMs)
    if (!info.isDirectory()) return
    let names: string[]
    try {
      names = await readdir(path)
    } catch {
      return
    }
    for (const name of names) await visit(join(path, name))
  }
  for (const relative of WATCHED) await visit(join(dataDir, relative))
  return newest
}

/** Waits until `exited` settles; see the top of this file. */
export async function waitForBrowserExit(exited: Promise<unknown>, dataDir: string, options: ExitWaitOptions = {}): Promise<ExitWait> {
  const stuckAfterMs = options.stuckAfterMs ?? 30_000
  const quietMs = options.quietMs ?? 10_000
  const pollMs = options.pollMs ?? 2_000
  const latestWrite = options.latestWrite ?? latestProfileWrite
  const started = Date.now()
  let done = false
  void exited.then(() => { done = true }, () => { done = true })
  let lastWrite = await latestWrite(dataDir).catch(() => 0)
  let lastChange = Date.now()
  let askAfter = started + stuckAfterMs
  let stuckPrompts = 0
  const seconds = () => Math.round((Date.now() - started) / 100) / 10
  while (!done) {
    await Promise.race([exited.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, pollMs))])
    if (done) break
    const write = await latestWrite(dataDir).catch(() => lastWrite)
    if (write !== lastWrite) {
      lastWrite = write
      lastChange = Date.now()
    }
    const now = Date.now()
    if (now < askAfter || now - lastChange < quietMs || !options.onStuck) continue
    stuckPrompts += 1
    const choice = await options.onStuck(Math.round((now - started) / 1000))
    if (done) break
    if (choice === 'force') {
      options.kill?.()
      // A process that ignores even the kill is left to the caller (it checks what is still running).
      await Promise.race([exited.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 10_000))])
      return { seconds: seconds(), forced: true, stuckPrompts }
    }
    // 继续等: asked again only after another full wait.
    askAfter = Date.now() + stuckAfterMs
  }
  return { seconds: seconds(), forced: false, stuckPrompts }
}
