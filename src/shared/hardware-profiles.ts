import type { BrowserPlatform, FingerprintConfig, HardwareProfileId } from './types'
import { allKernelGpus, findKernelGpu, gpuForSeed, seedForGpu, type GpuChoice, type KernelGpu } from './gpu-catalog'

export interface HardwareProfile {
  id: Exclude<HardwareProfileId, 'legacy-custom'>
  label: string
  description: string
  platform: BrowserPlatform
  platformVersion: string
  hardwareConcurrency: number
  physicalMemoryGb: number
  browserDeviceMemoryGb: 8
  screenWidth: number
  screenHeight: number
  gpuModel: string
  /** Fixed templates name their GPU (key from gpu-catalog); seeded ones let the kernel pick by seed. */
  gpu?: string
  renderIdentityMode: 'host-native' | 'seeded-curated' | 'fixed-template'
  hostMatched: boolean
}

/**
 * Hardware presets. GPUs are named by key (see gpu-catalog.ts), so a preset means the same card
 * on every kernel version that has it.
 */
export const HARDWARE_PROFILES: readonly HardwareProfile[] = [
  {
    id: 'macos-host',
    label: 'macOS · 本机硬件（推荐）',
    description: '保留本机 GPU、字体、Canvas 和 Audio，避免渲染信号互相矛盾。',
    platform: 'macos',
    platformVersion: '15.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1440,
    screenHeight: 900,
    gpuModel: '本机 GPU',
    renderIdentityMode: 'host-native',
    hostMatched: true
  },
  {
    id: 'macos-seeded-apple',
    label: 'macOS · 种子独立 Apple GPU（推荐多环境）',
    description: '8 核 CPU、16GB 内存、1440×900；GPU 型号由环境种子固定选择。',
    platform: 'macos',
    platformVersion: '15.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1440,
    screenHeight: 900,
    gpuModel: '按种子从内核显卡清单中选择',
    renderIdentityMode: 'seeded-curated',
    hostMatched: false
  },
  {
    id: 'macos-m1',
    label: 'macOS · Apple M1 · 8GB',
    description: '8 核 CPU、Apple M1 GPU、1440×900。',
    platform: 'macos',
    platformVersion: '13.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 8,
    browserDeviceMemoryGb: 8,
    screenWidth: 1440,
    screenHeight: 900,
    gpuModel: 'Apple M1',
    gpu: 'Apple M1',
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'macos-m3-pro',
    label: 'macOS · Apple M3 Pro · 18GB',
    description: '12 核 CPU、Apple M3 Pro GPU、1512×982。',
    platform: 'macos',
    platformVersion: '14.0.0',
    hardwareConcurrency: 12,
    physicalMemoryGb: 18,
    browserDeviceMemoryGb: 8,
    screenWidth: 1512,
    screenHeight: 982,
    gpuModel: 'Apple M3 Pro',
    gpu: 'Apple M3 Pro',
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'macos-m4-pro',
    label: 'macOS · Apple M4 Pro · 24GB',
    description: '12 核 CPU、Apple M4 Pro GPU、1512×982。',
    platform: 'macos',
    platformVersion: '15.0.0',
    hardwareConcurrency: 12,
    physicalMemoryGb: 24,
    browserDeviceMemoryGb: 8,
    screenWidth: 1512,
    screenHeight: 982,
    gpuModel: 'Apple M4 Pro',
    gpu: 'Apple M4 Pro',
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'windows-host',
    label: 'Windows · 本机硬件（推荐）',
    description: '保留本机 GPU、字体、Canvas 和 Audio，避免渲染信号互相矛盾。',
    platform: 'windows',
    platformVersion: '10.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    gpuModel: '本机 GPU',
    renderIdentityMode: 'host-native',
    hostMatched: true
  },
  {
    id: 'windows-seeded-nvidia',
    label: 'Windows · 种子独立显卡（推荐多环境）',
    description: '8 核 CPU、16GB 内存、1920×1080；显卡由环境种子从内核清单中选择，也可以手动指定。',
    platform: 'windows',
    platformVersion: '10.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    gpuModel: '按种子从内核显卡清单中选择',
    renderIdentityMode: 'seeded-curated',
    hostMatched: false
  },
  {
    id: 'windows-10-rtx3060',
    label: 'Windows 10 · RTX 3060 · 16GB',
    description: '8 核 CPU、NVIDIA RTX 3060、1920×1080。',
    platform: 'windows',
    platformVersion: '10.0.0',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    gpuModel: 'NVIDIA GeForce RTX 3060',
    gpu: 'NVIDIA GeForce RTX 3060|0x00002487',
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'windows-11-rtx4060',
    label: 'Windows 11 · RTX 4060 · 16GB',
    description: '12 核 CPU、NVIDIA RTX 4060、1920×1080；Windows UA 仍使用 NT 10.0。',
    platform: 'windows',
    platformVersion: '19.0.0',
    hardwareConcurrency: 12,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    gpuModel: 'NVIDIA GeForce RTX 4060',
    gpu: 'NVIDIA GeForce RTX 4060|0x00002882',
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  },
  {
    id: 'windows-11-rtx4070',
    label: 'Windows 11 · RTX 4070 · 32GB',
    description: '16 核 CPU、NVIDIA RTX 4070、2560×1440；Windows UA 仍使用 NT 10.0。',
    platform: 'windows',
    platformVersion: '19.0.0',
    hardwareConcurrency: 16,
    physicalMemoryGb: 32,
    browserDeviceMemoryGb: 8,
    screenWidth: 2560,
    screenHeight: 1440,
    gpuModel: 'NVIDIA GeForce RTX 4070',
    gpu: 'NVIDIA GeForce RTX 4070|0x00002786',
    renderIdentityMode: 'fixed-template',
    hostMatched: false
  }
]

