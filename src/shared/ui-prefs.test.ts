import { describe, expect, it } from 'vitest'
import { arrangeRows, movedRows, validUiPrefs, withTable } from './ui-prefs'

const rows = (...ids: string[]) => ids.map((id) => ({ id }))
const ids = (list: Array<{ id: string }>) => list.map((row) => row.id)

describe('rows in the user\'s own order', () => {
  it('keeps the page order until rows are dragged', () => {
    expect(ids(arrangeRows(rows('a', 'b', 'c'), undefined))).toEqual(['a', 'b', 'c'])
  })

  it('shows dragged rows in their order; new rows keep their default place', () => {
    // Saved c, a, b; a new window "n" is first by default (newest first) and stays first.
    expect(ids(arrangeRows(rows('n', 'a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['n', 'c', 'a', 'b'])
    // A row new in the middle goes after the row before it by default.
    expect(ids(arrangeRows(rows('a', 'x', 'b'), ['b', 'a']))).toEqual(['b', 'a', 'x'])
  })

  it('moves a row before or after another, keeping rows not shown now in place', () => {
    expect(movedRows(undefined, ['a', 'b', 'c'], 'c', 'a', true)).toEqual(['c', 'a', 'b'])
    expect(movedRows(['a', 'b', 'c'], ['a', 'b', 'c'], 'a', 'c', false)).toEqual(['b', 'c', 'a'])
    // A filtered view (b and c shown) moves c before b; a, not shown, keeps its place.
    expect(movedRows(['a', 'b', 'c'], ['b', 'c'], 'c', 'b', true)).toEqual(['a', 'c', 'b'])
    // A shown row not saved yet is placed where it was shown first.
    expect(movedRows(['a', 'b'], ['n', 'a', 'b'], 'b', 'n', true)).toEqual(['b', 'n', 'a'])
  })
})

describe('table settings that follow the account', () => {
  it('keeps widths, order, names, added columns, what is written in them and the row order', () => {
    const prefs = validUiPrefs({ tables: { 't': {
      widths: { name: 200 }, order: ['b', 'a'], hidden: ['c'], titles: { a: ' 店铺 ' },
      custom: [{ id: 'custom:1', title: '负责人' }], values: { w1: { 'custom:1': ' 小王 ' } }, rows: ['w2', 'w1']
    } } })
    expect(prefs).toEqual({ tables: { t: {
      widths: { name: 200 }, order: ['b', 'a'], hidden: ['c'], titles: { a: '店铺' },
      custom: [{ id: 'custom:1', title: '负责人' }], values: { w1: { 'custom:1': '小王' } }, rows: ['w2', 'w1']
    } } })
  })

  it('drops what is malformed, values of columns that no longer exist, and empty tables', () => {
    expect(validUiPrefs({ tables: { t: {
      widths: { a: 'wide', b: 5 }, custom: [{ id: 'not-custom', title: 'x' }, { id: 'custom:2', title: '' }],
      values: { w1: { 'custom:9': 'gone' } }, rows: [1, 'w1', 'w1']
    } } })).toEqual({ tables: { t: { rows: ['w1'] } } })
    expect(validUiPrefs({ tables: { t: {} } })).toBeUndefined()
    expect(validUiPrefs('nonsense')).toBeUndefined()
  })

  it('changes one table and leaves the others', () => {
    const start = withTable(undefined, 'a', { rows: ['1'] })
    const both = withTable(start, 'b', { hidden: ['x'] })
    expect(both).toEqual({ tables: { a: { rows: ['1'] }, b: { hidden: ['x'] } } })
    expect(withTable(both, 'a', undefined)).toEqual({ tables: { b: { hidden: ['x'] } } })
  })
})
