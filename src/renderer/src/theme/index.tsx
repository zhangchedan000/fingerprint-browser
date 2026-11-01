import { ConfigProvider, theme as antdThemes, type ThemeConfig } from 'antd'
import type { ComponentProps, ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { cssVariableName, DEFAULT_THEME, themeTokens, type ThemeChoice, type ThemeTokens } from './tokens'

export { ACCENT_PRESETS, DEFAULT_THEME, type ThemeChoice, type ThemeMode, type ThemeTokens } from './tokens'

const ACCENT_KEY = 'fb.accent'

/** The accent picked in Settings, kept on this computer; the default blue otherwise. */
function savedAccent(): string {
  try {
    const value = localStorage.getItem(ACCENT_KEY)
    if (value && /^#[0-9a-f]{6}$/i.test(value)) return value
  } catch {
    // No storage: the default accent.
  }
  return DEFAULT_THEME.accent
}

let current: ThemeChoice = { ...DEFAULT_THEME, accent: savedAccent() }
let preferenceMode: 'light' | 'dark' | 'system' = 'light'
const listeners = new Set<() => void>()

/** antd's settings, derived from the same tokens as our own styles. */
export function antdTheme(tokens: ThemeTokens, mode: ThemeChoice['mode']): ThemeConfig {
  return {
    algorithm: mode === 'dark' ? antdThemes.darkAlgorithm : antdThemes.defaultAlgorithm,
    token: {
      colorPrimary: tokens.accent,
      colorLink: tokens.accent,
      colorInfo: tokens.accent,
      colorText: tokens.text,
      colorBgLayout: tokens.bg,
      colorBgContainer: tokens.surface,
      colorBorderSecondary: tokens.line,
      colorSuccess: tokens.success,
      colorError: tokens.danger,
      colorWarning: tokens.warningStrong,
      borderRadius: 8,
      borderRadiusLG: 12,
      colorBorder: tokens.controlBorder,
      colorTextPlaceholder: tokens.textFaint,
      colorTextDescription: tokens.textMuted,
      fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    },
    components: {
      // 36 px: roomy enough to click, without the toolbar looking heavy.
      Button: { controlHeight: 36, fontWeight: 500, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
      Input: { controlHeight: 36 },
      InputNumber: { controlHeight: 36 },
      Select: { controlHeight: 36 },
      Table: { headerBg: tokens.surfaceMuted, headerColor: tokens.textMuted, rowHoverBg: tokens.surfaceMuted, rowSelectedBg: tokens.accentSoft, rowSelectedHoverBg: tokens.accentSoft, headerSplitColor: 'transparent', borderColor: tokens.lineSoft },
      Dropdown: { paddingBlock: 7 },
      Drawer: { footerPaddingBlock: 12, footerPaddingInline: 24 },
      Tabs: { horizontalItemGutter: 28 },
      Card: { headerFontSize: 15 }
    }
  }
}

/**
 * Switches the whole app to a theme. This is the interface a theme picker calls:
 * it updates our CSS variables and antd at the same time.
 */
export function applyTheme(choice: ThemeChoice): ThemeTokens {
  const tokens = themeTokens(choice)
  const root = document.documentElement
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(cssVariableName(name as keyof ThemeTokens), value)
  root.style.colorScheme = choice.mode
  root.dataset.theme = choice.mode
  current = choice
  for (const listener of listeners) listener()
  return tokens
}

export function currentTheme(): ThemeChoice {
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribe, currentTheme)
}

/** A required field is marked after its label ("代理地址 *"), so the labels themselves line up. */
const requiredMark = (label: ReactNode, { required }: { required: boolean }) => <>{label}{required && <em className="fb-required-mark">*</em>}</>

/** Gives antd components the current theme; our own styles already follow the CSS variables. */
export function ThemeProvider({ locale, children }: { locale: ComponentProps<typeof ConfigProvider>['locale']; children: ReactNode }) {
  const choice = useTheme()
  return <ConfigProvider locale={locale} theme={antdTheme(themeTokens(choice), choice.mode)} form={{ requiredMark }}>{children}</ConfigProvider>
}

let systemWatch: MediaQueryList | undefined
let systemListener: (() => void) | undefined

/**
 * Applies the theme saved in the settings ('system' follows the operating system and keeps
 * following it while the app runs).
 */
export function applyThemePreference(preference: 'light' | 'dark' | 'system', accent = current.accent): void {
  preferenceMode = preference
  if (systemWatch && systemListener) systemWatch.removeEventListener('change', systemListener)
  systemWatch = undefined
  systemListener = undefined
  if (preference !== 'system') {
    applyTheme({ accent, mode: preference })
    return
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const follow = (): void => { applyTheme({ accent, mode: query.matches ? 'dark' : 'light' }) }
  systemWatch = query
  systemListener = follow
  query.addEventListener('change', follow)
  follow()
}

/** Changes the accent colour everywhere and remembers it on this computer. */
export function setAccent(accent: string): void {
  try {
    localStorage.setItem(ACCENT_KEY, accent)
  } catch {
    // Kept until the app restarts.
  }
  applyThemePreference(preferenceMode, accent)
}
