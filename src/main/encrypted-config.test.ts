import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decryptSwitches, hideFingerprintArgs, hiddenSwitch } from './encrypted-config'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const key = Buffer.alloc(32, 7)

describe('encrypted fingerprint config', () => {
  it('moves only the fingerprint switches into the file and keeps the rest in order', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'config-'))
    roots.push(folder)
    const args = ['--user-data-dir=C:\\p', '--fingerprint', '--fingerprint-brand=Chrome', '--lang=zh-CN', '--timezone=Asia/Tokyo',
      '--force-device-scale-factor=1.5', '--proxy-server=http://127.0.0.1:1', '--fingerprint-media-devices=扬声器 (Realtek)', 'https://example.com/']
    const { args: out, file } = await hideFingerprintArgs(args, folder, key)
    expect(out).toEqual(['--user-data-dir=C:\\p', '--proxy-server=http://127.0.0.1:1', `--fingerprint-config=${file}`, 'https://example.com/'])
    const text = await readFile(file!, 'utf8')
    expect(text.startsWith('PRISM1:')).toBe(true)
    expect(text).not.toContain('Chrome')
    expect(decryptSwitches(text, key)).toEqual([['fingerprint', ''], ['fingerprint-brand', 'Chrome'], ['lang', 'zh-CN'], ['timezone', 'Asia/Tokyo'],
      ['force-device-scale-factor', '1.5'], ['fingerprint-media-devices', '扬声器 (Realtek)']])
    expect(() => decryptSwitches(text, Buffer.alloc(32, 8))).toThrow()
  })

  it('leaves the arguments alone without a key and never hides its own switch', async () => {
    expect(await hideFingerprintArgs(['--fingerprint'], tmpdir(), undefined)).toEqual({ args: ['--fingerprint'] })
    expect(hiddenSwitch('fingerprint-config')).toBe(false)
    expect(hiddenSwitch('fingerprinting-canvas-image-data-noise')).toBe(true)
    expect(hiddenSwitch('user-data-dir')).toBe(false)
  })
})
