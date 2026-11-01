import { closestLocale } from './locale-match'
/**
 * The microphones, speakers and cameras a window lists (Prism patch 014). Pages without
 * permission only see which kinds exist; with permission they see names built from the Windows
 * endpoint names of the window's language. "auto" is the most usual desktop: speakers and a USB
 * headset. With two audio outputs the kernel names one "Speakers" and the other "Headphones".
 */
export type MediaDevicesChoice = string

/** Languages the kernel has Windows endpoint names for (from the Windows language packs). */
export const MEDIA_LOCALES: readonly string[] = [
  'ar-sa', 'bg-bg', 'cs-cz', 'da-dk', 'de-de', 'el-gr', 'en-gb', 'en-us', 'es-es', 'es-mx', 'et-ee',
  'fi-fi', 'fr-ca', 'fr-fr', 'he-il', 'hr-hr', 'hu-hu', 'it-it', 'ja-jp', 'ko-kr', 'lt-lt', 'lv-lv',
  'nb-no', 'nl-nl', 'pl-pl', 'pt-br', 'pt-pt', 'ro-ro', 'ru-ru', 'sk-sk', 'sl-si', 'sr-latn-rs',
  'sv-se', 'th-th', 'tr-tr', 'uk-ua', 'zh-cn', 'zh-tw'
]

/**
 * What a desktop has plugged in, and the set the kernel lists for it (microphones, audio outputs,
 * cameras). Speakers are the onboard sound (Realtek); a USB headset brings a microphone and
 * headphones; a webcam brings a camera and its own microphone.
 */
export interface MediaSetup {
  set: string
  microphones: number
  speakers: number
  headphones: number
  cameras: number
  /** What is plugged in, in a few words. */
  kind: 'speakers' | 'headset' | 'speakers-headset' | 'speakers-webcam' | 'speakers-headset-webcam'
}

export const MEDIA_SETUPS: readonly MediaSetup[] = [
  { set: '0,1,0', microphones: 0, speakers: 1, headphones: 0, cameras: 0, kind: 'speakers' },
  { set: '1,1,0', microphones: 1, speakers: 0, headphones: 1, cameras: 0, kind: 'headset' },
  { set: '1,2,0', microphones: 1, speakers: 1, headphones: 1, cameras: 0, kind: 'speakers-headset' },
  { set: '1,1,1', microphones: 1, speakers: 1, headphones: 0, cameras: 1, kind: 'speakers-webcam' },
  { set: '2,2,1', microphones: 2, speakers: 1, headphones: 1, cameras: 1, kind: 'speakers-headset-webcam' }
]

/** Sets offered besides auto and the real devices. */
export const MEDIA_PRESETS: readonly string[] = MEDIA_SETUPS.map((setup) => setup.set)

const SET = /^[0-3],[0-3],[0-3]$/

export function isMediaDevicesChoice(value: string): boolean {
  return value === 'auto' || value === 'real' || SET.test(value)
}

/** Laptop cards ("RTX 4060 Laptop GPU", Max-Q) mean a laptop; everything else is a desktop. */
export function isLaptopGpu(gpuModel: string | undefined): boolean {
  return /\b(Laptop|Max-Q|Mobile)\b/i.test(gpuModel ?? '')
}

function seededRandom(seed: number): () => number {
  let state = (seed ^ 0x9e3779b9) >>> 0
  return () => {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0
    state = Math.imul(state ^ (state >>> 12), 0x297a2d39) >>> 0
    return ((state ^ (state >>> 15)) >>> 0) / 4294967296
  }
}

/** The set a new window starts with: speakers and a USB headset (microphone + headphones). */
export const DEFAULT_MEDIA_DEVICES = '1,2,0'

/**
 * The set 自动 stands for: the same for every window (the seed and GPU are kept in the signature
 * for windows written before this rule). Saved windows keep the set they were saved with.
 */
export function autoMediaDevices(_seed: number, _gpuModel?: string): string {
  return DEFAULT_MEDIA_DEVICES
}

/**
 * The rule before 0.5.16, for windows saved then without a set of their own: written in once with
 * the set they have always had, so an update does not change them.
 */
export function legacyAutoMediaDevices(seed: number, gpuModel?: string): string {
  const next = seededRandom(seed)
  if (isLaptopGpu(gpuModel)) {
    const speakers = next() < 0.7 ? 1 : 2
    return `1,${speakers},1`
  }
  const speakers = next() < 0.8 ? 2 : 1
  const cameras = next() < 0.15 ? 1 : 0
  return `1,${speakers},${cameras}`
}

/** The set passed to the kernel, or undefined to show the real devices. */
export function effectiveMediaDevices(choice: string | undefined, seed: number, gpuModel?: string): string | undefined {
  if (choice === 'real') return undefined
  if (choice && SET.test(choice)) return choice
  return autoMediaDevices(seed, gpuModel)
}

/**
 * The device-name language a system language comes with: its own, else its most likely country's
 * (es-419 → es-mx, fr → fr-fr), else en-us. Hong Kong and Macau run Traditional Chinese Windows.
 * Written into a window when it is saved, so the kernel's own fallback is not used.
 */
export function mediaLocaleFor(uiLocale: string): string {
  let lang = uiLocale.trim().toLowerCase().replace('_', '-')
  if (lang.startsWith('zh-hk') || lang.startsWith('zh-mo') || lang.includes('hant')) lang = 'zh-tw'
  return closestLocale(lang, MEDIA_LOCALES) ?? 'en-us'
}

/**
 * The kernel's own pick when no device-name language is passed (patch 014, FingerprintEndpointNamesFor):
 * what windows saved before 0.5.16 always had. Written into them once, unchanged.
 */
export function kernelMediaLocaleFor(uiLocale: string): string {
  let lang = uiLocale.trim().toLowerCase().replace('_', '-')
  if (lang.startsWith('zh-hk') || lang.startsWith('zh-mo') || lang.includes('hant')) lang = 'zh-tw'
  if (MEDIA_LOCALES.includes(lang)) return lang
  const primary = lang.split('-')[0]
  return MEDIA_LOCALES.find((locale) => locale.split('-')[0] === primary) ?? 'en-us'
}
