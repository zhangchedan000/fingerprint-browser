import { describe, expect, it } from 'vitest'
import { hostPlatformVersion, windowsSystemName, windowsUniversalApiContract } from './host-hardware'

describe('host Windows version', () => {
  it('reads the Windows version Chrome reports from the UniversalApiContract', () => {
    const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\WindowsRuntime\\WellKnownContracts\r\n    Windows.Foundation.UniversalApiContract    REG_DWORD    0x130000\r\n'
    expect(windowsUniversalApiContract(() => reg)).toBe('19.0.0')
    expect(windowsUniversalApiContract(() => { throw new Error('no reg') })).toBeUndefined()
    expect(hostPlatformVersion('windows', '10.0.19045', () => '10.0.0')).toBe('10.0.0')
    expect(hostPlatformVersion('windows', '10.0.26200', () => undefined)).toBe('10.0.0')
  })
})

describe('windowsSystemName', () => {
  // `reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"` on the two test computers (2026-11-03).
  const reg = (values: Record<string, string>) => '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n'
    + Object.entries(values).map(([name, value]) => `    ${name}    REG_SZ    ${value}`).join('\r\n') + '\r\n'

  it('names Windows 11 by its build (the registry still says Windows 10) and adds the version', () => {
    expect(windowsSystemName(() => reg({ CurrentBuild: '26200', CurrentBuildNumber: '26200', DisplayVersion: '25H2', EditionID: 'Professional', ProductName: 'Windows 10 Pro' })))
      .toBe('Windows 11 Pro 25H2')
    expect(windowsSystemName(() => reg({ CurrentBuild: '19044', DisplayVersion: '21H2', EditionID: 'EnterpriseS', ProductName: 'Windows 10 Enterprise LTSC 2021' })))
      .toBe('Windows 10 Enterprise LTSC 2021 21H2')
  })

  it('says nothing when the registry cannot be read', () => {
    expect(windowsSystemName(() => { throw new Error('no reg') })).toBeUndefined()
    expect(windowsSystemName(() => '')).toBeUndefined()
  })
})
