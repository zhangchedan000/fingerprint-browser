import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserProfile, FingerprintConfig } from '../shared/types'
import { osPasswordCheck, type OsPasswordCheck } from './os-password'

type Json = Record<string, unknown>

/** Chromium's content-setting values for the default geolocation permission. */
const GEOLOCATION_SETTING: Record<'allow' | 'block', number> = { allow: 1, block: 2 }

/**
 * Chromium's serialized TemplateURLData for Google, as a user-added engine: the kernels'
 * prepopulated engine 1 is ungoogled-chromium's “No Search” (http://{searchTerms}), which is why a
 * typed word opened http://word. A prepopulate_id would be replaced by that entry.
 */
export const GOOGLE_SEARCH: Json = {
  short_name: 'Google',
  keyword: 'google.com',
  favicon_url: 'https://www.google.com/favicon.ico',
  url: 'https://www.google.com/search?q={searchTerms}&ie={inputEncoding}',
  suggestions_url: 'https://www.google.com/complete/search?client=chrome&q={searchTerms}',
  input_encodings: ['UTF-8'],
  prepopulate_id: 0,
  safe_for_autoreplace: true,
  is_active: 1
}

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

  // “Always use secure connections”: a typed www.example.com opens over https first, as in Chrome.
  next.https_only_mode_enabled = true

  // Search from the address bar with Google, unless the user picked another engine in the window.
  // ungoogled-chromium writes its “No Search” engine there on first run, which counts as unset.
  const engine = (next.default_search_provider_data as Json | undefined)?.template_url_data as Json | undefined
  if (!engine || engine.url === 'http://{searchTerms}') child(next, 'default_search_provider_data').template_url_data = GOOGLE_SEARCH

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
