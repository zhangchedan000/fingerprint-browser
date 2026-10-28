import { useEffect } from 'react'

/** Where each place was scrolled to, for as long as the app runs. */
const places = new Map<string, number>()

/** Forgets the places whose key starts with this (e.g. a new window's editor, which starts at the top). */
export function forgetScroll(prefix: string): void {
  for (const key of [...places.keys()]) if (key.startsWith(prefix)) places.delete(key)
}

/**
 * Keeps an element's scroll position per key: when the key comes back (the same page, the same
 * window's tab), the element is scrolled to where it was left. Content that arrives late (a list
 * loading, a drawer opening) is waited for, up to about a second. No key: nothing is kept.
 */
export function useScrollMemory(find: () => HTMLElement | null, key: string | undefined): void {
  useEffect(() => {
    if (!key) return
    const wanted = places.get(key) ?? 0
    let target: HTMLElement | null = null
    // While putting the position back, the scroll events are ours (or the old content's), not the user's.
    let restoring = true
    let frames = 0
    let frame = 0
    const onScroll = () => {
      if (!restoring && target) places.set(key, target.scrollTop)
    }
    const tick = () => {
      if (!target) {
        target = find()
        target?.addEventListener('scroll', onScroll, { passive: true })
      }
      if (target) {
        target.scrollTop = wanted
        if (Math.abs(target.scrollTop - wanted) < 2 || frames > 60) {
          // One more frame, so the scroll event of this last move is still ignored.
          frame = requestAnimationFrame(() => { restoring = false })
          return
        }
      }
      frames += 1
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      target?.removeEventListener('scroll', onScroll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- find is stable in what it returns for a key
  }, [key])
}
