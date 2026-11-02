import { describe, expect, it } from 'vitest'
import { kernelSpawnOptions } from './browser-spawn'

describe('kernelSpawnOptions', () => {
  it('starts kernels outside the launcher job object on Windows', () => {
    expect(kernelSpawnOptions('win32')).toEqual({ detached: true })
  })

  it('leaves other platforms unchanged', () => {
    expect(kernelSpawnOptions('linux')).toEqual({})
    expect(kernelSpawnOptions('darwin')).toEqual({})
  })
})
