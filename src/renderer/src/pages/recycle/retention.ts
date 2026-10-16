import type { AppSettings } from '../../../../shared/types'

const DAY = 24 * 60 * 60 * 1000

/** Days until automatic deletion, or undefined when the bin keeps items forever. */
export function daysLeft(deletedAt: string, retention: AppSettings['recycleRetentionDays'], now = Date.now()): number | undefined {
  if (!retention) return undefined
  const age = Math.floor((now - Date.parse(deletedAt)) / DAY)
  return Math.max(0, retention - age)
}

