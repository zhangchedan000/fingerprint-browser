import { access, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Where the data folder (vault) lives. The default is <userData>/vault; after the user moves it, a
 * small pointer file in userData names the new folder (and the old one, kept until the user
 * deletes it or moves back).
 */
/** Inside the data folder: the launcher's own Chromium data (its cache), see vaultPathSync. */
export const APP_CACHE_FOLDER = 'app-cache'

/**
 * The data folder, read before the app is ready (where Electron must be told to keep its own
 * cache): the pointer's folder when it exists, otherwise the default one.
 */
export function vaultPathSync(userData: string): string {
  try {
    const pointer = JSON.parse(readFileSync(pointerFile(userData), 'utf8')) as Partial<Pointer>
    if (typeof pointer.path === 'string' && isAbsolute(pointer.path) && existsSync(pointer.path)) return pointer.path
  } catch {
    // No pointer (or an unreadable one): the default folder, as resolveVaultLocation decides.
  }
  return join(userData, 'vault')
}

export interface VaultLocation {
  path: string
  defaultPath: string
  previous?: string
}

interface Pointer {
  schemaVersion: 1
  path: string
  previous?: string
}

/** Folders that are rebuilt on start and never copied (app-cache: the launcher's own Chromium cache). */
const SKIP = new Set(['tunnel-runtime', APP_CACHE_FOLDER])

export function pointerFile(userData: string): string {
  return join(userData, 'vault-location.json')
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

async function readPointer(userData: string): Promise<Pointer | undefined> {
  try {
    const value = JSON.parse(await readFile(pointerFile(userData), 'utf8')) as Pointer
    if (value.schemaVersion === 1 && typeof value.path === 'string' && isAbsolute(value.path)) return value
  } catch {
    // No pointer: the default folder.
  }
  return undefined
}

async function writePointer(userData: string, pointer: Pointer): Promise<void> {
  await mkdir(userData, { recursive: true })
  const temporary = `${pointerFile(userData)}.tmp`
  await writeFile(temporary, JSON.stringify(pointer, null, 2))
  await rename(temporary, pointerFile(userData))
}

/** The folder to use now. A pointer to a folder that is gone falls back to the default one. */
export async function resolveVaultLocation(userData: string): Promise<VaultLocation & { missing?: string }> {
  const defaultPath = join(userData, 'vault')
  const pointer = await readPointer(userData)
  if (!pointer) return { path: defaultPath, defaultPath }
  if (!await exists(join(pointer.path, 'profiles.json')) && !await exists(pointer.path)) {
    return { path: defaultPath, defaultPath, missing: pointer.path }
  }
  return { path: pointer.path, defaultPath, previous: pointer.previous && pointer.previous !== pointer.path ? pointer.previous : undefined }
}

const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

function inside(child: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

/** Checks a chosen folder: not inside or around the current one, empty, and writable. */
export async function checkTarget(current: string, target: string): Promise<void> {
  if (!isAbsolute(target)) throw new Error('请选择一个完整的文件夹路径')
  if (samePath(current, target)) throw new Error('新位置就是当前数据目录')
  if (inside(target, current)) throw new Error('新位置不能放在当前数据目录里面')
  if (inside(current, target)) throw new Error('新位置不能是当前数据目录的上级文件夹，请在里面新建一个空文件夹')
  if (await exists(target)) {
    const entries = (await readdir(target)).filter((name) => !name.startsWith('.') && name !== 'desktop.ini')
    if (entries.length) throw new Error('新位置必须是空文件夹')
  }
  try {
    await mkdir(target, { recursive: true })
    const probe = join(target, '.fb-write-test')
    await writeFile(probe, 'ok')
    await rm(probe)
  } catch {
    throw new Error('新位置无法写入，请换一个文件夹')
  }
}

interface FileEntry {
  path: string
  size: number
}

async function listFiles(root: string, base = root): Promise<FileEntry[]> {
  const files: FileEntry[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (root === base && SKIP.has(entry.name)) continue
    if (entry.isDirectory()) files.push(...await listFiles(path, base))
    else if (entry.isFile()) files.push({ path: relative(base, path), size: (await stat(path)).size })
  }
  return files
}

/** Replaces a leading old folder in every string of a JSON value (settings keep absolute kernel paths). */
export function rewritePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    const matches = process.platform === 'win32' ? value.toLowerCase().startsWith(from.toLowerCase()) : value.startsWith(from)
    return matches && (value.length === from.length || value[from.length] === sep || value[from.length] === '/') ? to + value.slice(from.length) : value
  }
  if (Array.isArray(value)) return value.map((item) => rewritePaths(item, from, to))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePaths(item, from, to)]))
  return value
}

export interface RelocateProgress {
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
}

/**
 * Copies the whole data folder to the target, checks every file arrived with its size, rewrites
 * absolute paths in the folder's own settings, then points the app at the new folder. The old
 * folder is left as it was.
 */
export async function relocateVault(
  userData: string,
  current: string,
  target: string,
  onProgress: (progress: RelocateProgress) => void = () => undefined
): Promise<void> {
  await checkTarget(current, target)
  const files = await listFiles(current)
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  let copiedBytes = 0
  let copiedFiles = 0
  let lastReport = 0
  try {
    for (const file of files) {
      const destination = join(target, file.path)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(current, file.path), destination)
      copiedBytes += file.size
      copiedFiles += 1
      if (Date.now() - lastReport > 150 || copiedFiles === files.length) {
        lastReport = Date.now()
        onProgress({ copiedBytes, totalBytes, copiedFiles, totalFiles: files.length })
      }
    }
    for (const file of files) {
      const copied = await stat(join(target, file.path)).catch(() => undefined)
      if (!copied || copied.size !== file.size) throw new Error(`复制校验失败：${file.path}`)
    }
    const jsonFiles = files.filter((file) => file.path.endsWith('.json') && file.path.split(/[\\/]/).length <= 2)
    for (const file of jsonFiles) {
      const path = join(target, file.path)
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        continue
      }
      const next = rewritePaths(parsed, resolve(current), resolve(target))
      if (JSON.stringify(next) !== JSON.stringify(parsed)) await writeFile(path, JSON.stringify(next, null, 2))
    }
  } catch (error) {
    // Leave nothing half-copied behind; the current folder was never changed.
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await writePointer(userData, { schemaVersion: 1, path: resolve(target), previous: resolve(current) })
}

/** Removes the folder the data was moved from, once the user is happy with the new one. */
export async function deletePreviousVault(userData: string): Promise<void> {
  const pointer = await readPointer(userData)
  if (!pointer?.previous) throw new Error('没有旧位置的数据')
  if (samePath(pointer.previous, pointer.path)) throw new Error('旧位置就是当前数据目录，不能删除')
  if (await exists(pointer.previous)) {
    if (!await exists(join(pointer.previous, 'profiles.json')) && !await exists(join(pointer.previous, 'settings.json'))) {
      throw new Error('旧位置看起来不是指纹浏览器的数据目录，为安全起见没有删除')
    }
    await rm(pointer.previous, { recursive: true, force: true })
  }
  await writePointer(userData, { schemaVersion: 1, path: pointer.path })
}

/** Points the app back at the old folder (it still holds the data as it was before the move). */
export async function revertVault(userData: string): Promise<void> {
  const pointer = await readPointer(userData)
  if (!pointer?.previous) throw new Error('没有旧位置的数据')
  if (!await exists(pointer.previous)) throw new Error('旧位置的数据已经不存在')
  await writePointer(userData, { schemaVersion: 1, path: pointer.previous, previous: pointer.path })
}
