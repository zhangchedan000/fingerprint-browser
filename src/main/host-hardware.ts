import { availableParallelism, release } from 'node:os'
import type { BrowserPlatform } from '../shared/types'

export interface HostHardwareSnapshot {
  platform: BrowserPlatform
  platformVersion: string
  hardwareConcurrency: number
}

export function hostPlatformVersion(platform: BrowserPlatform, operatingSystemRelease: string): string {
  if (platform === 'windows') return '10.0.0'
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

/**
 * This computer's system as people name it. Windows 11 still reports kernel version 10.0; its
 * builds start at 22000 (Microsoft's Windows 11 release information).
 */
export function hostSystem(platform: BrowserPlatform = process.platform === 'win32' ? 'windows' : 'macos', operatingSystemRelease = release()): { platform: BrowserPlatform; name: string; build: string } {
  if (platform === 'windows') {
    const build = operatingSystemRelease.split('.')[2] ?? ''
    return { platform, name: Number(build) >= 22000 ? 'Windows 11' : 'Windows 10', build }
  }
  return { platform, name: `macOS ${hostPlatformVersion(platform, operatingSystemRelease).split('.')[0]}`, build: operatingSystemRelease }
}
