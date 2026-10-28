import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { AppPreferences, AppSettings } from '../shared/types'
import { DEFAULT_KERNEL_SOURCES, validKernelSources, withOfficialKernelSource } from '../shared/kernel-sources'
import { validDeepCheckSites } from '../shared/deep-check'

export const DEFAULT_PREFERENCES: AppPreferences = { theme: 'light', batchLaunchGapSeconds: 1.5 }

/** Keeps only valid preference values; anything else falls back to the default. */
export function validPreferences(input: Partial<AppPreferences>, base: AppPreferences = DEFAULT_PREFERENCES): AppPreferences {
  const theme = input.theme === 'light' || input.theme === 'dark' || input.theme === 'system' ? input.theme : base.theme
  const gap = Number(input.batchLaunchGapSeconds)
  const batchLaunchGapSeconds = Number.isFinite(gap) && gap >= 0.5 && gap <= 30 ? Math.round(gap * 10) / 10 : base.batchLaunchGapSeconds
  const deepCheckSites = 'deepCheckSites' in input ? validDeepCheckSites(input.deepCheckSites) : base.deepCheckSites
  const folder = 'downloadFolder' in input ? input.downloadFolder : base.downloadFolder
  const downloadFolder = typeof folder === 'string' && isAbsolute(folder.trim()) && folder.trim().length <= 260 ? folder.trim() : undefined
  const downloadPerWindow = 'downloadPerWindow' in input ? input.downloadPerWindow === true : base.downloadPerWindow === true
  return {
    theme,
    batchLaunchGapSeconds,
    ...(deepCheckSites ? { deepCheckSites } : {}),
    ...(downloadFolder ? { downloadFolder } : {}),
    ...(downloadFolder && downloadPerWindow ? { downloadPerWindow: true } : {})
  }
}

export class SettingsStore {
  private settings: AppSettings = { browserExecutable: '', fingerprintKernel: false, enginePreference: 'auto', recycleRetentionDays: 0, kernelSources: [...DEFAULT_KERNEL_SOURCES], ...DEFAULT_PREFERENCES }
  private readonly path: string

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'settings.json')
  }

  async initialize(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.path, 'utf8')) as Partial<AppSettings>
      this.settings = {
        browserExecutable: typeof stored.browserExecutable === 'string' ? stored.browserExecutable : '',
        fingerprintKernel: stored.fingerprintKernel === true,
        enginePreference: stored.enginePreference === 'bundled' || stored.enginePreference === 'system' ? stored.enginePreference : 'auto',
        recycleRetentionDays: stored.recycleRetentionDays === 7 || stored.recycleRetentionDays === 30 || stored.recycleRetentionDays === 90
          ? stored.recycleRetentionDays
          : 0,
        kernelSources: withOfficialKernelSource(validKernelSources(stored.kernelSources)),
        ...validPreferences(stored)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(this.settings, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
    return this.get()
  }

  async hasConfiguredExecutable(): Promise<boolean> {
    if (!this.settings.browserExecutable) return false
    try {
      await access(this.settings.browserExecutable, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}