export function hardwareProfile(id: HardwareProfileId): HardwareProfile | undefined {
  return HARDWARE_PROFILES.find((profile) => profile.id === id)
}

export function defaultHardwareProfileId(platform: BrowserPlatform): HardwareProfileId {
  return platform === 'windows' ? 'windows-seeded-nvidia' : 'macos-seeded-apple'
}

export interface ApplyHardwareProfileOptions {
  /** Forget a hand-picked GPU so the kernel picks one by seed again (used by "random fingerprint"). */
  refreshSeededGpu?: boolean
}

export function applyHardwareProfile(
  config: FingerprintConfig,
  id: HardwareProfileId,
  options: ApplyHardwareProfileOptions = {}
): FingerprintConfig {
  const { gpuBucket: _legacyBucket, ...rest } = config
  const profile = hardwareProfile(id)
  if (!profile) {
    return { ...rest, hardwareProfileId: id, gpu: undefined, renderIdentityVersion: undefined }
  }
  const keepPicked = profile.renderIdentityMode === 'seeded-curated'
    && config.hardwareProfileId === id
    && !options.refreshSeededGpu
  const gpu = profile.renderIdentityMode === 'fixed-template'
    ? profile.gpu
    : keepPicked ? config.gpu : undefined
  return {
    ...rest,
    hardwareProfileId: profile.id,
    gpu,
    renderIdentityVersion: profile.renderIdentityMode === 'host-native' ? undefined : 4,
    platform: profile.platform,
    platformVersion: profile.platformVersion,
    hardwareConcurrency: profile.hardwareConcurrency,
    screenWidth: profile.screenWidth,
    screenHeight: profile.screenHeight
  }
}

/**
 * The seed handed to the kernel. With a picked GPU it is shifted so `kernelVersion` reports that
 * GPU; undefined means the kernel does not have it (launching would show a different card).
 */
export function effectiveFingerprintSeed(config: FingerprintConfig, kernelVersion?: string | null): number | undefined {
  const seed = config.seed >>> 0
  if (!config.gpu || hardwareProfile(config.hardwareProfileId)?.hostMatched) return seed
  return seedForGpu(seed, config.gpu, kernelVersion, config.platform)
}

/** The GPU a window shows on `kernelVersion`; undefined for host hardware or an unmeasured kernel. */
export function effectiveGpu(
  config: Pick<FingerprintConfig, 'seed' | 'hardwareProfileId' | 'gpu' | 'platform'>,
  kernelVersion?: string | null
): KernelGpu | undefined {
  if (hardwareProfile(config.hardwareProfileId)?.hostMatched) return undefined
  if (config.gpu) return findKernelGpu(config.gpu, config.platform)
  return gpuForSeed(config.seed, kernelVersion, config.platform)
}

/** GPUs a window on this platform can pick, each with the kernel versions that have it. */
export function gpuChoices(platform: BrowserPlatform): GpuChoice[] {
  return allKernelGpus(platform)
}

export function refreshSeededGpuIdentity(config: FingerprintConfig): FingerprintConfig {
  return applyHardwareProfile(config, config.hardwareProfileId, { refreshSeededGpu: true })
}

export function effectiveDisabledSpoofing(config: FingerprintConfig): FingerprintConfig['disabledSpoofing'] {
  const selected = new Set(config.disabledSpoofing)
  const profile = hardwareProfile(config.hardwareProfileId)
  if (profile?.hostMatched) {
    for (const surface of ['font', 'audio', 'canvas', 'clientrects'] as const) selected.add(surface)
    selected.add('gpu')
  }
  return [...selected]
}

export function hardwareProfileSummary(id: HardwareProfileId): string {
  if (id === 'legacy-custom') return '旧版自定义硬件配置'
  const profile = hardwareProfile(id)
  if (!profile) return '未知硬件模板'
  if (profile.hostMatched) return `本机 CPU · 本机内存 · 本机 GPU · ${profile.screenWidth}×${profile.screenHeight}`
  return `${profile.hardwareConcurrency} 核 · ${profile.physicalMemoryGb}GB · ${profile.gpuModel} · ${profile.screenWidth}×${profile.screenHeight}`
}

/**
 * The editor sets each value on its own, so a window that still follows an old fixed or host
 * template is shown (and saved) as the seeded template with the same values:
 * a fixed template keeps its GPU; a host template becomes "real" GPU, CPU and rendering surfaces.
 */
export function editableFingerprint(config: FingerprintConfig): FingerprintConfig {
  const profile = hardwareProfile(config.hardwareProfileId)
  if (profile?.renderIdentityMode === 'seeded-curated') return config
  const seeded = defaultHardwareProfileId(config.platform)
  const { gpuBucket: _legacy, overrides: _overrides, ...rest } = config
  if (profile?.hostMatched) {
    return {
      ...rest,
      hardwareProfileId: seeded,
      gpu: undefined,
      coresSource: 'host',
      renderIdentityVersion: 4,
      disabledSpoofing: [...new Set([...config.disabledSpoofing, 'font', 'audio', 'canvas', 'clientrects', 'gpu'] as const)]
    }
  }
  return { ...rest, hardwareProfileId: seeded, gpu: profile?.gpu ?? config.gpu, renderIdentityVersion: 4 }
}

