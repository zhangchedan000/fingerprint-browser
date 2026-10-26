import { describe, expect, it } from 'vitest'
import { checksumFor, isSourceDownloadUrl, releaseCandidates, windowsKernelAsset, type GithubRelease } from './kernel-release-list'

const asset = (name: string, digest: string | null = null) => ({ name, size: 200_000_000, browser_download_url: `https://github.com/a/b/releases/download/t/${name}`, digest })
const release = (tag: string, assets: GithubRelease['assets'], extra: Partial<GithubRelease> = {}): GithubRelease =>
  ({ tag_name: tag, published_at: '2026-10-26T00:00:00Z', draft: false, prerelease: false, assets, ...extra })

describe('kernel releases from a GitHub project', () => {
  it('prefers the Prism zip and otherwise any Windows x64 zip', () => {
    expect(windowsKernelAsset([asset('chromedriver.exe'), asset('ungoogled-chromium_156.0.8078.47-1.1_windows_x64.zip')])?.name)
      .toBe('ungoogled-chromium_156.0.8078.47-1.1_windows_x64.zip')
    expect(windowsKernelAsset([asset('browser-arm64-windows.zip'), asset('browser_win_x64.zip')])?.name).toBe('browser_win_x64.zip')
    expect(windowsKernelAsset([asset('browser-linux-x64.zip'), asset('setup_x64.exe')])).toBeUndefined()
  })

  it('reads the Chromium version from the asset or the tag and skips drafts', () => {
    const list = releaseCandidates('a/b', [
      release('v2', [asset('fp_win_x64.zip', 'sha256:' + 'a'.repeat(64))], { published_at: '2026-10-25T00:00:00Z' }),
      release('kernel-155.0.8059.84-prism3', [asset('build_windows_x64.zip')]),
      release('draft', [asset('x_156.0.1.2_win_x64.zip')], { draft: true }),
      release('no-version', [asset('build_windows_x64.zip')])
    ])
    expect(list.map((item) => item.chromium)).toEqual(['155.0.8059.84'])
  })

  it('takes the digest when GitHub has one and a checksum file otherwise', () => {
    const [withDigest] = releaseCandidates('a/b', [release('t', [asset('x_156.0.8078.47_win_x64.zip', 'sha256:' + 'B'.repeat(64))])])
    expect(withDigest.sha256).toBe('b'.repeat(64))
    const [withFile] = releaseCandidates('a/b', [release('t', [asset('x_156.0.8078.47_win_x64.zip'), asset('SHA256SUMS.txt')])])
    expect(withFile.sha256).toBe('')
    expect(withFile.checksumAsset?.name).toBe('SHA256SUMS.txt')
    expect(checksumFor(`${'c'.repeat(64)}  x_156.0.8078.47_win_x64.zip\n`, 'x_156.0.8078.47_win_x64.zip')).toBe('c'.repeat(64))
    expect(checksumFor(`${'d'.repeat(64)}\n`, 'anything.zip')).toBe('d'.repeat(64))
  })

  it('downloads only from a listed project on github.com', () => {
    expect(isSourceDownloadUrl('https://github.com/A/B/releases/download/t/x.zip', ['a/b'])).toBe(true)
    expect(isSourceDownloadUrl('https://github.com/a/c/releases/download/t/x.zip', ['a/b'])).toBe(false)
    expect(isSourceDownloadUrl('http://github.com/a/b/releases/download/t/x.zip', ['a/b'])).toBe(false)
  })
})
