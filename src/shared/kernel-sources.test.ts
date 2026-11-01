import { describe, expect, it } from 'vitest'
import { DEFAULT_KERNEL_SOURCES, kernelSourceFamily, normalizeKernelSource, validKernelSources, withOfficialKernelSource } from './kernel-sources'

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

  it('adds the kernel repository to lists saved before it existed, and treats both official ones as one', () => {
    expect(DEFAULT_KERNEL_SOURCES).toEqual(['zhangchedan000/prism-kernel-releases', 'zhangchedan000/fingerprint-browser'])
    expect(withOfficialKernelSource(['x/y', 'zhangchedan000/fingerprint-browser']))
      .toEqual(['x/y', 'zhangchedan000/prism-kernel-releases', 'zhangchedan000/fingerprint-browser'])
    expect(withOfficialKernelSource(['x/y'])).toEqual(['x/y'])
    expect(withOfficialKernelSource([...DEFAULT_KERNEL_SOURCES])).toEqual([...DEFAULT_KERNEL_SOURCES])
    expect(kernelSourceFamily('Zhangchedan000/Fingerprint-Browser')).toBe(kernelSourceFamily('zhangchedan000/prism-kernel-releases'))
    expect(kernelSourceFamily('x/y')).toBe('x/y')
  })
})
