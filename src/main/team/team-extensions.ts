import { rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionStore } from '../extension-store'
import type { BrowserProfile } from '../../shared/types'
import type { PackExtras, ShippedExtension } from './team-archive'

/**
 * A team window's extensions go along with its login state, so the other computer opens it with the
 * same extensions and their data. An extension imported with a key (all imported from v0.5.28 on)
 * has the same browser ID everywhere, and all its data carries over. One imported earlier has no
 * key, so its ID differs per computer: the folders filed under the ID are renamed to this
 * computer's ID (chrome.storage); what sits inside the browser's shared databases (its IndexedDB
 * and localStorage) stays under the other ID.
 */
const ID_FOLDERS = ['Default/Local Extension Settings', 'Default/Sync Extension Settings']

/** The window's extensions as they go into the archive: its own and those on for every window. */
export async function windowExtensions(store: ExtensionStore, profile: BrowserProfile): Promise<NonNullable<PackExtras['extensions']>> {
  const ids = [...new Set([...profile.extensionIds, ...store.list().filter((item) => item.globalEnabled).map((item) => item.id)])]
  const found: NonNullable<PackExtras['extensions']> = []
  for (const id of ids) {
    const extension = store.list().find((item) => item.id === id)
    if (!extension) continue
    const { chromeId, identity } = await store.identity(id)
    found.push({ path: extension.path, extension: { chromeId, identity, name: extension.name, version: extension.version } })
  }
  return found
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/** Files an extension's data under this computer's ID for it. */
export async function moveExtensionData(userDataPath: string, from: string, to: string): Promise<void> {
  if (from === to) return
  for (const folder of ID_FOLDERS) {
    const source = join(userDataPath, folder, from)
    if (!await exists(source)) continue
    const target = join(userDataPath, folder, to)
    await rm(target, { recursive: true, force: true })
    await rename(source, target)
  }
}

/**
 * Puts the extensions that came with a window on this computer (the ones it already has are used
 * as they are) and files their data under this computer's IDs. Returns the extensions for the
 * window: those not already on for every window here.
 */
export async function adoptWindowExtensions(store: ExtensionStore, folder: string, shipped: ShippedExtension[], userDataPath: string): Promise<string[]> {
  const ids: string[] = []
  for (const item of shipped) {
    const local = await store.findByIdentity(item.identity)
      ?? await store.importDirectory(join(folder, item.folder), { keepManifest: true })
    await moveExtensionData(userDataPath, item.chromeId, (await store.identity(local.id)).chromeId)
    if (!local.globalEnabled) ids.push(local.id)
  }
  return [...new Set(ids)]
}

