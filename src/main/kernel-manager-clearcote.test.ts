import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelManager } from './kernel-manager'
import type { SettingsStore } from './settings-store'
import { isKernelId, kernelChromiumVersion, kernelName, kernelShortName, kernelVendor } from '../shared/kernel-id'
import { kernelGpuList } from '../shared/gpu-catalog'
import { kernelKnownIssue } from '../shared/kernel-known-issues'

const digest = (char: string) => `sha256:${char.repeat(64)}`
const FP = [{
  tag_name: '148.0.7778.215', published_at: '2026-10-01T00:00:00Z', draft: false, prerelease: false,
  assets: [{ name: 'ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip', size: 189_767_686, digest: digest('a'),
    browser_download_url: 'https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215/ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip' }]
}]
const CLEARCOTE = ['24', '23'].map((n, index) => ({
  tag_name: `v0.1.0-pre.${n}`, published_at: `2026-10-1${5 - index}T00:00:00Z`, draft: false, prerelease: true,
  assets: [{ name: `clearcote-150.0.7871.11${4 - index}-windows-x64.zip`, size: 245_936_073, digest: digest('b'),
    browser_download_url: `https://github.com/clearcotelabs/clearcote-browser/releases/download/v0.1.0-pre.${n}/clearcote-150.0.7871.11${4 - index}-windows-x64.zip` }]
}))

describe('Clearcote kernels', () => {
  let vault: string
  const platform = process.platform
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kernels-'))
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: platform })
    await rm(vault, { recursive: true, force: true })
  })

  it('offers the newest Clearcote build next to fingerprint-chromium', async () => {
    const fetchImpl = (async (input: string) => new Response(JSON.stringify(String(input).includes('clearcote') ? CLEARCOTE : FP))) as typeof fetch
    const manager = new KernelManager(vault, { get: () => ({}) } as unknown as SettingsStore, () => undefined, undefined, () => [], fetchImpl)
    const releases = await manager.releases()
    expect(releases.map((release) => release.version)).toEqual(['148.0.7778.215', 'clearcote-150.0.7871.114'])
    expect(releases[1].sha256).toBe('b'.repeat(64))
  })

  it('still lists fingerprint-chromium when Clearcote cannot be reached', async () => {
    const fetchImpl = (async (input: string) => String(input).includes('clearcote')
      ? new Response('', { status: 503 })
      : new Response(JSON.stringify(FP))) as typeof fetch
    const manager = new KernelManager(vault, { get: () => ({}) } as unknown as SettingsStore, () => undefined, undefined, () => [], fetchImpl)
    expect((await manager.releases()).map((release) => release.version)).toEqual(['148.0.7778.215'])
  })

  it('keeps a Clearcote id apart from fingerprint-chromium of the same major', () => {
    const id = 'clearcote-150.0.7871.114'
    expect(isKernelId(id)).toBe(true)
    expect(isKernelId('other-150.0.7871.114')).toBe(false)
    expect(kernelVendor(id)).toBe('clearcote')
    expect(kernelChromiumVersion(id)).toBe('150.0.7871.114')
    expect(kernelName(id)).toBe('Clearcote 150.0.7871.114')
    expect(kernelShortName('148.0.7778.215')).toBe('Chromium 148')
    // The 150 crash and the 150 GPU list belong to fingerprint-chromium only.
    expect(kernelKnownIssue(id)).toBeUndefined()
    expect(kernelGpuList(id, 'windows')).toBeUndefined()
    expect(kernelKnownIssue('150.0.7871.50')).toBeDefined()
  })
})
