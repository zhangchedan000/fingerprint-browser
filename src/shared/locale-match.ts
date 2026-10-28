/**
 * The entry of `list` (lower-case locales such as "fr-fr") for a language: the language itself;
 * else Spanish of Latin America (es-419, es-ar…) as Mexico's; else the language in its most likely
 * country (CLDR likely subtags: fr → fr-fr, de → de-de, en → en-us); else the first of the language.
 */
export function closestLocale(language: string, list: readonly string[]): string | undefined {
  const lang = language.trim().toLowerCase().replace(/_/g, '-')
  if (list.includes(lang)) return lang
  const primary = lang.split('-')[0]
  if (primary === 'es' && lang !== 'es' && list.includes('es-mx')) return 'es-mx'
  try {
    const region = new Intl.Locale(lang).maximize().region?.toLowerCase()
    if (region && list.includes(`${primary}-${region}`)) return `${primary}-${region}`
  } catch {
    // Not a valid tag: fall through to the first of its language.
  }
  return list.find((locale) => locale.split('-')[0] === primary)
}
