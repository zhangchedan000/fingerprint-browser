import { execFileSync } from 'node:child_process'
import { availableParallelism, release } from 'node:os'
import type { BrowserPlatform } from '../shared/types'

export interface HostHardwareSnapshot {
  platform: BrowserPlatform
  platformVersion: string
  hardwareConcurrency: number
}

/**
 * What Chrome on this Windows reports as Sec-CH-UA-Platform-Version: the major version of the
 * Windows.Foundation.UniversalApiContract in the registry (components/embedder_support/
 * user_agent_utils.cc). Windows 10 2004-22H2 report 10, Windows 11 24H2 and 25H2 report 19.
 */
export function windowsUniversalApiContract(read: () => string = () => execFileSync('reg', [
  'query', 'HKLM\\SOFTWARE\\Microsoft\\WindowsRuntime\\WellKnownContracts', '/v', 'Windows.Foundation.UniversalApiContract'
], { encoding: 'utf8', windowsHide: true, timeout: 3000 })): string | undefined {
  try {
    const match = read().match(/REG_DWORD\s+0x([0-9a-f]+)/i)
    const major = match ? Number.parseInt(match[1], 16) >>> 16 : 0
    return major > 0 ? `${major}.0.0` : undefined
  } catch {
    return undefined
  }
}

export function hostPlatformVersion(platform: BrowserPlatform, operatingSystemRelease: string, contract?: () => string | undefined): string {
  if (platform === 'windows') return (process.platform === 'win32' || contract ? (contract ?? windowsUniversalApiContract)() : undefined) ?? '10.0.0'
  const darwinMajor = Number(operatingSystemRelease.split('.')[0])
  if (!Number.isInteger(darwinMajor)) return '15.0.0'
  if (darwinMajor >= 25) return `${darwinMajor + 1}.0.0`
  return darwinMajor >= 20 ? `${darwinMajor - 9}.0.0` : '15.0.0'
}

export function hostHardwareSnapshot(): HostHardwareSnapshot {
  const platform: BrowserPlatform = process.platform === 'win32' ? 'windows' : 'macos'
  return {
    platform,
    platformVersion: hostPlatformVersion(platform, release()),
    hardwareConcurrency: Math.max(2, Math.min(64, availableParallelism()))
  }
}
