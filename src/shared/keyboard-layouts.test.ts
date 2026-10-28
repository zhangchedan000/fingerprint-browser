import { describe, expect, it } from 'vitest'
import { keyboardLayoutFor, keyboardLayoutName, keyboardLayoutText } from './keyboard-layouts'

describe('keyboard layouts', () => {
  it('finds the layout by the full tag, then by the language', () => {
    expect(keyboardLayoutFor('de-CH')).toBe('00000807')
    expect(keyboardLayoutName('00000807')).toBe('Swiss German')
    expect(keyboardLayoutFor('de-DE')).toBe('00000407')
    expect(keyboardLayoutFor('es-MX')).toBe('0000080A')
    expect(keyboardLayoutFor('es-ES')).toBe('0000040A')
    expect(keyboardLayoutFor('fr-CA')).toBe('00001009')
    expect(keyboardLayoutFor('zh-CN')).toBe('00000804')
    expect(keyboardLayoutFor('xx-YY')).toBeUndefined()
  })

  it('lists the keys in Chrome\'s order', () => {
    const lines = keyboardLayoutText('00000409')!.trim().split('\n')
    expect(lines[0]).toBe('Backquote\t`')
    expect(lines).toHaveLength(48)
  })
})
