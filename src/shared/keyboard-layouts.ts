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

/** Every layout a Windows language starts with, as Windows names them, by name. */
export const KEYBOARD_LAYOUTS: ReadonlyArray<{ klid: string; name: string }> = Object.entries(LAYOUTS)
  .map(([klid, layout]) => ({ klid, name: layout.name }))
  .sort((a, b) => a.name.localeCompare(b.name))

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
