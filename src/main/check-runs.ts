/**
 * Checks (fingerprint, deep) that run in the background, by window or, for a window not saved yet,
 * by its editor session. The editor can close and open again while one runs: it finds the run here
 * and shows it. A check made before a new window's first save is kept with the window once saved.
 */
export interface CheckRun<R, P> {
  /** `profile:<id>`, or `session:<editor session>` until the window is saved. */
  key: string
  profileId?: string
  startedAt: string
  /** The editor's settings key the check was started with. */
  settingsKey?: string
  /** What came in so far (deep check: one result per site). */
  partial: P[]
  result?: R
  promise: Promise<R>
}

export function checkRunKey(profileId?: string, session?: string): string | undefined {
  return profileId ? `profile:${profileId}` : session ? `session:${session}` : undefined
}

export class CheckRuns<R, P = never> {
  private readonly runs = new Map<string, CheckRun<R, P>>()

  /** `save` keeps a finished run with its window; finished runs of unsaved windows wait for adopt(). */
  constructor(private readonly save: (profileId: string, run: CheckRun<R, P>) => Promise<void>, private readonly keepUnsaved = 20) {}

  /** The window's run that is still going (by its id first, then the editor session). */
  running(profileId?: string, session?: string): CheckRun<R, P> | undefined {
    for (const key of [checkRunKey(profileId), checkRunKey(undefined, session)]) {
      const run = key ? this.runs.get(key) : undefined
      if (run && !run.result) return run
    }
    return undefined
  }

  /** Starts a check, or joins the one already running for this window. */
  start(profileId: string | undefined, session: string | undefined, settingsKey: string | undefined, work: (run: CheckRun<R, P>) => Promise<R>): Promise<R> {
    const current = this.running(profileId, session)
    if (current) return current.promise
    const key = checkRunKey(profileId, session)
    const run: CheckRun<R, P> = { key: key ?? '', profileId, startedAt: new Date().toISOString(), settingsKey, partial: [], promise: Promise.resolve(undefined as R) }
    run.promise = work(run).then(async (result) => {
      run.result = result
      if (run.profileId) {
        if (this.runs.get(run.key) === run) this.runs.delete(run.key)
        await this.save(run.profileId, run)
      } else {
        this.trim()
      }
      return result
    }, (error: unknown) => {
      if (this.runs.get(run.key) === run) this.runs.delete(run.key)
      throw error
    })
    if (key) {
      this.runs.set(key, run)
      this.trim()
    }
    return run.promise
  }

  /** A new window saved from this editor session takes the session's check: saved now if done, when done otherwise. */
  async adopt(session: string | undefined, profileId: string): Promise<void> {
    const key = checkRunKey(undefined, session)
    const run = key ? this.runs.get(key) : undefined
    if (!run || run.profileId) return
    this.runs.delete(run.key)
    run.profileId = profileId
    run.key = checkRunKey(profileId)!
    if (run.result) await this.save(profileId, run)
    else this.runs.set(run.key, run)
  }

  /** Finished checks of windows never saved: only the latest few are kept. */
  private trim(): void {
    const unsaved = [...this.runs.values()].filter((run) => run.result && !run.profileId)
    for (const run of unsaved.slice(0, Math.max(0, unsaved.length - this.keepUnsaved))) this.runs.delete(run.key)
  }
}
