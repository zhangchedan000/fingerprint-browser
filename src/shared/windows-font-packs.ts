/**
 * Windows' language font packages ("Language.Fonts.<Script>" features on demand). A Windows in a
 * language with its own script has that package; Prism kernels (patch 007, prism7) show a window
 * the base Windows 11 fonts plus the package of its interface language and hide the rest. The
 * fonts must be on this computer for the window to show them, so the launcher installs the
 * packages from Microsoft (Add-WindowsCapability).
 *
 * Package contents: Microsoft's "Windows 11 font list" and the packages in the Languages and
 * Optional Features ISO 26100.1. `marker` is one font file only that package installs.
 */
export interface WindowsFontPack {
  script: string
  capability: string
  marker: string
  /** Fonts a page would notice, for the UI. */
  examples: string
}

const pack = (script: string, marker: string, examples: string): WindowsFontPack => ({
  script,
  capability: `Language.Fonts.${script}~~~und-${script.toUpperCase()}~0.0.1.0`,
  marker,
  examples
})

/** The packages of the scripts Chrome has interface languages for (locales.gni). */
export const WINDOWS_FONT_PACKS: readonly WindowsFontPack[] = [
  pack('Hans', 'simhei.ttf', 'DengXian, SimHei, KaiTi, FangSong'),
  pack('Hant', 'mingliu.ttc', 'MingLiU, PMingLiU, DFKai-SB'),
  pack('Jpan', 'meiryo.ttc', 'Meiryo, MS Mincho, Yu Mincho, BIZ UDGothic'),
  pack('Kore', 'batang.ttc', 'Batang, Gulim, Dotum, Gungsuh'),
  pack('Thai', 'leelawad.ttf', 'Leelawadee, Angsana New, Cordia New'),
  pack('Arab', 'arabtype.ttf', 'Arabic Typesetting, Sakkal Majalla, Traditional Arabic'),
  pack('Hebr', 'david.ttf', 'David, Gisha, Miriam'),
  pack('Deva', 'mangal.ttf', 'Mangal, Aparajita, Kokila'),
  pack('Beng', 'vrinda.ttf', 'Vrinda, Shonar Bangla'),
  pack('Gujr', 'shruti.ttf', 'Shruti'),
  pack('Knda', 'tunga.ttf', 'Tunga'),
  pack('Mlym', 'kartika.ttf', 'Kartika'),
  pack('Taml', 'latha.ttf', 'Latha, Vijaya'),
  pack('Telu', 'gautami.ttf', 'Gautami, Vani'),
  pack('Ethi', 'nyala.ttf', 'Nyala')
]

/**
 * The script whose package Windows adds for a display language (the kernel's own mapping,
 * WindowsFontScriptFor in patch 007), or undefined when the base fonts cover it.
 */
export function windowsFontScript(language: string): string | undefined {
  const lang = language.trim().toLowerCase().replace(/_/g, '-')
  const primary = lang.split('-')[0]
  if (primary === 'zh') return /-(tw|hk|mo)\b|hant/.test(lang) ? 'Hant' : 'Hans'
  const scripts: Record<string, string> = {
    ja: 'Jpan', ko: 'Kore', th: 'Thai', ar: 'Arab', fa: 'Arab', ur: 'Arab', ps: 'Arab', ug: 'Arab', sd: 'Arab',
    he: 'Hebr', iw: 'Hebr', yi: 'Hebr', hi: 'Deva', mr: 'Deva', ne: 'Deva', kok: 'Deva', sa: 'Deva',
    bn: 'Beng', as: 'Beng', gu: 'Gujr', pa: 'Guru', kn: 'Knda', ml: 'Mlym', or: 'Orya', ta: 'Taml',
    te: 'Telu', si: 'Sinh', km: 'Khmr', lo: 'Laoo', am: 'Ethi', ti: 'Ethi', syr: 'Syrc', chr: 'Cher', iu: 'Cans'
  }
  return scripts[primary]
}

/** A language that uses each script, to name the package in the UI's own language. */
const SCRIPT_LANGUAGE: Record<string, string> = {
  Hans: 'zh-Hans', Hant: 'zh-Hant', Jpan: 'ja', Kore: 'ko', Thai: 'th', Arab: 'ar', Hebr: 'he',
  Deva: 'hi', Beng: 'bn', Gujr: 'gu', Knda: 'kn', Mlym: 'ml', Taml: 'ta', Telu: 'te', Ethi: 'am'
}

export function fontPackLabel(script: string, uiLocale: string): string {
  const language = SCRIPT_LANGUAGE[script]
  if (!language) return script
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(language) ?? script
  } catch {
    return script
  }
}

export interface FontPackStatus {
  /** Scripts whose package is on this computer. */
  installed: string[]
  /** Scripts of WINDOWS_FONT_PACKS still missing. */
  missing: string[]
  supported: boolean
}
