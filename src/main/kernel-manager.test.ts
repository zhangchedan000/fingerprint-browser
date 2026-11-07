import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelManager, RELEASE_LIST_STALE_MS, RELEASE_LIST_TTL_MS, uniqueBuildFolder } from './kernel-manager'
import { SettingsStore } from './settings-store'

const folders: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function vault(): Promise<{ path: string; manager: KernelManager; fetches: string[]; answer: { ok: boolean } }> {
  const path = await mkdtemp(join(tmpdir(), 'prism-kernels-'))
  folders.push(path)
  const settings = new SettingsStore(path)
  await settings.initialize()
  const fetches: string[] = []
  const answer = { ok: true }
  const fetchImpl = (async (input: string) => {
    fetches.push(String(input))
    if (!answer.ok) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 2100) } })
    return new Response(JSON.stringify([{ tag_name: `t${fetches.length}`, assets: [] }]), { status: 200 })
  }) as unknown as typeof fetch
  return { path, manager: new KernelManager(path, settings, () => undefined, undefined, () => [], fetchImpl), fetches, answer }
}

const manifest = (executableRelative: string) => JSON.stringify({
  version: 'prism-156.0.8078.47',
  assetName: 'k.zip',
  sha256: 'a'.repeat(64),
  installedAt: '2026-11-07T00:00:00.000Z',
  executableRelative
})

describe('kernel builds (an update goes into a new build folder; nothing in place is renamed)', () => {
  it('removes builds an update replaced and what interrupted installs left, keeping the build in use and the shared fonts', async () => {
    const { path, manager } = await vault()
    const kernel = join(path, 'kernels', 'prism-156.0.8078.47')
    const fonts = join(path, 'kernel-fonts', 'v1')
    await mkdir(join(fonts, 'win11'), { recursive: true })
    await writeFile(join(fonts, 'win11', 'keep.ttf'), 'font')
    for (const build of ['browser', 'build-20261107-100000', 'build-20261107-110000']) {
      await mkdir(join(kernel, build, 'browser'), { recursive: true })
      await writeFile(join(kernel, build, 'browser', 'chrome.exe'), 'exe')
      await symlink(fonts, join(kernel, build, 'browser', 'prism-system-fonts'), 'junction')
    }
    await writeFile(join(kernel, 'manifest.json'), manifest('build-20261107-110000\\browser\\chrome.exe'))
    await mkdir(join(path, 'kernels', '.install-prism-156.0.8078.47-abc'), { recursive: true })
    await mkdir(join(path, 'kernels', 'prism-156.0.8078.47.old-1794017390151', 'browser'), { recursive: true })

    await manager.installed()

    expect((await readdir(kernel)).sort()).toEqual(['build-20261107-110000', 'manifest.json'])
    expect(await readdir(join(path, 'kernels'))).toEqual(['prism-156.0.8078.47'])
    expect(existsSync(join(fonts, 'win11', 'keep.ttf'))).toBe(true)
  })

  it('keeps a kernel installed before build folders (browser\\chrome.exe) as it is', async () => {
    const { path, manager } = await vault()
    const kernel = join(path, 'kernels', 'prism-156.0.8078.47')
    await mkdir(join(kernel, 'browser'), { recursive: true })
    await writeFile(join(kernel, 'browser', 'chrome.exe'), 'exe')
    await writeFile(join(kernel, 'manifest.json'), manifest('browser\\chrome.exe'))
    await manager.installed()
    expect((await readdir(kernel)).sort()).toEqual(['browser', 'manifest.json'])
  })

  it('names build folders by local time, never reusing one', async () => {
    const { path } = await vault()
    const at = new Date(2026, 10, 7, 10, 28, 30)
    expect(await uniqueBuildFolder(path, at)).toBe('build-20261107-102830')
    await mkdir(join(path, 'build-20261107-102830'))
    expect(await uniqueBuildFolder(path, at)).toBe('build-20261107-102830-1')
  })
})

describe('GitHub release lists', () => {
  it('asks GitHub at most once every 10 minutes, and uses the last list while GitHub refuses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'))
    const { manager, fetches, answer } = await vault()
    const list = (manager as unknown as { fetchReleases(url: string): Promise<Array<{ tag_name: string }>> })
    const url = 'https://api.github.com/repos/zhangchedan000/prism-kernel-releases/releases?per_page=100'
    expect((await list.fetchReleases(url))[0].tag_name).toBe('t1')
    expect((await list.fetchReleases(url))[0].tag_name).toBe('t1')
    expect(fetches).toHaveLength(1)
    vi.setSystemTime(Date.now() + RELEASE_LIST_TTL_MS + 1000)
    expect((await list.fetchReleases(url))[0].tag_name).toBe('t2')
    // Rate limited: the last list stands in, for up to RELEASE_LIST_STALE_MS.
    answer.ok = false
    vi.setSystemTime(Date.now() + RELEASE_LIST_TTL_MS + 1000)
    expect((await list.fetchReleases(url))[0].tag_name).toBe('t2')
    vi.setSystemTime(Date.now() + RELEASE_LIST_STALE_MS)
    await expect(list.fetchReleases(url)).rejects.toThrow(/GitHub/)
  })
})
