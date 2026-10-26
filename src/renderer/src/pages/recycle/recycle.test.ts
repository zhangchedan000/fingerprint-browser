import { describe, expect, it } from 'vitest'
import { daysLeft } from './retention'

describe('recycle bin retention', () => {
  it('counts the days left before automatic deletion', () => {
    const now = Date.parse('2026-10-16T12:00:00Z')
    expect(daysLeft('2026-10-15T12:00:00Z', 30, now)).toBe(29)
    expect(daysLeft('2026-09-01T00:00:00Z', 30, now)).toBe(0)
    expect(daysLeft('2026-10-15T12:00:00Z', 0, now)).toBeUndefined()
  })
})
