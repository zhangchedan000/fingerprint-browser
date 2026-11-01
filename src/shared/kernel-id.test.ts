import { describe, expect, it } from 'vitest'
import { isKernelId, kernelBuildId, kernelBuildLabel, kernelChromiumVersion, kernelFullName, kernelName, kernelVendor } from './kernel-id'
import { kernelMajor } from './kernel-capabilities'

describe('kernel ids', () => {
  it('keeps a second build of a version apart by its import time', () => {
    const id = kernelBuildId('prism-156.0.8078.47', new Date(2026, 9, 26, 15, 1))
    expect(id).toBe('prism-156.0.8078.47-202610261501')
    expect(isKernelId(id)).toBe(true)
    expect(kernelVendor(id)).toBe('prism')
    expect(kernelChromiumVersion(id)).toBe('156.0.8078.47')
    expect(kernelMajor(id)).toBe(156)
    expect(kernelBuildLabel(id)).toBe('10-26 15:01')
    expect(kernelFullName(id)).toBe('Prism 156.0.8078.47 · 10-26 15:01')
    // Shown as Chrome 156; the build time only next to another Chrome 156.
    expect(kernelName(id)).toBe('Chrome 156')
    expect(kernelName(id, ['prism-156.0.8078.47', id])).toBe('Chrome 156 · 10-26 15:01')
    expect(kernelName('prism-156.0.8078.47', ['prism-156.0.8078.47', id])).toBe('Chrome 156')
    expect(kernelName('prism-155.0.8059.84', ['prism-156.0.8078.47', 'prism-155.0.8059.84'])).toBe('Chrome 155')
  })

  it('leaves plain ids as they were', () => {
    expect(kernelFullName('prism-156.0.8078.47')).toBe('Prism 156.0.8078.47')
    expect(kernelBuildLabel('prism-156.0.8078.47')).toBeUndefined()
    expect(isKernelId('prism-156.0.8078.47-2026')).toBe(false)
    expect(isKernelId('156.0.8078.47-202610261501x')).toBe(false)
  })
})
