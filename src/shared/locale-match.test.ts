import { describe, expect, it } from 'vitest'
import { mediaLocaleFor } from './media-devices'
import { voiceLocaleForLanguage } from './windows-voices'

describe('the voices and device names a system language comes with', () => {
  it('takes the language in its own country, and Latin American Spanish as Mexico\'s', () => {
    expect(['fr', 'de', 'es', 'es-419', 'pt-BR', 'en-US', 'en-GB', 'zh-CN', 'zh-TW', 'ja'].map(voiceLocaleForLanguage))
      .toEqual(['fr-fr', 'de-de', 'es-es', 'es-mx', 'pt-br', 'en-us', 'en-gb', 'zh-cn', 'zh-tw', 'ja-jp'])
    expect(['fr', 'de', 'es', 'es-419', 'pt-BR', 'en-US', 'en-GB', 'zh-CN', 'zh-TW', 'zh-HK', 'ja'].map(mediaLocaleFor))
      .toEqual(['fr-fr', 'de-de', 'es-es', 'es-mx', 'pt-br', 'en-us', 'en-gb', 'zh-cn', 'zh-tw', 'zh-tw', 'ja-jp'])
    expect(voiceLocaleForLanguage('zh-HK')).toBe('zh-hk')
    expect(mediaLocaleFor('xx')).toBe('en-us')
  })
})
