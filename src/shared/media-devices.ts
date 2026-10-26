/**
 * The microphones, speakers and cameras a window lists (Prism patch 014). Pages without
 * permission only see which kinds exist; with permission they see names built from the Windows
 * endpoint names of the window's language. "auto" derives a usual desktop set from the seed.
 */
export type MediaDevicesChoice = string

/** Languages the kernel has Windows endpoint names for (from the Windows language packs). */
export const MEDIA_LOCALES: readonly string[] = [
  'ar-sa', 'bg-bg', 'cs-cz', 'da-dk', 'de-de', 'el-gr', 'en-gb', 'en-us', 'es-es', 'es-mx', 'et-ee',
  'fi-fi', 'fr-ca', 'fr-fr', 'he-il', 'hr-hr', 'hu-hu', 'it-it', 'ja-jp', 'ko-kr', 'lt-lt', 'lv-lv',
  'nb-no', 'nl-nl', 'pl-pl', 'pt-br', 'pt-pt', 'ro-ro', 'ru-ru', 'sk-sk', 'sl-si', 'sr-latn-rs',
  'sv-se', 'th-th', 'tr-tr', 'uk-ua', 'zh-cn', 'zh-tw'
]

/** Sets offered besides auto and the real devices: microphones, speakers, cameras. */
export const MEDIA_PRESETS: readonly string[] = ['1,1,0', '1,1,1', '2,1,1', '1,2,0', '2,2,1']

const SET = /^[0-3],[0-3],[0-3]$/

export function isMediaDevicesChoice(value: string): boolean {
  return value === 'auto' || value === 'real' || SET.test(value)
}

/** A usual desktop for this seed: one microphone and speaker, sometimes a second, about a third with a webcam. */
export function autoMediaDevices(seed: number): string {
  let state = (seed ^ 0x9e3779b9) >>> 0
  const next = () => {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0
    state = Math.imul(state ^ (state >>> 12), 0x297a2d39) >>> 0
    return ((state ^ (state >>> 15)) >>> 0) / 4294967296
  }
  const microphones = next() < 0.85 ? 1 : 2
  const speakers = next() < 0.8 ? 1 : 2
  const cameras = next() < 0.35 ? 1 : 0
  return `${microphones},${speakers},${cameras}`
}

/** The set passed to the kernel, or undefined to show the real devices. */
export function effectiveMediaDevices(choice: string | undefined, seed: number): string | undefined {
  if (choice === 'real') return undefined
  if (choice && SET.test(choice)) return choice
  return autoMediaDevices(seed)
}
