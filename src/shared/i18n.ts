import zhCN from './locales/zh-CN.json'
import en from './locales/en.json'
import zhTW from './locales/zh-TW.json'
import ru from './locales/ru.json'
import vi from './locales/vi.json'
import th from './locales/th.json'
import ptBR from './locales/pt-BR.json'
import fr from './locales/fr.json'
import uk from './locales/uk.json'
import es from './locales/es.json'
import tr from './locales/tr.json'
import ja from './locales/ja.json'
import hi from './locales/hi.json'

export const languages = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'th', label: 'ไทย' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'fr', label: 'Français' },
  { value: 'uk', label: 'Українська' },
  { value: 'es', label: 'Español' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'ja', label: '日本語' },
  { value: 'hi', label: 'हिन्दी' }
] as const
export type UiLocale = typeof languages[number]['value']
const catalogs: Record<UiLocale, Record<string, string>> = {
  'zh-CN': zhCN, 'zh-TW': zhTW, en, ru, vi, th, 'pt-BR': ptBR, fr, uk, es, tr, ja, hi
}
let locale: UiLocale = 'zh-CN'
const listeners = new Set<() => void>()

export function resolveLocale(value: string): UiLocale {
  const normalized = value.trim().replace(/_/g, '-').toLowerCase()
  if (/^zh-(tw|hk|mo|hant)(-|$)/.test(normalized)) return 'zh-TW'
  if (/^zh(-|$)/.test(normalized)) return 'zh-CN'
  if (/^pt(-|$)/.test(normalized)) return 'pt-BR'
  return languages.find(item => item.value === normalized.split('-')[0])?.value ?? 'en'
}
export function isUiLocale(value: unknown): value is UiLocale {
  return languages.some(item => item.value === value)
}
export function getLocale(): UiLocale { return locale }
export function setLocale(value: UiLocale): void {
  if (!isUiLocale(value) || value === locale) return
  locale = value
  for (const listener of listeners) listener()
}
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Source-language keys keep text extraction reviewable. Values are bundled;
 * no text, profile data or credentials are sent to a translation service. */
export function t(source: string, ...values: unknown[]): string {
  const translated = catalogs[locale][source] ?? catalogs.en[source] ?? source
  return translated.replace(/\{(\d+)\}/g, (token, index) =>
    Number(index) < values.length ? String(values[Number(index)] ?? '') : token)
}

const quoteMarks: Partial<Record<UiLocale, [string, string]>> = {
  'zh-TW': ['「', '」'], ja: ['「', '」'], fr: ['« ', ' »'], ru: ['«', '»'], uk: ['«', '»']
}
/** Quotes a user-supplied name the way this locale's catalog does. */
export function quote(value: string): string {
  const [open, close] = quoteMarks[locale] ?? ['“', '”']
  return open + value + close
}
/** Short enumerations such as tags or weekdays; never adds “and”, so “etc.” still reads well. */
export function formatList(items: readonly string[]): string {
  return items.join(['zh-CN', 'zh-TW', 'ja'].includes(locale) ? '、' : ', ')
}

/** Joins whole messages, e.g. several problems found in one spreadsheet row. */
export function joinMessages(items: readonly string[]): string {
  return items.join(['zh-CN', 'zh-TW', 'ja'].includes(locale) ? '；' : '; ')
}

const HAN = /[㐀-鿿]/
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const messagePatterns = Object.keys(zhCN)
  // A pattern needs Chinese literal text; '{0}：{1}' alone would match any message.
  .filter(key => /\{\d+\}/.test(key) && HAN.test(key.replace(/\{\d+\}/g, '')))
  // Prefer meaningful literal text, then fewer captures. A space between two
  // captures must not split a nested message such as a GeoIP warning.
  .sort((a, b) => b.replace(/\{\d+\}|\s/g, '').length - a.replace(/\{\d+\}|\s/g, '').length
    || (a.match(/\{\d+\}/g)?.length ?? 0) - (b.match(/\{\d+\}/g)?.length ?? 0))
  .map(key => {
    // A quoted slot (环境“{0}”…) carries a user value such as a profile or extension
    // name. It is inserted unchanged: a profile called “测试” must not become “Test”.
    const slots: Array<{ index: number, quoted: boolean }> = []
    let cursor = 0, pattern = ''
    for (const match of key.matchAll(/\{(\d+)\}/g)) {
      const end = match.index! + match[0].length
      pattern += escapeRegex(key.slice(cursor, match.index)) + '([\\s\\S]*?)'
      slots.push({ index: Number(match[1]), quoted: /[“「『《"'‘]$/.test(key.slice(0, match.index)) && /^[”」』》"'’]/.test(key.slice(end)) })
      cursor = end
    }
    return { key, slots, pattern: new RegExp('^' + pattern + escapeRegex(key.slice(cursor)) + '$') }
  })
// Main-process lists of names: “A”、“B”、“C”
const QUOTED_LIST = /^“[^“”]*”(?:、“[^“”]*”)*$/

function translateText(text: string, depth: number): string {
  if (Object.hasOwn(zhCN, text)) return t(text)
  // Nested messages (an error inside a warning inside a list) stay well under this depth.
  if (depth > 6 || !HAN.test(text)) return text
  for (const { key, slots, pattern } of messagePatterns) {
    const match = pattern.exec(text)
    if (!match) continue
    const values: string[] = []
    slots.forEach((slot, i) => {
      const value = match[i + 1]
      values[slot.index] = slot.quoted ? value
        : QUOTED_LIST.test(value) ? formatList(value.slice(1, -1).split('”、“').map(quote))
          : translateText(value, depth + 1)
    })
    return t(key, ...values)
  }
  // Status lines join complete facts: “1.2.3.4 · 120 ms · 结果已超过 24 小时”
  // or several provider errors separated by “；”.
  for (const separator of [' · ', '；']) {
    if (!text.includes(separator)) continue
    const joiner = separator === '；' && !['zh-TW', 'ja'].includes(locale) ? '; ' : separator
    const parts = text.split(separator), out: string[] = []
    // A run of parts is known when it is a string of its own or fits a message template
    // (“本机 CPU · 本机内存 · 本机 GPU · {0}×{1}” after a template name).
    const known = (run: string) => Object.hasOwn(zhCN, run) || messagePatterns.some(({ pattern }) => pattern.test(run))
    for (let i = 0; i < parts.length;) {
      // The longest known run of parts wins.
      let end = parts.length
      while (end > i + 1 && !known(parts.slice(i, end).join(separator))) end--
      out.push(translateText(parts.slice(i, end).join(separator), depth + 1))
      i = end
    }
    return out.join(joiner)
  }
  return text
}

/** Use only on application-owned status/error text, never user names or notes. */
export function translateMessage(source: string | null | undefined): string {
  if (!source) return source ?? ''
  const clean = source.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  if (locale === 'zh-CN') return clean
  return translateText(clean, 0)
}
