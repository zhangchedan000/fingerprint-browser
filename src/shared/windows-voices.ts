import { closestLocale } from './locale-match'
/**
 * The Windows voices the Prism kernel can list for a window (patch 012, names from the Windows
 * language packs). A window lists its language's voices unless it picks another locale here.
 */
export interface WindowsVoiceLocale { locale: string; voices: string[] }

export const WINDOWS_VOICE_LOCALES: readonly WindowsVoiceLocale[] = [
  { locale: 'ar-eg', voices: ['Hoda'] },
  { locale: 'ar-sa', voices: ['Naayf'] },
  { locale: 'bg-bg', voices: ['Ivan'] },
  { locale: 'ca-es', voices: ['Herena'] },
  { locale: 'cs-cz', voices: ['Jakub'] },
  { locale: 'da-dk', voices: ['Helle'] },
  { locale: 'de-at', voices: ['Michael'] },
  { locale: 'de-ch', voices: ['Karsten'] },
  { locale: 'de-de', voices: ['Hedda', 'Katja', 'Stefan'] },
  { locale: 'el-gr', voices: ['Stefanos'] },
  { locale: 'en-au', voices: ['Catherine', 'James'] },
  { locale: 'en-ca', voices: ['Linda', 'Richard'] },
  { locale: 'en-gb', voices: ['George', 'Hazel', 'Susan'] },
  { locale: 'en-ie', voices: ['Sean'] },
  { locale: 'en-in', voices: ['Heera', 'Ravi'] },
  { locale: 'en-us', voices: ['David', 'Mark', 'Zira'] },
  { locale: 'es-es', voices: ['Helena', 'Laura', 'Pablo'] },
  { locale: 'es-mx', voices: ['Raul', 'Sabina'] },
  { locale: 'fi-fi', voices: ['Heidi'] },
  { locale: 'fr-ca', voices: ['Caroline', 'Claude', 'Nathalie'] },
  { locale: 'fr-ch', voices: ['Guillaume'] },
  { locale: 'fr-fr', voices: ['Hortense', 'Julie', 'Paul'] },
  { locale: 'he-il', voices: ['Asaf'] },
  { locale: 'hi-in', voices: ['Hemant', 'Kalpana'] },
  { locale: 'hr-hr', voices: ['Matej'] },
  { locale: 'hu-hu', voices: ['Szabolcs'] },
  { locale: 'id-id', voices: ['Andika'] },
  { locale: 'it-it', voices: ['Cosimo', 'Elsa'] },
  { locale: 'ja-jp', voices: ['Ayumi', 'Haruka', 'Ichiro', 'Sayaka'] },
  { locale: 'ko-kr', voices: ['Heami'] },
  { locale: 'ms-my', voices: ['Rizwan'] },
  { locale: 'nb-no', voices: ['Jon'] },
  { locale: 'nl-be', voices: ['Bart'] },
  { locale: 'nl-nl', voices: ['Frank'] },
  { locale: 'pl-pl', voices: ['Adam', 'Paulina'] },
  { locale: 'pt-br', voices: ['Daniel', 'Maria'] },
  { locale: 'pt-pt', voices: ['Helia'] },
  { locale: 'ro-ro', voices: ['Andrei'] },
  { locale: 'ru-ru', voices: ['Irina', 'Pavel'] },
  { locale: 'sk-sk', voices: ['Filip'] },
  { locale: 'sl-si', voices: ['Lado'] },
  { locale: 'sv-se', voices: ['Bengt'] },
  { locale: 'ta-in', voices: ['Valluvar'] },
  { locale: 'th-th', voices: ['Pattara'] },
  { locale: 'tr-tr', voices: ['Tolga'] },
  { locale: 'vi-vn', voices: ['An'] },
  { locale: 'zh-cn', voices: ['Huihui', 'Kangkang', 'Yaoyao'] },
  { locale: 'zh-hk', voices: ['Danny', 'Tracy'] },
  { locale: 'zh-tw', voices: ['Hanhan', 'Yating', 'Zhiwei'] },
]

/**
 * The Windows voices a system language comes with: its own locale, else the one for its most likely
 * country (fr → fr-fr, not fr-ca). Written into a window when it is saved.
 */
export function voiceLocaleForLanguage(language: string): string {
  const lang = language.trim().toLowerCase().replace('_', '-')
  if (!WINDOWS_VOICE_LOCALES.some((item) => item.locale === lang) && (lang.startsWith('zh-hk') || lang.startsWith('zh-mo') || lang.includes('hant'))) {
    return lang.startsWith('zh-tw') ? 'zh-tw' : 'zh-hk'
  }
  return closestLocale(lang, WINDOWS_VOICE_LOCALES.map((item) => item.locale)) ?? 'en-us'
}

/**
 * The kernel's own pick when no voice locale is passed (WindowsVoiceLocaleFor): what windows saved
 * before 0.5.16 always had. Written into them once, unchanged.
 */
export function kernelVoiceLocaleFor(language: string): string {
  const lang = language.trim().toLowerCase().replace('_', '-')
  if (WINDOWS_VOICE_LOCALES.some((item) => item.locale === lang)) return lang
  if (lang.startsWith('es-')) return 'es-mx'
  if (lang.startsWith('zh-hk') || lang.startsWith('zh-mo') || lang.includes('hant')) return 'zh-hk'
  const primary = lang.split('-')[0]
  return WINDOWS_VOICE_LOCALES.find((item) => item.locale.split('-')[0] === primary)?.locale ?? 'en-us'
}

export function isVoiceLocale(value: string): boolean {
  return WINDOWS_VOICE_LOCALES.some((item) => item.locale === value)
}
