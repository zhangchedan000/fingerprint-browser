import data from './keyboard-layouts.json'

/**
 * navigator.keyboard.getLayoutMap() of a fresh Windows in a language: Microsoft's default input
 * profiles per language/region, and Chrome reports the first layout of that list that types a-z
 * (Russian, Greek or Arabic Windows also list the US keyboard, so they report it). The maps were
 * read from Windows' own layouts with Chrome's steps (keyboard-layouts.json, "source").
 */
const BY_LOCALE: Readonly<Record<string, string>> = data.byLocale
const LAYOUTS: Readonly<Record<string, { name: string; map: Record<string, string> }>> = data.layouts

/** The Windows keyboard layout id (KLID, "00000407") for a language tag: the tag, then its language. */
export function keyboardLayoutFor(language: string): string | undefined {
  const parts = language.trim().replace(/_/g, '-').split('-').filter(Boolean)
  for (let length = parts.length; length > 0; length--) {
    const tag = parts.slice(0, length).join('-')
    const match = Object.keys(BY_LOCALE).find((key) => key.toLowerCase() === tag.toLowerCase())
    if (match) return BY_LOCALE[match]
  }
  return undefined
}

/**
 * The language each layout is Windows' own for: the language id in the layout id's last four digits,
 * as Windows names it (CultureInfo.GetCultureInfo(0x0407).Name is "de-DE"; read on Windows 11).
 */
const LAYOUT_LOCALES: Readonly<Record<string, string>> = {
  '00000404': 'zh-TW', '00000405': 'cs-CZ', '00000406': 'da-DK', '00000407': 'de-DE', '00000409': 'en-US',
  '0000040A': 'es-ES', '0000040B': 'fi-FI', '0000040C': 'fr-FR', '0000040E': 'hu-HU', '0000040F': 'is-IS',
  '00000410': 'it-IT', '00000411': 'ja-JP', '00000412': 'ko-KR', '00000414': 'nb-NO', '00000415': 'pl-PL',
  '00000416': 'pt-BR', '0000041A': 'hr-HR', '0000041B': 'sk-SK', '0000041C': 'sq-AL', '0000041D': 'sv-SE',
  '0000041F': 'tr-TR', '00000423': 'be-BY', '00000424': 'sl-SI', '00000425': 'et-EE', '0000042A': 'vi-VN',
  '0000042C': 'az-Latn-AZ', '00000432': 'tn-ZA', '0000043A': 'mt-MT', '0000043B': 'se-NO',
  '00000442': 'tk-TM', '00000452': 'cy-GB', '00000461': 'ne-NP', '00000468': 'ha-Latn-NG',
  '0000046A': 'yo-NG', '0000046C': 'nso-ZA', '0000046E': 'lb-LU', '00000470': 'ig-NG', '00000474': 'gn-PY',
  '00000475': 'haw-US', '00000481': 'mi-NZ', '00000488': 'wo-SN', '00000804': 'zh-CN', '00000807': 'de-CH',
  '00000809': 'en-GB', '0000080A': 'es-MX', '0000080C': 'fr-BE', '00000813': 'nl-BE', '00000816': 'pt-PT',
  '0000081A': 'sr-Latn-CS', '0000083B': 'se-SE', '0000085D': 'iu-Latn-CA', '0000085F': 'tzm-Latn-DZ',
  '00001009': 'en-CA', '0000100C': 'fr-CH', '00001409': 'en-NZ', '00001809': 'en-IE', '00004009': 'en-IN',
  '00010418': 'ro-RO', '00010427': 'lt-LT', '00010444': 'tt-RU', '0001045D': 'iu-Cans-CA',
  '0001083B': 'se-SE', '00011809': 'en-IE', '00020409': 'en-US', '00020426': 'lv-LV', '0002042B': 'hy-AM',
  '0002042E': 'hsb-DE'
}

/** Every layout a Windows language starts with: its name as Windows lists it and its language, by language. */
export const KEYBOARD_LAYOUTS: ReadonlyArray<{ klid: string; name: string; locale: string }> = Object.entries(LAYOUTS)
  .map(([klid, layout]) => ({ klid, name: layout.name, locale: LAYOUT_LOCALES[klid] ?? '' }))
  .sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name))

/** The language a layout is Windows' own for ("0000080A" → "es-MX"). */
export function keyboardLayoutLocale(klid: string): string | undefined {
  return LAYOUT_LOCALES[klid]
}

export function isKeyboardLayout(klid: string): boolean {
  return Object.prototype.hasOwnProperty.call(LAYOUTS, klid)
}

/** The layout's name as Windows lists it ("German", "Latin American"). */
export function keyboardLayoutName(klid: string): string | undefined {
  return LAYOUTS[klid]?.name
}

/** What --fingerprint-keyboard-layout carries (base64): one "<code>\t<key>" line per key, in Chrome's order. */
export function keyboardLayoutText(klid: string): string | undefined {
  const map = LAYOUTS[klid]?.map
  if (!map) return undefined
  return data.keys.filter((code) => map[code] !== undefined).map((code) => `${code}\t${map[code]}\n`).join('')
}
