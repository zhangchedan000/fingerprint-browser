import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNewerVersion, parseAppVersion, previousExePath, replaceExecutable, windowsExeAsset } from './app-updater'

describe('app updates', () => {
  it('compares release versions', () => {
    expect(parseAppVersion('v0.2.10')).toEqual([0, 2, 10])
    expect(parseAppVersion('kernel-156.0.8078.47-prism4')).toBeUndefined()
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('v0.10.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false)
  })

  it('takes the exe only from this repository', () => {
    const asset = (url: string) => ({ name: 'Fingerprint-Browser-0.2.0.exe', size: 1, browser_download_url: url, digest: null })
    expect(windowsExeAsset([asset('https://github.com/zhangchedan000/fingerprint-browser/releases/download/v0.2.0/x.exe')])).toBeDefined()
    expect(windowsExeAsset([asset('https://github.com/other/repo/releases/download/v0.2.0/x.exe')])).toBeUndefined()
  })

  it('replaces the exe in place while it is open, keeping the old one aside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'app-updater-'))
    try {
      const target = join(root, 'IDM下载', "Bob's Fingerprint.Browser.0.2.0.exe")
      const downloaded = join(root, 'Fingerprint-Browser-0.3.0.exe')
      await mkdir(join(root, 'IDM下载'))
      await writeFile(target, 'old')
      await writeFile(downloaded, 'new')
      const running = await open(target, 'r')
      try {
        await replaceExecutable(downloaded, target)
      } finally {
        await running.close()
      }
      expect(await readFile(target, 'utf8')).toBe('new')
      expect(await readFile(previousExePath(target), 'utf8')).toBe('old')
      expect(existsSync(downloaded)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('puts the old exe back when the new one cannot be copied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'app-updater-'))
    try {
      const target = join(root, 'Fingerprint.Browser.0.2.0.exe')
      await writeFile(target, 'old')
      await expect(replaceExecutable(join(root, 'missing.exe'), target)).rejects.toThrow('无法替换程序文件')
      expect(await readFile(target, 'utf8')).toBe('old')
      expect(existsSync(previousExePath(target))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
