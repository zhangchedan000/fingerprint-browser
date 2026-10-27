import { describe, expect, it } from 'vitest'
import { hostPlatformVersion, windowsUniversalApiContract } from './host-hardware'

describe('host Windows version', () => {
  it('reads the Windows version Chrome reports from the UniversalApiContract', () => {
    const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\WindowsRuntime\\WellKnownContracts\r\n    Windows.Foundation.UniversalApiContract    REG_DWORD    0x130000\r\n'
    expect(windowsUniversalApiContract(() => reg)).toBe('19.0.0')
    expect(windowsUniversalApiContract(() => { throw new Error('no reg') })).toBeUndefined()
    expect(hostPlatformVersion('windows', '10.0.19045', () => '10.0.0')).toBe('10.0.0')
    expect(hostPlatformVersion('windows', '10.0.26200', () => undefined)).toBe('10.0.0')
  })
})
