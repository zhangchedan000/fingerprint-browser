import { describe, expect, it } from 'vitest'
import { batchAssignees } from './batch-assign'

describe('assigning several cloud windows at once', () => {
  it('adds members, replaces the list, or takes members back', () => {
    expect(batchAssignees(['a', 'b'], ['b', 'c'], 'add')).toEqual(['a', 'b', 'c'])
    expect(batchAssignees(['a', 'b'], ['c'], 'set')).toEqual(['c'])
    expect(batchAssignees(['a', 'b'], [], 'set')).toEqual([])
    expect(batchAssignees(['a', 'b'], ['a', 'x'], 'remove')).toEqual(['b'])
  })
})
