import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from './defaults'
import {
  applyHardwareProfile,
  effectiveDisabledSpoofing,
  effectiveFingerprintSeed,
  effectiveGpu,
  HARDWARE_PROFILES,
  hardwareProfile,
  defaultHardwareProfileId,
  refreshSeededGpuIdentity
} from './hardware-profiles'
import { gpuKey, kernelGpuList, MEASURED_KERNELS } from './gpu-catalog'
import { validateProfileDraft } from './validation'
import { defaultProfileDraft } from './defaults'

describe('coherent hardware profiles', () => {
  it('defines complete CPU, memory, GPU, OS and screen contracts', () => {
    expect(HARDWARE_PROFILES.length).toBeGreaterThanOrEqual(8)
    for (const profile of HARDWARE_PROFILES) {
      expect(profile.platformVersion).toMatch(/^\d+(?:\.\d+)+$/)
      expect(profile.hardwareConcurrency).toBeGreaterThanOrEqual(2)
      expect(profile.physicalMemoryGb).toBeGreaterThanOrEqual(profile.browserDeviceMemoryGb)
      expect(profile.gpuModel).not.toBe('')
      expect(['host-native', 'seeded-curated', 'fixed-template']).toContain(profile.renderIdentityMode)
      expect(profile.screenWidth).toBeGreaterThanOrEqual(800)
      expect(profile.screenHeight).toBeGreaterThanOrEqual(600)
    }
  })

  it('applies a preset atomically instead of mixing unrelated values', () => {
    const input = defaultFingerprint(123)
    const result = applyHardwareProfile(input, 'macos-m3-pro')
    const profile = hardwareProfile('macos-m3-pro')!

    expect(result).toMatchObject({
      platform: profile.platform,
      platformVersion: profile.platformVersion,
      hardwareConcurrency: profile.hardwareConcurrency,
      screenWidth: profile.screenWidth,
      screenHeight: profile.screenHeight
    })
  })

  it('names every fixed preset GPU from the measured kernel lists', () => {
    for (const profile of HARDWARE_PROFILES.filter((item) => item.renderIdentityMode === 'fixed-template')) {
      expect(profile.gpu).toBeTruthy()
      const config = applyHardwareProfile(defaultFingerprint(7), profile.id)
      // 139–144 have every preset GPU; the seed must make the kernel report exactly that card.
      for (const version of ['139.0.7258.154', '144.0.7559.132']) {
        const seed = effectiveFingerprintSeed(config, version)!
        const list = kernelGpuList(version, profile.platform)!
        expect(gpuKey(list[seed % list.length])).toBe(profile.gpu)
      }
    }
  })

  it('turns off injected rendering overrides for host-matched profiles', () => {
    const config = applyHardwareProfile(defaultFingerprint(1), 'macos-host')
    expect(effectiveDisabledSpoofing(config)).toEqual(['font', 'audio', 'canvas', 'clientrects', 'gpu'])
  })

  it('enables coherent rendering surfaces for simulated profiles', () => {
    const config = applyHardwareProfile(defaultFingerprint(1), 'macos-m3-pro')
    expect(effectiveDisabledSpoofing(config)).toEqual([])
    expect(config.renderIdentityVersion).toBe(4)
  })

  it('lets the kernel pick by seed unless a GPU was chosen', () => {
    expect(defaultHardwareProfileId('windows')).toBe('windows-seeded-nvidia')
    expect(defaultHardwareProfileId('macos')).toBe('macos-seeded-apple')
    const seeded = applyHardwareProfile(defaultFingerprint(42), 'windows-seeded-nvidia', { refreshSeededGpu: true })
    expect(seeded.gpu).toBeUndefined()
    expect(seeded.renderIdentityVersion).toBe(4)
    expect(effectiveFingerprintSeed(seeded, '150.0.7871.186')).toBe(42)
    // Same seed, different kernels, different cards: each kernel uses its own list.
    expect(effectiveGpu(seeded, '150.0.7871.186')).toEqual(kernelGpuList('150.0.7871.186', 'windows')![42 % 13])
    expect(effectiveGpu(seeded, '144.0.7559.132')).toEqual(kernelGpuList('144.0.7559.132', 'windows')![42 % 57])
  })

  it('makes every kernel report a chosen GPU, or refuses when the kernel lacks it', () => {
    for (const major of MEASURED_KERNELS) {
      const version = major === 'prism' ? 'prism-156.0.8078.47' : `${major}.0.0.0`
      for (const platform of ['windows', 'macos'] as const) {
        const list = kernelGpuList(version, platform)!
        for (const gpu of list) {
          const config = { ...defaultFingerprint(123456789), platform, hardwareProfileId: defaultHardwareProfileId(platform), gpu: gpuKey(gpu) }
          for (const seed of [0, 1, 0xfffffffe, 0xffffffff]) {
            const aligned = effectiveFingerprintSeed({ ...config, seed }, version)!
            expect(aligned).toBeLessThanOrEqual(0xffffffff)
            expect(gpuKey(list[aligned % list.length])).toBe(gpuKey(gpu))
          }
        }
      }
    }
    const rtx4070 = applyHardwareProfile(defaultFingerprint(1), 'windows-11-rtx4070')
    expect(effectiveFingerprintSeed(rtx4070, '150.0.7871.186')).toBeUndefined()
    expect(effectiveFingerprintSeed(rtx4070, '120.0.0.0')).toBeUndefined()
  })

  it('keeps the GPU an old save pointed at', () => {
    const draft = defaultProfileDraft()
    const saved = validateProfileDraft({
      ...draft,
      fingerprint: { ...draft.fingerprint, platform: 'windows', hardwareProfileId: 'windows-seeded-nvidia', gpuBucket: 29, gpu: undefined }
    })
    expect(saved.fingerprint.gpu).toBe('NVIDIA GeForce RTX 4060|0x00002882')
    expect(saved.fingerprint.gpuBucket).toBeUndefined()
  })
})

