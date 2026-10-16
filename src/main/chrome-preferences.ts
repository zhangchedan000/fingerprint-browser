import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FingerprintConfig } from '../shared/types'

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
  fingerprint: Pick<FingerprintConfig, 'geolocationPermission' | 'doNotTrack'>
): Json | undefined {
  const next = structuredClone(current)
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
  fingerprint: Pick<FingerprintConfig, 'geolocationPermission' | 'doNotTrack'>
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
  const next = patchChromePreferences(current, fingerprint)
  if (!next) return false
  await mkdir(directory, { recursive: true })
  const temporary = `${path}.fb-tmp`
  await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return true
}
