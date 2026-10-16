import { ConfigProvider, theme as antdThemes, type ThemeConfig } from 'antd'
import type { ComponentProps, ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { cssVariableName, DEFAULT_THEME, themeTokens, type ThemeChoice, type ThemeTokens } from './tokens'

export { ACCENT_PRESETS, DEFAULT_THEME, type ThemeChoice, type ThemeMode, type ThemeTokens } from './tokens'

let current: ThemeChoice = DEFAULT_THEME
const listeners = new Set<() => void>()

/** antd's settings, derived from the same tokens as our own styles. */
export function antdTheme(tokens: ThemeTokens, mode: ThemeChoice['mode']): ThemeConfig {
  return {
    algorithm: mode === 'dark' ? antdThemes.darkAlgorithm : antdThemes.defaultAlgorithm,
    token: {
      colorPrimary: tokens.accent,
      colorText: tokens.text,
      colorBgLayout: tokens.bg,
      colorBgContainer: tokens.surface,
      colorBorderSecondary: tokens.line,
      colorSuccess: tokens.success,
      colorError: tokens.danger,
      colorWarning: tokens.warningStrong,
      borderRadius: 10,
      fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    },
    components: {
      Button: { controlHeight: 38 },
      Input: { controlHeight: 38 },
      Select: { controlHeight: 38 },
      Table: { headerBg: tokens.surfaceMuted, headerColor: tokens.textMuted }
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

/** Gives antd components the current theme; our own styles already follow the CSS variables. */
export function ThemeProvider({ locale, children }: { locale: ComponentProps<typeof ConfigProvider>['locale']; children: ReactNode }) {
  const choice = useTheme()
  return <ConfigProvider locale={locale} theme={antdTheme(themeTokens(choice), choice.mode)}>{children}</ConfigProvider>
}
