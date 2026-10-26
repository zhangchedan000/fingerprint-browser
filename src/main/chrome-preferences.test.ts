import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyChromePreferences, GOOGLE_SEARCH, patchChromePreferences } from './chrome-preferences'

const ALWAYS = { https_only_mode_enabled: true, default_search_provider_data: { template_url_data: GOOGLE_SEARCH } }

const paths: string[] = []
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function userData(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'fb-prefs-'))
  paths.push(path)
  return path
}

describe('chrome preferences', () => {
  it('enables native session restore and clears it when switching back to URLs', () => {
    const base = { session: { startup_urls: ['https://saved.example'], other: true } }
    const restore = patchChromePreferences(base, {}, 'restore')!
    expect(restore.session).toEqual({ ...base.session, restore_on_startup: 1 })
    const urls = patchChromePreferences(restore, {}, 'urls')!
    expect(urls.session).toEqual({ ...base.session, restore_on_startup: 5 })
    expect(base.session).not.toHaveProperty('restore_on_startup')
  })
  it('sets and clears geolocation and Do Not Track while keeping other settings', () => {
    const base = { profile: { name: 'x', default_content_setting_values: { notifications: 2 } }, other: true }
    const patched = patchChromePreferences(base, { geolocationPermission: 'block', doNotTrack: 'on' })!
    expect(patched).toEqual({ profile: { name: 'x', default_content_setting_values: { notifications: 2, geolocation: 2 } }, other: true, enable_do_not_track: true, ...ALWAYS })
    const cleared = patchChromePreferences(patched, {})!
    expect(cleared).toEqual({ profile: { name: 'x', default_content_setting_values: { notifications: 2 } }, other: true, ...ALWAYS })
    expect(patchChromePreferences(cleared, {})).toBeUndefined()
    expect(base.profile.default_content_setting_values).toEqual({ notifications: 2 })
  })

  it('creates the preferences file for a new window and leaves corrupt files alone', async () => {
    const dir = await userData()
    expect(await applyChromePreferences(dir, { geolocationPermission: 'allow', doNotTrack: 'off' })).toBe(true)
    const written = JSON.parse(await readFile(join(dir, 'Default', 'Preferences'), 'utf8'))
    expect(written.profile.default_content_setting_values.geolocation).toBe(1)
    expect(written.enable_do_not_track).toBe(false)

    const corrupt = await userData()
    await mkdir(join(corrupt, 'Default'), { recursive: true })
    await writeFile(join(corrupt, 'Default', 'Preferences'), '{not json')
    expect(await applyChromePreferences(corrupt, { geolocationPermission: 'block' })).toBe(false)
    expect(await readFile(join(corrupt, 'Default', 'Preferences'), 'utf8')).toBe('{not json')
  })

  it('writes https-first and Google search once, then leaves the file alone', async () => {
    const dir = await userData()
    expect(await applyChromePreferences(dir, {})).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'Default', 'Preferences'), 'utf8'))).toEqual(ALWAYS)
    expect(await applyChromePreferences(dir, {})).toBe(false)
  })

  it('keeps a search engine the user picked in the window', () => {
    const own = { https_only_mode_enabled: true, default_search_provider_data: { template_url_data: { short_name: 'Bing', keyword: 'bing.com' } } }
    expect(patchChromePreferences(own, {})).toBeUndefined()
    const noSearch = { https_only_mode_enabled: true, default_search_provider_data: { template_url_data: { short_name: 'No Search', url: 'http://{searchTerms}' } } }
    expect(patchChromePreferences(noSearch, {})).toEqual(ALWAYS)
  })
})
