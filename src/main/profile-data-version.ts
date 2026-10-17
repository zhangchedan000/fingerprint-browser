import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

function compareVersions(first: string, second: string): number {
  const a = first.split('.').map(Number)
  const b = second.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

/** The Chromium version that last opened this user-data folder (its `Last Version` file), if any. */
export async function lastChromiumVersion(userDataDir: string): Promise<string | undefined> {
  try {
    const version = (await readFile(join(userDataDir, 'Last Version'), 'utf8')).trim()
    return /^\d+(?:\.\d+){3}$/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Chromium cannot downgrade a profile: a folder last opened by a newer kernel makes an older one
 * abort on start (0x80000003 on Windows). Refuse with the reason instead of starting a crash.
 */
export async function assertKernelCanOpenProfileData(userDataDir: string, kernelVersion: string | null | undefined): Promise<void> {
  if (!kernelVersion) return
  const last = await lastChromiumVersion(userDataDir)
  if (last && compareVersions(last, kernelVersion) > 0) {
    throw new Error(`这个环境的数据已被更新的内核 ${last} 打开过，内核 ${kernelVersion} 无法打开（Chromium 不支持降级）。请把这个环境的内核改回 ${last.split('.')[0]} 或更高版本`)
  }
}
