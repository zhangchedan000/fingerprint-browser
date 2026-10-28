import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Passwords a window saved (Chrome's "Login Data") go with its login state to another computer.
 * Chrome encrypts them with a key kept in "Local State", itself locked to this Windows user
 * (DPAPI). The key travels unlocked next to the database and is locked again for the other
 * computer's user there; the database is copied as it is.
 */
export const PASSWORDS_DIR = '.prism-team-passwords'
const KEY_FILE = 'key'
const DATABASES = ['Login Data', 'Login Data-journal', 'Login Data For Account', 'Login Data For Account-journal']
const DPAPI_PREFIX = Buffer.from('DPAPI')

/** Locks and unlocks Chrome's key for the current Windows user. */
export interface KeyProtector {
  protect(data: Buffer): Promise<Buffer>
  unprotect(data: Buffer): Promise<Buffer>
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-1000) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`DPAPI 失败（${code}）：${err.trim()}`)))
    // The key goes through stdin, never the command line.
    child.stdin.end(input)
  })
}

function dpapi(method: 'Protect' | 'Unprotect'): (data: Buffer) => Promise<Buffer> {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$out = [System.Security.Cryptography.ProtectedData]::${method}($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))'
  ].join('; ')
  return async (data) => Buffer.from(await runPowerShell(script, data.toString('base64')), 'base64')
}

/** Windows' DPAPI for the signed-in user; none elsewhere (macOS keeps the key in the Keychain). */
export const windowsKeyProtector: KeyProtector | undefined = process.platform === 'win32'
  ? { protect: dpapi('Protect'), unprotect: dpapi('Unprotect') }
  : undefined

/**
 * Puts a closed window's saved passwords and their unlocked key into PASSWORDS_DIR inside its
 * folder, for packing. False when it has none, or the key cannot be read (nothing is staged then).
 */
export async function stagePasswords(userDataPath: string, protector: KeyProtector): Promise<boolean> {
  const database = join(userDataPath, 'Default', 'Login Data')
  if (!await exists(database)) return false
  const state = JSON.parse(await readFile(join(userDataPath, 'Local State'), 'utf8')) as { os_crypt?: { encrypted_key?: unknown } }
  const wrapped = typeof state.os_crypt?.encrypted_key === 'string' ? Buffer.from(state.os_crypt.encrypted_key, 'base64') : undefined
  if (!wrapped || !wrapped.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) return false
  const key = await protector.unprotect(wrapped.subarray(DPAPI_PREFIX.length))
  const staged = join(userDataPath, PASSWORDS_DIR)
  await rm(staged, { recursive: true, force: true })
  await mkdir(staged, { recursive: true })
  await writeFile(join(staged, KEY_FILE), key.toString('base64'), { encoding: 'utf8', mode: 0o600 })
  for (const name of DATABASES) {
    if (await exists(join(userDataPath, 'Default', name))) await copyFile(join(userDataPath, 'Default', name), join(staged, name))
  }
  return true
}

/**
 * Takes saved passwords from an unpacked login state (`staging`): the database into the window's
 * Default folder and the key, locked for this computer's user, into its Local State. Run before
 * the cookies are imported, which are then written with the same key. False when none came.
 */
export async function restorePasswords(staging: string, userDataPath: string, protector: KeyProtector): Promise<boolean> {
  const staged = join(staging, PASSWORDS_DIR)
  if (!await exists(join(staged, KEY_FILE)) || !await exists(join(staged, 'Login Data'))) return false
  const key = Buffer.from((await readFile(join(staged, KEY_FILE), 'utf8')).trim(), 'base64')
  if (key.length !== 32) return false
  const wrapped = Buffer.concat([DPAPI_PREFIX, await protector.protect(key)])
  const statePath = join(userDataPath, 'Local State')
  const state = await readFile(statePath, 'utf8').then((text) => JSON.parse(text) as Record<string, unknown>, () => ({} as Record<string, unknown>))
  const osCrypt = (state.os_crypt && typeof state.os_crypt === 'object' ? state.os_crypt : {}) as Record<string, unknown>
  await writeFile(statePath, JSON.stringify({ ...state, os_crypt: { ...osCrypt, encrypted_key: wrapped.toString('base64') } }), 'utf8')
  await mkdir(join(userDataPath, 'Default'), { recursive: true })
  for (const name of DATABASES) {
    const target = join(userDataPath, 'Default', name)
    if (await exists(join(staged, name))) await copyFile(join(staged, name), target)
    else await rm(target, { force: true })
  }
  return true
}
