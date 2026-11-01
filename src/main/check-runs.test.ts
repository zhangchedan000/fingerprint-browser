import { describe, expect, it } from 'vitest'
import { CheckRuns, type CheckRun } from './check-runs'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function runs() {
  const saved: Array<[string, string | undefined]> = []
  const store = new CheckRuns<string, string>(async (profileId, run: CheckRun<string, string>) => { saved.push([profileId, run.result]) }, 2)
  return { store, saved }
}

describe('background checks', () => {
  it('is found again while it runs and saved with the window when done', async () => {
    const { store, saved } = runs()
    const work = deferred<string>()
    const promise = store.start('w1', 's1', 'k', async (run) => { run.partial.push('site A'); return work.promise })
    await Promise.resolve()
    const running = store.running('w1')
    expect(running?.partial).toEqual(['site A'])
    expect(running?.settingsKey).toBe('k')
    // A second click (or a reopened editor) joins the same run.
    expect(store.start('w1', 's2', 'k', async () => 'other')).toBe(promise)
    work.resolve('done')
    expect(await promise).toBe('done')
    expect(saved).toEqual([['w1', 'done']])
    expect(store.running('w1')).toBeUndefined()
  })

  it('keeps the check of a window not saved yet and stores it with the window once saved', async () => {
    const { store, saved } = runs()
    expect(await store.start(undefined, 's1', 'k', async () => 'early')).toBe('early')
    expect(saved).toEqual([])
    await store.adopt('s1', 'w1')
    expect(saved).toEqual([['w1', 'early']])
    // Taken once only.
    await store.adopt('s1', 'w2')
    expect(saved).toEqual([['w1', 'early']])
  })

  it('stores a check still running when the new window is saved, under the window', async () => {
    const { store, saved } = runs()
    const work = deferred<string>()
    const promise = store.start(undefined, 's1', 'k', () => work.promise)
    await store.adopt('s1', 'w1')
    expect(store.running('w1')?.key).toBe('profile:w1')
    expect(store.running(undefined, 's1')).toBeUndefined()
    work.resolve('late')
    await promise
    expect(saved).toEqual([['w1', 'late']])
    expect(store.running('w1')).toBeUndefined()
  })

  it('forgets a failed check so the next click starts again', async () => {
    const { store, saved } = runs()
    await expect(store.start('w1', undefined, undefined, async () => { throw new Error('proxy down') })).rejects.toThrow('proxy down')
    expect(store.running('w1')).toBeUndefined()
    expect(await store.start('w1', undefined, undefined, async () => 'ok')).toBe('ok')
    expect(saved).toEqual([['w1', 'ok']])
  })

  it('keeps only the latest finished checks of windows never saved', async () => {
    const { store, saved } = runs()
    for (const session of ['a', 'b', 'c']) await store.start(undefined, session, undefined, async () => session)
    await store.adopt('a', 'w-a')
    await store.adopt('c', 'w-c')
    expect(saved).toEqual([['w-c', 'c']])
  })
})
