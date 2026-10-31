import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detachKernelFolderFonts, kernelFontStoreReady, linkKernelFonts } from './kernel-fonts'

async function fontFolder(root: string, extra: string[] = []): Promise<void> {
  for (const windows of ['win10', 'win11']) {
    await mkdir(join(root, windows, 'base'), { recursive: true })
    await writeFile(join(root, windows, 'base', 'arial.ttf'), windows)
    await writeFile(join(root, windows, 'fallback.txt'), 'base')
    for (const script of extra) {
      await mkdir(join(root, windows, script), { recursive: true })
      await writeFile(join(root, windows, script, `${script}.ttf`), script)
    }
  }
}

describe('shared kernel fonts', () => {
  let dir: string
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('takes the fonts of the first prism16 kernel as the store, links every kernel to it and keeps its language packages', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kernel-fonts-'))
    const store = join(dir, 'kernel-fonts', 'v1')
    const first = join(dir, 'kernels', 'prism-156', 'browser')
    const second = join(dir, 'kernels', 'prism-155', 'browser')
    await fontFolder(join(first, 'prism-system-fonts'))
    await fontFolder(join(second, 'prism-system-fonts'), ['Jpan'])

    // The first kernel's own fonts become the store (moved, not downloaded).
    expect(await linkKernelFonts(first, store)).toBe(true)
    expect(await kernelFontStoreReady(store)).toBe(true)
    expect((await lstat(join(first, 'prism-system-fonts'))).isSymbolicLink()).toBe(true)
    expect(resolve(await readlink(join(first, 'prism-system-fonts')))).toBe(resolve(store))

    // The second kernel's copy goes; a language package it downloaded is kept in the store.
    expect(await linkKernelFonts(second, store)).toBe(true)
    expect((await lstat(join(second, 'prism-system-fonts'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(store, 'win11', 'Jpan', 'Jpan.ttf'), 'utf8')).toBe('Jpan')
    expect(await readFile(join(first, 'prism-system-fonts', 'win10', 'Jpan', 'Jpan.ttf'), 'utf8')).toBe('Jpan')

    // Linking again changes nothing.
    expect(await linkKernelFonts(first, store)).toBe(true)

    // Removing a kernel folder never reaches the store through its link.
    await detachKernelFolderFonts(join(dir, 'kernels', 'prism-156'))
    await rm(join(dir, 'kernels', 'prism-156'), { recursive: true, force: true })
    expect(await kernelFontStoreReady(store)).toBe(true)
  })

  it('links a kernel without fonts to the store, and says when the store has to be downloaded first', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kernel-fonts-'))
    const store = join(dir, 'kernel-fonts', 'v1')
    const kernel = join(dir, 'kernels', 'prism-157', 'browser')
    await mkdir(kernel, { recursive: true })
    expect(await linkKernelFonts(kernel, store)).toBe(false)
    await fontFolder(store)
    expect(await linkKernelFonts(kernel, store)).toBe(true)
    expect(await readFile(join(kernel, 'prism-system-fonts', 'win11', 'base', 'arial.ttf'), 'utf8')).toBe('win11')
  })

  it('points a link left from an old data folder at the current store', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kernel-fonts-'))
    const old = join(dir, 'old', 'kernel-fonts', 'v1')
    const store = join(dir, 'new', 'kernel-fonts', 'v1')
    const kernel = join(dir, 'new', 'kernels', 'prism-156', 'browser')
    await fontFolder(old)
    await fontFolder(store)
    await mkdir(kernel, { recursive: true })
    expect(await linkKernelFonts(kernel, old)).toBe(true)
    await rm(join(dir, 'old'), { recursive: true, force: true })
    expect(await linkKernelFonts(kernel, store)).toBe(true)
    expect(resolve(await readlink(join(kernel, 'prism-system-fonts')))).toBe(resolve(store))
  })
})
