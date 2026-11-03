import { execFileSync } from 'node:child_process'
import { availableParallelism, release, type, version } from 'node:os'
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

/**
 * This computer's system as Windows names it in the registry (HKLM\SOFTWARE\Microsoft\Windows NT\
 * CurrentVersion): ProductName and DisplayVersion, e.g. "Windows 10 Enterprise LTSC 2021 21H2".
 * Windows 11 still says "Windows 10" in ProductName; build 22000 and later is Windows 11.
 * Undefined when the registry cannot be read.
 */
export function windowsSystemName(read: () => string = () => execFileSync('reg', [
  'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
], { encoding: 'utf8', windowsHide: true, timeout: 3000 })): string | undefined {
  try {
    const output = read()
    const value = (name: string) => output.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im'))?.[1]
    let product = value('ProductName')
    if (!product) return undefined
    const build = Number(value('CurrentBuild') ?? value('CurrentBuildNumber'))
    if (build >= 22000) product = product.replace(/^Windows 10\b/, 'Windows 11')
    const display = value('DisplayVersion') ?? value('ReleaseId')
    return (display && !product.includes(display) ? `${product} ${display}` : product).slice(0, 200)
  } catch {
    return undefined
  }
}

let systemName: string | undefined | null = null

/** This computer's system for its cloud copies (read once). */
export function hostSystemName(): string | undefined {
  if (systemName === null) {
    systemName = process.platform === 'win32' ? windowsSystemName() : `${type() === 'Darwin' ? 'macOS' : type()} ${release()}`.trim()
    if (!systemName && process.platform === 'win32') systemName = version() || undefined
  }
  return systemName
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
