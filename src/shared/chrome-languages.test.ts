import { expect, it } from 'vitest'
import { CHROME_UI_LOCALES, chromeAcceptLanguagesFor, chromeLanguageProfile, chromeUiLocaleFor, countryLanguage } from './chrome-languages'

it('picks the interface language Chrome ships for a system language', () => {
  expect(chromeUiLocaleFor('de-CH')).toBe('de')
  expect(chromeUiLocaleFor('en-AU')).toBe('en-GB')
  expect(chromeUiLocaleFor('en-PR')).toBe('en-US')
  expect(chromeUiLocaleFor('es-AR')).toBe('es-419')
  expect(chromeUiLocaleFor('es-ES')).toBe('es')
  expect(chromeUiLocaleFor('pt-AO')).toBe('pt-PT')
  expect(chromeUiLocaleFor('zh-HK')).toBe('zh-TW')
  expect(chromeUiLocaleFor('zh-SG')).toBe('zh-CN')
  expect(chromeUiLocaleFor('iw')).toBe('he')
  expect(chromeUiLocaleFor('nn-NO')).toBe('nb')
  expect(chromeUiLocaleFor('kk-KZ')).toBe('en-US')
})

it('uses IDS_ACCEPT_LANGUAGES, English for locales without a translation', () => {
  expect(chromeAcceptLanguagesFor('ja')).toBe('ja,en-US,en')
  expect(chromeAcceptLanguagesFor('ms')).toBe('en-US,en')
  expect(chromeLanguageProfile('zh-CN')).toEqual({ language: 'zh-CN', acceptLanguages: 'zh-CN,zh', uiLocale: 'zh-CN' })
  for (const locale of CHROME_UI_LOCALES) expect(chromeUiLocaleFor(locale)).toBe(locale)
})

it('takes the language of a country from CLDR', () => {
  expect(countryLanguage('DE')).toBe('de-DE')
  expect(countryLanguage('CH')).toBe('de-CH')
  expect(countryLanguage('HK')).toBe('zh-HK')
  expect(countryLanguage('ZZ')).toBeUndefined()
})
