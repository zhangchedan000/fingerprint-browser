import { kernelChromiumVersion, kernelVendor } from './kernel-id'
import type { BrowserProfile, EngineStatus } from './types'
import { effectiveFingerprintSeed } from './hardware-profiles'
import { findKernelGpu, kernelGpuList } from './gpu-catalog'

function majorVersion(version: string | undefined): number | undefined {
  const match = kernelChromiumVersion(version)?.trim().match(/^(\d+)/)
  return match ? Number(match[1]) : undefined
}

export function fingerprintVersionWarning(brandVersion: string, engine: EngineStatus | null): string | undefined {
  if (!brandVersion.trim() || !engine?.fingerprintKernel || !engine.version) return undefined
  const requestedMajor = majorVersion(brandVersion)
  const engineMajor = majorVersion(engine.version)
  if (requestedMajor === undefined || engineMajor === undefined) return undefined
  if (requestedMajor !== engineMajor) return `品牌版本 ${brandVersion} 与指纹内核 ${engine.version} 的主版本不一致`
  if (brandVersion.trim() !== engine.version) return `启动时会将品牌版本 ${brandVersion} 统一为实际内核版本 ${engine.version}`
  return undefined
}

export function resolveFingerprintBrandVersion(brandVersion: string, engine: Pick<EngineStatus, 'fingerprintKernel' | 'version'>): string {
  if (engine.fingerprintKernel && engine.version) return kernelChromiumVersion(engine.version)
  return brandVersion.trim()
}

export function assertFingerprintKernelCompatibility(profile: BrowserProfile, engine: EngineStatus): void {
  const requestedMajor = majorVersion(profile.fingerprint.brandVersion)
  const engineMajor = majorVersion(engine.version)
  if (profile.fingerprint.brandVersion.trim() && engine.fingerprintKernel && requestedMajor !== undefined
      && engineMajor !== undefined && requestedMajor !== engineMajor) {
    throw new Error(`品牌版本 ${profile.fingerprint.brandVersion} 与指纹内核 ${engine.version} 的主版本不一致，请留空自动匹配`)
  }
  // Compatibility mode (an ordinary Chromium the user chose on purpose) fakes nothing; every
  // fingerprint kernel must be one of our Prism builds.
  if (!engine.fingerprintKernel) return
  if (kernelVendor(engine.version) !== 'prism') {
    throw new Error('现在只支持 Prism 内核：请在“内核管理”里导入或下载 Prism 内核，并在窗口设置里选用它')
  }
  const gpu = profile.fingerprint.gpu
  if (gpu && !engine.version) {
    throw new Error('无法识别当前内核的版本，不能使用指定的显卡；请在内核管理里用“导入本地内核”导入，或把显卡改为按种子随机')
  }
  if (!engine.version) return
  if (gpu && effectiveFingerprintSeed(profile.fingerprint, engine.version) === undefined) {
    const name = findKernelGpu(gpu, profile.fingerprint.platform)?.model ?? gpu
    throw new Error(kernelGpuList(engine.version, profile.fingerprint.platform)
      ? `内核 ${engine.version} 里没有显卡 ${name}，请在窗口设置里重新选择显卡`
      : `内核 ${engine.version} 还没有显卡清单，无法使用指定的显卡 ${name}，请改为按种子随机，或换用已支持的内核`)
  }
}
