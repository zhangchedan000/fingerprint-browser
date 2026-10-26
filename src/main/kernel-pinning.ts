import { access, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isKernelId } from '../shared/kernel-id'
import { locateBrowser, locateBrowserForProfile } from './browser-locator'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'

/**
 * The id of the default kernel when a window can be pinned to it: an installed kernel that a
 * window bound to that id would launch exactly as the default does now.
 */
export async function defaultKernelId(settings: SettingsStore, vaultPath: string): Promise<string | undefined> {
  const engine = await locateBrowser(settings)
  if (!engine.fingerprintKernel || !engine.executable || !engine.version || !isKernelId(engine.version)) return undefined
  const pinned = await locateBrowserForProfile(settings, vaultPath, engine.version).catch(() => undefined)
  if (!pinned?.executable || resolve(pinned.executable) !== resolve(engine.executable)) return undefined
  return engine.version
}

const MIGRATION_MARKER = 'kernel-pin-migrated'

/**
 * Once per vault: windows created before kernels were pinned at creation followed the default
 * kernel, so importing or switching a kernel changed them. Pin them to the kernel they use now.
 */
export async function pinWindowsToCurrentKernel(
  profiles: Pick<ProfileStore, 'pinUnboundKernels'>,
  settings: SettingsStore,
  vaultPath: string
): Promise<{ pinned: number; kernel?: string } | undefined> {
  const marker = join(vaultPath, MIGRATION_MARKER)
  try {
    await access(marker)
    return undefined
  } catch {
    // not migrated yet
  }
  const kernel = await defaultKernelId(settings, vaultPath)
  // Without a usable default there is nothing to pin to yet; try again on a later start.
  if (!kernel) return undefined
  const pinned = await profiles.pinUnboundKernels(kernel)
  await writeFile(marker, `${new Date().toISOString()} ${kernel} ${pinned}\n`, { mode: 0o600 })
  return { pinned, kernel }
}
