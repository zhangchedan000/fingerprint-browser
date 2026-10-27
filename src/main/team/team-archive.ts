import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { PortableCookie } from '../cookie-file'
import { CACHE_PATHS } from '../profile-data'

/** Cookies travel as plain JSON next to the files; the cookie database itself cannot. */
export const COOKIES_FILE = '.prism-team-cookies.json'

/**
 * Left out of a shared window's login state:
 * - caches, rebuilt by Chromium;
 * - lock and port files of a running browser;
 * - files encrypted with this computer's key (DPAPI on Windows, Keychain on macOS): the cookie
 *   and password databases and Local State, which holds that key. Another computer could not
 *   read them, so cookies go through COOKIES_FILE instead.
 */
export const EXCLUDED_PATHS = [
  ...CACHE_PATHS.map((segments) => segments.join('/')),
  'Singleton*',
  'lockfile',
  'DevToolsActivePort',
  'Local State',
  'Default/Cookies',
  'Default/Cookies-journal',
  'Default/Network/Cookies',
  'Default/Network/Cookies-journal',
  'Default/Login Data',
  'Default/Login Data-journal',
  'Default/Login Data For Account',
  'Default/Login Data For Account-journal',
  'BrowserMetrics*',
  'Default/Sessions/*.tmp'
]

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

/** Packs a closed window's data folder and its cookies into `target` (.tgz). */
export async function packProfileState(userDataPath: string, cookies: PortableCookie[], target: string): Promise<PackedState> {
  // The window is closed, so the cookies file can sit in its folder while tar reads it.
  const cookiesPath = join(userDataPath, COOKIES_FILE)
  await writeFile(cookiesPath, JSON.stringify(cookies), { encoding: 'utf8', mode: 0o600 })
  try {
    const excludes = EXCLUDED_PATHS.flatMap((path) => ['--exclude', `./${path}`])
    await runTar(['-czf', '-', ...excludes, '.'], userDataPath, { write: target })
  } finally {
    await rm(cookiesPath, { force: true })
  }
  const [info, sha256] = await Promise.all([stat(target), sha256File(target)])
  return { file: target, size: info.size, sha256 }
}

/**
 * Replaces a closed window's data folder with an archive's content and returns the cookies to
 * import. The old folder is kept until the new one is in place.
 */
export async function unpackProfileState(archive: string, userDataPath: string): Promise<PortableCookie[]> {
  const staging = `${userDataPath}.incoming-${randomUUID()}`
  await mkdir(staging, { recursive: true })
  try {
    // -P is not passed, so bsdtar refuses absolute paths and "..", keeping files inside staging.
    await runTar(['-xzf', '-'], staging, { read: archive })
    let cookies: PortableCookie[] = []
    const cookiesPath = join(staging, COOKIES_FILE)
    try {
      const parsed = JSON.parse(await readFile(cookiesPath, 'utf8')) as unknown
      if (Array.isArray(parsed)) cookies = parsed as PortableCookie[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('登录态里的 Cookie 文件已损坏')
    }
    await rm(cookiesPath, { force: true })
    const old = `${userDataPath}.previous-${randomUUID()}`
    await rename(userDataPath, old)
    try {
      // This computer's own key stays; the cookies are imported again with it.
      await rename(join(old, 'Local State'), join(staging, 'Local State')).catch(() => undefined)
      await rename(staging, userDataPath)
    } catch (error) {
      await rename(join(staging, 'Local State'), join(old, 'Local State')).catch(() => undefined)
      await rename(old, userDataPath).catch(() => undefined)
      throw error
    }
    await rm(old, { recursive: true, force: true })
    return cookies
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
