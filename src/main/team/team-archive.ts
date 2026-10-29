import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { PortableCookie } from '../cookie-file'
import { PASSWORDS_DIR, restorePasswords, stagePasswords, type KeyProtector } from './saved-passwords'

/** Cookies travel as plain JSON next to the files; the cookie database itself cannot. */
export const COOKIES_FILE = '.prism-team-cookies.json'
/** The window's check records (team-records.ts), beside the cookies. */
export const RECORDS_FILE = '.prism-team-records.json'

/**
 * A shared window's state, as close to the same browser as can be: what keeps sites signed in, the
 * open tabs, bookmarks, history and autofill. Cookies are not here: their database is encrypted
 * with this computer's key (DPAPI on Windows), so they go through COOKIES_FILE. Caches and service
 * worker scripts stay on each computer (they are rebuilt).
 */
export const LOGIN_STATE_PATHS = [
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/IndexedDB',
  // Storage buckets: more IndexedDB, plus caches left out below.
  'Default/WebStorage',
  // Open tabs, so the next person continues on the same pages.
  'Default/Sessions',
  // Site permissions (notifications, location…).
  'Default/Preferences',
  // Bookmarks, browsing history (with its icons and most visited sites) and autofill entries.
  'Default/Bookmarks',
  'Default/History',
  'Default/Favicons',
  'Default/Top Sites',
  'Default/Web Data'
]

const EXCLUDED_INSIDE = ['./Default/WebStorage/*/CacheStorage', './Default/Sessions/*.tmp']

function tarExecutable(): string {
  // Windows 10 1803+ ships bsdtar; using it by full path ignores other tar.exe on PATH.
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
}

/**
 * Runs tar in `cwd` with the archive on stdin or stdout. Windows tar takes its arguments in the
 * ANSI code page, so a path such as C:\Users\王\… would arrive as "?"; no path is passed at all.
 */
async function runTar(args: string[], cwd: string, archive: { read: string } | { write: string }): Promise<void> {
  const child = spawn(tarExecutable(), args, {
    cwd,
    stdio: ['read' in archive ? 'pipe' : 'ignore', 'write' in archive ? 'pipe' : 'ignore', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000) })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`无法运行系统 tar：${error.message}`)))
    child.once('exit', resolve)
  })
  const transfer = 'read' in archive
    ? pipeline(createReadStream(archive.read), child.stdin!)
    : pipeline(child.stdout!, createWriteStream(archive.write))
  const [code] = await Promise.all([exited, transfer.catch((error) => { child.kill(); throw error })])
  if (code !== 0) throw new Error(`处理登录态失败（tar 退出码 ${code}）${stderr.trim() ? `：${stderr.trim()}` : ''}`)
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface PackedState {
  file: string
  size: number
  sha256: string
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/** Saved passwords go along when the computer can unlock their key (saved-passwords.ts). */
export interface PasswordTransfer {
  protector?: KeyProtector
  /** Saved passwords could not be taken along; the rest of the login state still is. */
  onError?: (error: unknown) => void
}

/** Packs a closed window's login state (LOGIN_STATE_PATHS), its cookies and check records into `target` (.tgz). */
export async function packProfileState(userDataPath: string, cookies: PortableCookie[], target: string, passwords: PasswordTransfer = {}, records?: unknown): Promise<PackedState> {
  // The window is closed, so the cookies file can sit in its folder while tar reads it.
  const cookiesPath = join(userDataPath, COOKIES_FILE)
  const recordsPath = join(userDataPath, RECORDS_FILE)
  await writeFile(cookiesPath, JSON.stringify(cookies), { encoding: 'utf8', mode: 0o600 })
  if (records) await writeFile(recordsPath, JSON.stringify(records), { encoding: 'utf8', mode: 0o600 })
  try {
    const present: string[] = []
    for (const path of LOGIN_STATE_PATHS) if (await exists(join(userDataPath, path))) present.push(`./${path}`)
    const staged = passwords.protector
      ? await stagePasswords(userDataPath, passwords.protector).catch((error) => { passwords.onError?.(error); return false })
      : false
    if (staged) present.push(`./${PASSWORDS_DIR}`)
    const excludes = EXCLUDED_INSIDE.flatMap((pattern) => ['--exclude', pattern])
    await runTar(['-czf', '-', ...excludes, `./${COOKIES_FILE}`, ...(records ? [`./${RECORDS_FILE}`] : []), ...present], userDataPath, { write: target })
  } finally {
    await rm(cookiesPath, { force: true })
    await rm(recordsPath, { force: true })
    await rm(join(userDataPath, PASSWORDS_DIR), { recursive: true, force: true })
  }
  const [info, sha256] = await Promise.all([stat(target), sha256File(target)])
  return { file: target, size: info.size, sha256 }
}

/**
 * Replaces a closed window's login state (LOGIN_STATE_PATHS) with an archive's and returns the
 * cookies to import and the check records that came with it. Everything else in the folder
 * (caches…) stays this computer's. Archives of v0.3/v0.4.0 carry the whole folder; only these
 * paths are taken from them too.
 */
export async function unpackProfileState(archive: string, userDataPath: string, passwords: PasswordTransfer = {}): Promise<{ cookies: PortableCookie[]; records?: unknown }> {
  const staging = `${userDataPath}.incoming-${randomUUID()}`
  const previous = `${userDataPath}.previous-${randomUUID()}`
  await mkdir(staging, { recursive: true })
  try {
    // -P is not passed, so bsdtar refuses absolute paths and "..", keeping files inside staging.
    await runTar(['-xzf', '-'], staging, { read: archive })
    let cookies: PortableCookie[] = []
    try {
      const parsed = JSON.parse(await readFile(join(staging, COOKIES_FILE), 'utf8')) as unknown
      if (Array.isArray(parsed)) cookies = parsed as PortableCookie[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('登录态里的 Cookie 文件已损坏')
    }
    const records = await readFile(join(staging, RECORDS_FILE), 'utf8').then((text) => JSON.parse(text) as unknown, () => undefined)
    // The shared copy replaces this computer's, also where it has none (a site signed out).
    const moved: string[] = []
    try {
      for (const path of LOGIN_STATE_PATHS) {
        const current = join(userDataPath, path)
        if (await exists(current)) {
          await mkdir(dirname(join(previous, path)), { recursive: true })
          await rename(current, join(previous, path))
          moved.push(path)
        }
        if (await exists(join(staging, path))) {
          await mkdir(dirname(current), { recursive: true })
          await rename(join(staging, path), current)
        }
      }
    } catch (error) {
      for (const path of LOGIN_STATE_PATHS) await rm(join(userDataPath, path), { recursive: true, force: true }).catch(() => undefined)
      for (const path of moved) await rename(join(previous, path), join(userDataPath, path)).catch(() => undefined)
      throw error
    }
    // Before the cookies go in: they are written with the key that comes with the passwords.
    if (passwords.protector) await restorePasswords(staging, userDataPath, passwords.protector).catch((error) => passwords.onError?.(error))
    return { cookies, ...(records ? { records } : {}) }
  } finally {
    await Promise.all([staging, previous].map((path) => rm(path, { recursive: true, force: true })))
  }
}
