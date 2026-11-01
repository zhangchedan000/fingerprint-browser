/**
 * Language data taken from Chromium itself (156 source), not made up:
 *
 * - CHROME_UI_LOCALES: build/config/locales.gni, all_chrome_locales minus extended_locales and
 *   pseudolocales — the interface languages Chrome ships on Windows, macOS and Linux.
 * - CHROME_ACCEPT_LANGUAGES: IDS_ACCEPT_LANGUAGES from components/components_locale_settings.grd
 *   and its components/strings/components_locale_settings_*.xtb translations. It is the default
 *   intl.accept_languages of a profile whose interface is in that language, so navigator.languages
 *   is this list and navigator.language its first entry. Locales without a translation fall back
 *   to the English value (the grd has fallback_to_english).
 *
 * Which language a country speaks comes from CLDR likely subtags (Intl.Locale "und-XX"
 * maximize), the same data Chromium's ICU uses.
 */
export const CHROME_UI_LOCALES: readonly string[] = [
  'af', 'am', 'ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en-GB', 'en-US', 'es', 'es-419', 'et',
  'fa', 'fi', 'fil', 'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'lv', 'ml',
  'mr', 'ms', 'nb', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta', 'te',
  'th', 'tr', 'uk', 'ur', 'vi', 'zh-CN', 'zh-TW'
]

const ENGLISH_ACCEPT_LANGUAGES = 'en-US,en'

/** IDS_ACCEPT_LANGUAGES per interface language ("no" in the xtb files is nb). */
const CHROME_ACCEPT_LANGUAGES: Readonly<Record<string, string>> = {
  am: 'am,en-GB,en',
  ar: 'ar,en-US,en',
  bg: 'bg-BG,bg',
  bn: 'bn-IN,bn,en-US,en',
  ca: 'ca-ES,ca',
  cs: 'cs-CZ,cs',
  da: 'da-DK,da,en-US,en',
  de: 'de-DE,de,en-US,en',
  el: 'el-GR,el',
  'en-GB': 'en-GB,en-US,en',
  'en-US': ENGLISH_ACCEPT_LANGUAGES,
  es: 'es-ES,es',
  'es-419': 'es-419,es',
  et: 'et-EE,et,en-US,en',
  fa: 'fa,en-US,en',
  fi: 'fi-FI,fi,en-US,en',
  fil: 'fil,fil-PH,tl,en-US,en',
  fr: 'fr-FR,fr,en-US,en',
  gu: 'gu-IN,gu,hi-IN,hi,en-US,en',
  he: 'he-IL,he,en-US,en',
  hi: 'hi-IN,hi,en-US,en',
  hr: 'hr-HR,hr,en-US,en',
  hu: 'hu-HU,hu,en-US,en',
  id: 'id-ID,id,en-US,en',
  it: 'it-IT,it,en-US,en',
  ja: 'ja,en-US,en',
  kn: 'kn-IN,kn,en-US,en',
  ko: 'ko-KR,ko,en-US,en',
  lt: 'lt,en-US,en,ru,pl',
  lv: 'lv-LV,lv,en-US,en',
  ml: 'ml-IN,ml,en-US,en',
  mr: 'mr-IN,mr,hi-IN,hi,en-US,en',
  nb: 'nb-NO,nb,no,nn,en-US,en',
  nl: 'nl-NL,nl,en-US,en',
  pl: 'pl-PL,pl,en-US,en',
  'pt-BR': 'pt-BR,pt,en-US,en',
  'pt-PT': 'pt-PT,pt,en-US,en',
  ro: 'ro-RO,ro,en-US,en',
  ru: 'ru-RU,ru,en-US,en',
  sk: 'sk-SK,sk,cs,en-US,en',
  sl: 'sl-SI,sl,en-GB,en',
  sr: 'sr-RS,sr,en-US,en',
  sv: 'sv-SE,sv,en-US,en',
  sw: 'sw,en-GB,en',
  ta: 'ta-IN,ta,en-US,en',
  te: 'te-IN,te,hi-IN,hi,en-US,en',
  th: 'th-TH,th',
  tr: 'tr-TR,tr,en-US,en',
  uk: 'uk-UA,uk,en-US,en',
  vi: 'vi-VN,vi,fr-FR,fr,en-US,en',
  'zh-CN': 'zh-CN,zh',
  'zh-TW': 'zh-TW,zh,en-US,en'
}

/** Regions CLDR's language matching groups with American English ($enUS); the rest prefer en-GB. */
const AMERICAN_ENGLISH = new Set(['US', 'PR', 'AS', 'GU', 'MP', 'UM', 'VI'])
/** Spanish outside Spain ("419" = Latin America; CLDR also counts the US Spanish speakers there). */
const EUROPEAN_SPANISH = new Set(['ES', 'EA', 'IC', 'GQ', 'PH'])
/** Old or alternative codes Chromium accepts for the same language. */
const ALIASES: Readonly<Record<string, string>> = { iw: 'he', in: 'id', tl: 'fil', no: 'nb', nn: 'nb' }

function maximized(tag: string): Intl.Locale | undefined {
  try {
    return new Intl.Locale(tag.trim().replace(/_/g, '-')).maximize()
  } catch {
    return undefined
  }
}

/**
 * The interface language Chrome picks for a system language (ui/base/l10n GetApplicationLocale:
 * an exact match, otherwise the closest shipped locale of the same language), en-US when Chrome
 * has none for it.
 */
export function chromeUiLocaleFor(tag: string): string {
  const exact = CHROME_UI_LOCALES.find((locale) => locale.toLowerCase() === tag.trim().toLowerCase())
  if (exact) return exact
  const locale = maximized(tag)
  if (!locale) return 'en-US'
  const language = ALIASES[locale.language] ?? locale.language
  const region = locale.region ?? ''
  switch (language) {
    case 'en': return AMERICAN_ENGLISH.has(region) ? 'en-US' : 'en-GB'
    case 'es': return EUROPEAN_SPANISH.has(region) ? 'es' : 'es-419'
    case 'pt': return region === 'BR' ? 'pt-BR' : 'pt-PT'
    case 'zh': return locale.script === 'Hant' ? 'zh-TW' : 'zh-CN'
    default: return CHROME_UI_LOCALES.includes(language) ? language : 'en-US'
  }
}

/** navigator.languages of a profile with this interface language (IDS_ACCEPT_LANGUAGES). */
export function chromeAcceptLanguagesFor(uiLocale: string): string {
  return CHROME_ACCEPT_LANGUAGES[chromeUiLocaleFor(uiLocale)] ?? ENGLISH_ACCEPT_LANGUAGES
}

/** The language most people in a country use, per CLDR likely subtags ("DE" → "de-DE"). */
export function countryLanguage(countryCode: string): string | undefined {
  const locale = maximized(`und-${countryCode}`)
  if (!locale?.region || locale.region !== countryCode.toUpperCase()) return undefined
  return `${locale.language}-${locale.region}`
}

/** A browser with this interface language: navigator.language, navigator.languages and the UI locale. */
export function chromeLanguageProfile(uiLocale: string): { language: string; acceptLanguages: string; uiLocale: string } {
  const ui = chromeUiLocaleFor(uiLocale)
  const acceptLanguages = chromeAcceptLanguagesFor(ui)
  return { language: acceptLanguages.split(',')[0], acceptLanguages, uiLocale: ui }
}
