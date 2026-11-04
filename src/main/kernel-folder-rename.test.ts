import { describe, expect, it } from 'vitest'
import { KERNEL_FOLDER_IN_USE, renameKernelFolder } from './kernel-manager'

const busy = () => Object.assign(new Error("EPERM: operation not permitted, rename 'a' -> 'b'"), { code: 'EPERM' })

describe('moving an installed kernel aside', () => {
  it('tries again while a program holds the folder', async () => {
    let calls = 0
    await renameKernelFolder('a', 'b', undefined, 5, 0, async () => { calls += 1; if (calls < 3) throw busy() })
    expect(calls).toBe(3)
  })

  it('says what holds it and what to do after the last try', async () => {
    let calls = 0
    await expect(renameKernelFolder('a', 'b', undefined, 4, 0, async () => { calls += 1; throw busy() })).rejects.toThrow(KERNEL_FOLDER_IN_USE)
    expect(calls).toBe(4)
  })

  it('passes other errors on at once', async () => {
    let calls = 0
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    await expect(renameKernelFolder('a', 'b', undefined, 5, 0, async () => { calls += 1; throw missing })).rejects.toBe(missing)
    expect(calls).toBe(1)
  })
})
