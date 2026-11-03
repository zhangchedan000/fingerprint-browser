import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserProfile, FingerprintConfig } from '../shared/types'
import { osPasswordCheck, type OsPasswordCheck } from './os-password'

type Json = Record<string, unknown>

/** Chromium's content-setting values for the default geolocation permission. */
const GEOLOCATION_SETTING: Record<'allow' | 'block', number> = { allow: 1, block: 2 }

function child(parent: Json, key: string): Json {
  const value = parent[key]
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Json
  const created: Json = {}
  parent[key] = created
  return created
}

/** Pure part: returns the updated preferences object, or undefined when nothing changes. */
export function patchChromePreferences(
  current: Json,
  fingerprint: Pick<FingerprintConfig, 'geolocationPermission' | 'doNotTrack'>,
  startupMode?: BrowserProfile['startupMode'],
  downloadFolder?: string
): Json | undefined {
  const next = structuredClone(current)
  // Settings → 下载位置: where the window saves downloads (and Save As starts). Unset leaves
  // whatever the window has (Chrome's default is the user's Downloads folder).
  if (downloadFolder) {
    child(next, 'download').default_directory = downloadFolder
    child(next, 'savefile').default_directory = downloadFolder
  }
  // Chromium owns session files and restores all windows/tabs, including navigation history.
  // Explicit URL mode must also undo a previously enabled restore preference.
  if (startupMode !== undefined) child(next, 'session').restore_on_startup = startupMode === 'restore' ? 1 : 5
  const geolocation = fingerprint.geolocationPermission ?? 'ask'
  if (geolocation === 'ask') {
    // Only remove an existing value; never create empty containers just to delete from them.
    const profile = next.profile as Json | undefined
    const defaults = profile?.default_content_setting_values as Json | undefined
    if (defaults && typeof defaults === 'object') delete defaults.geolocation
  } else {
    child(child(next, 'profile'), 'default_content_setting_values').geolocation = GEOLOCATION_SETTING[geolocation]
  }

  const doNotTrack = fingerprint.doNotTrack ?? 'default'
  if (doNotTrack === 'default') delete next.enable_do_not_track
  else next.enable_do_not_track = doNotTrack === 'on'

  return JSON.stringify(next) === JSON.stringify(current) ? undefined : next
}

/**
 * Writes the window's site-permission defaults into Default/Preferences before Chromium starts.
 * A preferences file Chromium cannot have written (invalid JSON) is left untouched.
 */
export async function applyChromePreferences(
  userDataDir: string,
  fingerprint: Pick<FingerprintConfig, 'geolocationPermission' | 'doNotTrack'>,
  startupMode?: BrowserProfile['startupMode'],
  downloadFolder?: string
): Promise<boolean> {
  const directory = join(userDataDir, 'Default')
  const path = join(directory, 'Preferences')
  let current: Json = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    current = parsed as Json
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  const next = patchChromePreferences(current, fingerprint, startupMode, downloadFolder)
  if (!next) return false
  await mkdir(directory, { recursive: true })
  const temporary = `${path}.fb-tmp`
  await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return true
}

/**
 * Writes this computer's answer to Chrome's blank Windows password check (os-password.ts) into the
 * profile's Local State before Chromium starts, keeping everything else, so a new profile does not
 * log on to Windows with an empty password. A profile whose Chrome already answered keeps its own
 * answer; a Local State Chromium cannot have written (invalid JSON) is left untouched.
 */
export async function answerBlankPasswordCheck(userDataDir: string, check: Pick<OsPasswordCheck, 'answer'> = osPasswordCheck): Promise<boolean> {
  const path = join(userDataDir, 'Local State')
  let current: Json = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    current = parsed as Json
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  const passwordManager = current.password_manager as Json | undefined
  if (passwordManager && typeof passwordManager === 'object' && 'os_password_last_changed' in passwordManager) return false
  const answer = await check.answer()
  if (!answer) return false
  const next = { ...current, password_manager: { ...(passwordManager ?? {}), ...answer } }
  await mkdir(userDataDir, { recursive: true })
  const temporary = `${path}.fb-tmp`
  await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return true
}

/** What a headless run of Chrome on a window's folder must not change: its saved window size and last session. */
export interface WindowStateSnapshot {
  /** Default/Preferences browser.window_placement; undefined: none (or not readable). */
  placement?: unknown
  /** False: Preferences could not be read, so it is left as it is afterwards. */
  preferencesRead: boolean
  /** Default/Sessions files (open tabs to restore), null when there was no such folder. */
  sessions: Map<string, Buffer> | null
}

/**
 * Chrome's headless window size is 800×600. A headless run that shut down properly wrote it as the
 * window's size (v0.5.55), and Chrome then kept it, a little moved and shrunk (780×580 seen). A
 * saved size this small is that, not the user's: dropped, so the window opens at Chrome's default
 * size as a freshly installed Chrome does, and remembers the size the user then gives it.
 */
function isHeadlessPlacement(value: unknown): boolean {
  const p = value as { left?: number; top?: number; right?: number; bottom?: number; maximized?: unknown } | undefined
  if (!p || typeof p !== 'object' || p.maximized) return false
  const width = Number(p.right) - Number(p.left)
  const height = Number(p.bottom) - Number(p.top)
  return Number.isFinite(width) && Number.isFinite(height) && width <= 800 && height <= 600
}

/**
 * Before Chrome runs headless on a window's folder (Cookie import / export): its saved window size
 * and last session. A headless Chrome that shuts down properly writes its own 800×600 size and an
 * about:blank session there, so the window would next open small and blank.
 */
export async function snapshotWindowState(userDataDir: string): Promise<WindowStateSnapshot> {
  let placement: unknown
  let preferencesRead = false
  try {
    const parsed = JSON.parse(await readFile(join(userDataDir, 'Default', 'Preferences'), 'utf8')) as Json
    placement = (parsed.browser as Json | undefined)?.window_placement
    if (isHeadlessPlacement(placement)) placement = undefined
    preferencesRead = true
  } catch (error) {
    preferencesRead = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  let sessions: Map<string, Buffer> | null = null
  const folder = join(userDataDir, 'Default', 'Sessions')
  try {
    sessions = new Map()
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isFile()) sessions.set(entry.name, await readFile(join(folder, entry.name)))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    sessions = null
  }
  return { placement, preferencesRead, sessions }
}

/** After the headless run: the window size and last session exactly as they were before it. */
export async function restoreWindowState(userDataDir: string, snapshot: WindowStateSnapshot): Promise<void> {
  const path = join(userDataDir, 'Default', 'Preferences')
  if (snapshot.preferencesRead) {
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as Json
      const browser = { ...((current.browser as Json | undefined) ?? {}) }
      if (snapshot.placement === undefined) delete browser.window_placement
      else browser.window_placement = snapshot.placement
      const next = { ...current, browser }
      const temporary = `${path}.fb-tmp`
      await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const folder = join(userDataDir, 'Default', 'Sessions')
  await rm(folder, { recursive: true, force: true })
  if (snapshot.sessions) {
    await mkdir(folder, { recursive: true })
    for (const [name, data] of snapshot.sessions) await writeFile(join(folder, name), data)
  }
}
