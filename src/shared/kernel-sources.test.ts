import { describe, expect, it } from 'vitest'
import { DEFAULT_KERNEL_SOURCES, normalizeKernelSource, validKernelSources } from './kernel-sources'

describe('kernel sources', () => {
  it('reads a GitHub project from a pasted address', () => {
    expect(normalizeKernelSource('https://github.com/a-b/c.d')).toBe('a-b/c.d')
    expect(normalizeKernelSource('github.com/a/b/releases/tag/v1')).toBe('a/b')
    expect(normalizeKernelSource(' a/b.git ')).toBe('a/b')
    expect(normalizeKernelSource('https://gitlab.com/a/b')).toBeUndefined()
    expect(normalizeKernelSource('just-a-word')).toBeUndefined()
  })

  it('keeps valid sources once, and the default list when nothing was stored', () => {
    expect(validKernelSources(['a/b', 'https://github.com/A/B', 'bad', 'c/d'])).toEqual(['a/b', 'c/d'])
    expect(validKernelSources([])).toEqual([])
    expect(validKernelSources(undefined)).toEqual([...DEFAULT_KERNEL_SOURCES])
  })
})
