import type { FingerprintConfig, ProxyConfig } from './types'

/** Identity of the proxy a check went through: a library proxy by id, a typed one by address. */
export function checkProxyKey(proxyId: string | undefined, proxy: Pick<ProxyConfig, 'protocol' | 'host' | 'port'>): string {
  if (proxyId) return `library:${proxyId}`
  return proxy.protocol === 'direct' ? 'direct' : `${proxy.protocol}://${proxy.host}:${proxy.port ?? ''}`
}

/** Every setting a fingerprint check depends on, so the editor can tell when a result is out of date. */
export function checkedSettingsKey(fp: FingerprintConfig, kernelVersion: string | null | undefined, proxyKey: string): string {
  const { seed, gpu, platform, platformVersion, brand, hardwareConcurrency, coresSource, deviceMemory, screenWidth, screenHeight,
    screenSource, timezone, language, networkIdentityMode, webrtcPolicy, disabledSpoofing } = fp
  return JSON.stringify({
    seed, gpu, platform, platformVersion, brand, hardwareConcurrency, coresSource: coresSource ?? 'profile', deviceMemory: deviceMemory ?? 8,
    screenWidth, screenHeight, screenSource: screenSource ?? 'profile', timezone, language, networkIdentityMode, webrtcPolicy,
    disabledSpoofing: [...disabledSpoofing].sort(), kernelVersion: kernelVersion ?? '', proxyKey
  })
}
