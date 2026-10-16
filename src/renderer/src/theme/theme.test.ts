import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACCENT_PRESETS, cssVariableName, DEFAULT_THEME, themeTokens, type ThemeTokens } from './tokens'

const RENDERER = join(__dirname, '..')
const COLOUR = /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(tsx?|css)$/.test(name) && !name.includes('.test.') ? [path] : []
  })
}

describe('theme: colours live only in theme/tokens.ts', () => {
  it('has no colour literal anywhere else in the interface', () => {
    const offenders = sourceFiles(RENDERER)
      .filter((path) => !path.endsWith(join('theme', 'tokens.ts')))
      .flatMap((path) => readFileSync(path, 'utf8').split('\n')
        .map((line, index) => ({ line, at: `${path.slice(RENDERER.length + 1)}:${index + 1}` }))
        // Window marker colours are user data, not theme colours.
        .filter(({ line }) => COLOUR.test(line) && !/marker colour/i.test(line)))
      .map(({ at, line }) => `${at} ${line.trim()}`)
    expect(offenders).toEqual([])
  })

  it('only uses variables the tokens define', () => {
    const defined = new Set(Object.keys(themeTokens()).map((name) => cssVariableName(name as keyof ThemeTokens)))
    const css = readFileSync(join(RENDERER, 'styles.css'), 'utf8')
    const used = [...css.matchAll(/var\((--fb-[a-z-]+)\)/g)].map((match) => match[1])
    expect(used.filter((name) => !defined.has(name))).toEqual([])
  })

  it('gives light and dark the same tokens and derives accent shades from any accent', () => {
    const light = themeTokens(DEFAULT_THEME)
    const dark = themeTokens({ ...DEFAULT_THEME, mode: 'dark' })
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
    expect(light.accentSoft).toBe('#eef3ff')
    for (const accent of ACCENT_PRESETS) {
      expect(themeTokens({ accent, mode: 'light' }).accent).toBe(accent)
      expect(themeTokens({ accent, mode: 'light' }).accentSoft).toMatch(/^#[\da-f]{6}$/)
    }
  })
})
