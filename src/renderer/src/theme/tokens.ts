/**
 * The one place the app's colours are defined.
 *
 * Every colour on screen comes from these tokens: our own styles read them as CSS
 * variables (--fb-<name>), antd components read them through antdTheme(). Add a theme or
 * a colour scheme by adding values here; pages never contain colour literals.
 */
export interface ThemeTokens {
  accent: string
  /** Light accent background: selected rows, batch bar, active choices. */
  accentSoft: string
  accentSoftBorder: string
  /** Accent-coloured text on accentSoft. */
  accentText: string

  /** Text and icons on an accent background. */
  onAccent: string
  onAccentMuted: string

  bg: string
  surface: string
  surfaceMuted: string
  /** Small labels such as a group name in the window list. */
  chip: string
  line: string
  lineSoft: string
  lineStrong: string
  /** Borders of inputs, selects and plain buttons: visible, but lighter than lineStrong. */
  controlBorder: string

  text: string
  textSecondary: string
  textMuted: string
  textFaint: string

  success: string
  successSoft: string
  successDot: string
  warning: string
  warningSoft: string
  warningStrong: string
  danger: string
  dangerSoft: string
  dangerRow: string
  /** Process left behind / starting states. */
  attention: string
  star: string
  /** Hand-picked values (e.g. a pinned kernel). */
  special: string
  idle: string

  sidebarBg: string
  sidebarText: string
  sidebarMuted: string
  sidebarTitle: string
  sidebarDisabled: string
  sidebarHover: string
  sidebarCard: string
  sidebarCardHover: string
  shadow: string
}

export type ThemeMode = 'light' | 'dark'

export interface ThemeChoice {
  accent: string
  mode: ThemeMode
}

/** The default look (design: Main.dc.html). */
export const DEFAULT_THEME: ThemeChoice = { accent: '#2f6bff', mode: 'light' }

/** Accent presets offered when a theme picker is added (from the design's colour options). */
export const ACCENT_PRESETS = ['#2f6bff', '#0f9d8a', '#6a4cff', '#e8590c', '#d6336c', '#334155'] as const

const LIGHT: Omit<ThemeTokens, 'accent' | 'accentSoft' | 'accentSoftBorder' | 'accentText'> = {
  onAccent: '#ffffff',
  onAccentMuted: 'rgba(255, 255, 255, .8)',
  bg: '#f2f4f8',
  surface: '#ffffff',
  surfaceMuted: '#f7f8fb',
  chip: '#f0f2f7',
  line: '#e6e9f0',
  lineSoft: '#edf0f4',
  lineStrong: '#b9c3d6',
  controlBorder: '#d5dbe6',
  text: '#1d2433',
  textSecondary: '#3c4560',
  textMuted: '#5d6782',
  textFaint: '#8a93a8',
  success: '#1e7a4f',
  successSoft: '#e9f7ef',
  successDot: '#34c38f',
  warning: '#8a5a00',
  warningSoft: '#fff6e0',
  warningStrong: '#b45309',
  danger: '#c62828',
  dangerSoft: '#fdecec',
  dangerRow: '#fff7f7',
  attention: '#e8590c',
  star: '#e5a100',
  special: '#6a4cff',
  idle: '#c5cad6',
  sidebarBg: '#141a2e',
  sidebarText: '#c9d1e4',
  sidebarMuted: '#7f8aa8',
  sidebarTitle: '#6b7694',
  sidebarDisabled: '#59627d',
  sidebarHover: 'rgba(255, 255, 255, .06)',
  sidebarCard: '#1d2540',
  sidebarCardHover: '#242d4d',
  shadow: 'rgba(29, 35, 55, .04)'
}

const DARK: typeof LIGHT = {
  onAccent: '#ffffff',
  onAccentMuted: 'rgba(255, 255, 255, .8)',
  bg: '#0f1424',
  surface: '#171d30',
  surfaceMuted: '#1d2438',
  chip: '#252d44',
  line: '#2a3248',
  lineSoft: '#242c41',
  lineStrong: '#3d4763',
  controlBorder: '#353e57',
  text: '#e6e9f2',
  textSecondary: '#c3c9d8',
  textMuted: '#9aa3ba',
  textFaint: '#6f7891',
  success: '#4cc38a',
  successSoft: 'rgba(76, 195, 138, .14)',
  successDot: '#34c38f',
  warning: '#e3b341',
  warningSoft: 'rgba(227, 179, 65, .14)',
  warningStrong: '#f0a43c',
  danger: '#ff6b6b',
  dangerSoft: 'rgba(255, 107, 107, .14)',
  dangerRow: 'rgba(255, 107, 107, .08)',
  attention: '#ff8a3d',
  star: '#f5c542',
  special: '#a48bff',
  idle: '#4b5570',
  sidebarBg: '#0b0f1c',
  sidebarText: '#c9d1e4',
  sidebarMuted: '#7f8aa8',
  sidebarTitle: '#6b7694',
  sidebarDisabled: '#4b5570',
  sidebarHover: 'rgba(255, 255, 255, .06)',
  sidebarCard: '#161c30',
  sidebarCardHover: '#1d2540',
  shadow: 'rgba(0, 0, 0, .25)'
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value
  const number = Number.parseInt(full.slice(0, 6), 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

/** Mixes the accent into a background, so soft accent shades follow any accent colour. */
function mix(accent: string, base: string, amount: number): string {
  const [r1, g1, b1] = hexToRgb(accent)
  const [r2, g2, b2] = hexToRgb(base)
  const channel = (a: number, b: number): string => Math.round(b + (a - b) * amount).toString(16).padStart(2, '0')
  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`
}

export function themeTokens(choice: ThemeChoice = DEFAULT_THEME): ThemeTokens {
  const base = choice.mode === 'dark' ? DARK : LIGHT
  const backdrop = choice.mode === 'dark' ? '#171d30' : '#ffffff'
  return {
    ...base,
    accent: choice.accent,
    accentSoft: mix(choice.accent, backdrop, choice.mode === 'dark' ? 0.18 : 0.08),
    accentSoftBorder: mix(choice.accent, backdrop, choice.mode === 'dark' ? 0.35 : 0.24),
    accentText: choice.mode === 'dark' ? mix(choice.accent, '#ffffff', 0.7) : mix(choice.accent, '#000000', 0.78)
  }
}

/** CSS variable name for a token: accentSoft -> --fb-accent-soft. */
export function cssVariableName(token: keyof ThemeTokens): string {
  return `--fb-${token.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`
}