describe('editing old templates', () => {
  it('shows a fixed template as the seeded one with the same GPU', async () => {
    const { editableFingerprint } = await import('./hardware-profiles')
    const fixed = applyHardwareProfile(defaultFingerprint(5), 'windows-11-rtx4060')
    const editable = editableFingerprint(fixed)
    expect(editable).toMatchObject({ hardwareProfileId: 'windows-seeded-nvidia', gpu: 'NVIDIA GeForce RTX 4060|0x00002882', hardwareConcurrency: 12 })
  })

  it('shows a host template as real GPU, cores and rendering', async () => {
    const { editableFingerprint } = await import('./hardware-profiles')
    const host = applyHardwareProfile({ ...defaultFingerprint(5), platform: 'windows' }, 'windows-host')
    const editable = editableFingerprint(host)
    expect(editable.hardwareProfileId).toBe('windows-seeded-nvidia')
    expect(editable.coresSource).toBe('host')
    expect([...editable.disabledSpoofing].sort()).toEqual(['audio', 'canvas', 'clientrects', 'font', 'gpu'])
  })

})

describe('Prism kernels', () => {
  it('are named, versioned and given the desktop GPU list by the prism prefix', async () => {
    const { kernelName, kernelChromiumVersion, isKernelId } = await import('./kernel-id')
    const { kernelTakesExplicitGpu, maxDeviceMemoryGb } = await import('./kernel-capabilities')
    expect(isKernelId('prism-155.0.8059.84')).toBe(true)
    expect(kernelName('prism-156.0.8078.47')).toBe('Prism 156.0.8078.47')
    expect(kernelChromiumVersion('prism-156.0.8078.47')).toBe('156.0.8078.47')
    expect(kernelTakesExplicitGpu('prism-155.0.8059.84')).toBe(true)
    expect(kernelTakesExplicitGpu('150.0.7871.186')).toBe(false)
    expect(maxDeviceMemoryGb('prism-155.0.8059.84')).toBe(32)
    const list = kernelGpuList('prism-155.0.8059.84', 'windows')!
    expect(list.length).toBeGreaterThan(40)
    expect(list.every((gpu) => gpu.vendor === 'NVIDIA' && !/Laptop/.test(gpu.model))).toBe(true)
  })
})
