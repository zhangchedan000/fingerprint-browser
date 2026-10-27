import { isKernelId } from './kernel-id'
import { isVoiceLocale } from './windows-voices'
import { CHROME_UI_LOCALES } from './chrome-languages'
import { isMediaDevicesChoice, MEDIA_LOCALES } from './media-devices'
import { applyHardwareProfile, HARDWARE_PROFILES, hardwareProfile } from './hardware-profiles'
import { findKernelGpu, legacyBucketGpuKey } from './gpu-catalog'
import { findCpu } from './cpu-catalog'
import { DEVICE_NAME_PATTERN, MAC_ADDRESS_PATTERN } from './device-identity'
import { DEVICE_MEMORY_CHOICES } from './types'
import type { FingerprintOverride, GroupDraft, HardwareProfileId, PlatformAccount, ProfileDraft, ProxyConfig, ProxyDraft, WebRtcPolicy } from './types'
import { domainToASCII } from 'node:url'
import { isIP } from 'node:net'

export function normalizeUrl(value: string): string {
  const input = value.trim()
  if (!input) return ''
  if (input.length > 2048) throw new Error('启动页地址不能超过 2048 个字符')
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('启动页只支持 HTTP 或 HTTPS 地址')
  return url.toString()
}

export const EMPTY_ACCOUNT: PlatformAccount = { platform: '', username: '', password: '' }

export function validatePlatformAccount(input: PlatformAccount | undefined): PlatformAccount {
  if (input === undefined || input === null) return { ...EMPTY_ACCOUNT }
  if (typeof input !== 'object' || typeof input.platform !== 'string' || typeof input.username !== 'string'
    || typeof input.password !== 'string') {
    throw new Error('平台账号格式无效')
  }
  const platform = input.platform.trim()
  const username = input.username.trim()
  if (platform.length > 40) throw new Error('平台名称不能超过 40 个字符')
  if (username.length > 200) throw new Error('平台账号不能超过 200 个字符')
  if (input.password.length > 500) throw new Error('平台密码不能超过 500 个字符')
  const account: PlatformAccount = { platform, username, password: input.password }
  if (input.passwordStored === true) account.passwordStored = true
  return account
}

export function validateProfileDraft(draft: ProfileDraft): ProfileDraft & { account: PlatformAccount } {
  if (!draft || !draft.fingerprint || !draft.proxy || !Array.isArray(draft.startUrls)) {
    throw new Error('浏览器环境配置不完整')
  }
  if (typeof draft.name !== 'string' || typeof draft.note !== 'string' || typeof draft.group !== 'string'
    || typeof draft.color !== 'string' || typeof draft.kernelVersion !== 'string') {
    throw new Error('浏览器环境基础信息格式无效')
  }
  if (!Array.isArray(draft.tags) || !draft.tags.every((tag) => typeof tag === 'string')) throw new Error('环境标签格式无效')
  if (!Array.isArray(draft.extensionIds) || !draft.extensionIds.every((id) => typeof id === 'string')) {
    throw new Error('环境扩展配置格式无效')
  }
  if (!draft.startUrls.every((url) => typeof url === 'string')) throw new Error('启动页格式无效')
  if (draft.startupMode !== undefined && draft.startupMode !== 'urls' && draft.startupMode !== 'restore') throw new Error('启动页面模式无效')
  const name = draft.name.trim()
  if (!name) throw new Error('环境名称不能为空')
  if (name.length > 60) throw new Error('环境名称不能超过 60 个字符')
  if (draft.note.trim().length > 500) throw new Error('环境备注不能超过 500 个字符')
  if (!/^#[\da-f]{6}$/i.test(draft.color.trim())) throw new Error('环境标记颜色必须是六位十六进制颜色')
  const group = draft.group.trim()
  const tags = [...new Set(draft.tags.map((tag) => tag.trim()).filter(Boolean))]
  if (group.length > 40) throw new Error('环境分组不能超过 40 个字符')
  if (tags.length > 20 || tags.some((tag) => tag.length > 30)) throw new Error('最多设置 20 个标签，每个标签不超过 30 个字符')
  const extensionIds = [...new Set(draft.extensionIds)]
  if (extensionIds.length > 50 || extensionIds.some((id) => !/^[a-f\d-]{36}$/i.test(id))) {
    throw new Error('环境扩展配置无效或超过 50 个')
  }
  const kernelVersion = draft.kernelVersion.trim()
  if (kernelVersion && !isKernelId(kernelVersion)) {
    throw new Error('绑定内核版本必须是四段数字，例如 144.0.7559.132')
  }

  const urls = draft.startUrls.map(normalizeUrl).filter(Boolean)
  if (urls.length > 50) throw new Error('启动页不能超过 50 个')
  const proxy = validateProxyConfig(draft.proxy)
  const account = validatePlatformAccount(draft.account)
  const rawWindow = draft.window ?? { mode: 'auto', x: 0, y: 0, width: 1200, height: 800 }
  if (rawWindow.mode !== 'auto' && rawWindow.mode !== 'custom') throw new Error('浏览器窗口模式无效')
  const windowValues = [rawWindow.x, rawWindow.y, rawWindow.width, rawWindow.height]
  if (!windowValues.every(Number.isInteger)) throw new Error('浏览器窗口位置和尺寸必须是整数')
  if (rawWindow.x < -20000 || rawWindow.x > 20000 || rawWindow.y < -20000 || rawWindow.y > 20000) {
    throw new Error('浏览器窗口坐标超出允许范围')
  }
  if (rawWindow.width < 480 || rawWindow.width > 7680 || rawWindow.height < 360 || rawWindow.height > 4320) {
    throw new Error('浏览器窗口尺寸必须在 480×360 到 7680×4320 之间')
  }

  const rawFp = draft.fingerprint
  const hardwareProfileId = (rawFp.hardwareProfileId ?? 'legacy-custom') as HardwareProfileId
  const allowedHardwareProfiles = new Set<HardwareProfileId>(['legacy-custom', ...HARDWARE_PROFILES.map((profile) => profile.id)])
  if (!allowedHardwareProfiles.has(hardwareProfileId)) throw new Error('硬件模板无效')
  const allowedOverrides = new Set(['screen', 'cores', 'platformVersion'])
  if (rawFp.overrides !== undefined && (!Array.isArray(rawFp.overrides) || !rawFp.overrides.every((item) => allowedOverrides.has(item)))) {
    throw new Error('指纹自定义项无效')
  }
  const overrides = [...new Set(rawFp.overrides ?? [])]
  // Old saves kept a position in the 139–144 GPU list; keep the card it pointed at.
  const legacyGpu = rawFp.gpu === undefined && Number.isInteger(rawFp.gpuBucket)
    ? legacyBucketGpuKey(rawFp.gpuBucket!, rawFp.platform)
    : undefined
  const templated = applyHardwareProfile({ ...rawFp, gpu: rawFp.gpu ?? legacyGpu, hardwareProfileId }, hardwareProfileId)
  // Hand-set values win over the template; everything else stays coherent with it.
  // Seeded windows set every value on its own; only old fixed/host templates still own theirs.
  const ownValues = (item: FingerprintOverride) => overrides.includes(item)
    || hardwareProfile(hardwareProfileId)?.renderIdentityMode === 'seeded-curated'
  const fp = {
    ...templated,
    screenWidth: ownValues('screen') ? rawFp.screenWidth ?? templated.screenWidth : templated.screenWidth,
    screenHeight: ownValues('screen') ? rawFp.screenHeight ?? templated.screenHeight : templated.screenHeight,
    hardwareConcurrency: ownValues('cores') ? rawFp.hardwareConcurrency ?? templated.hardwareConcurrency : templated.hardwareConcurrency,
    platformVersion: ownValues('platformVersion') ? rawFp.platformVersion ?? templated.platformVersion : templated.platformVersion
  }
  if (rawFp.deviceMemory !== undefined && !DEVICE_MEMORY_CHOICES.includes(rawFp.deviceMemory)) throw new Error('设备内存只能是 2、4、8、16 或 32 GB')
  const cpu = rawFp.cpu ? findCpu(rawFp.cpu) : undefined
  if (rawFp.cpu && !cpu) throw new Error('不认识的 CPU 型号')
  // A CPU and a different core count would describe no real machine; the CPU wins.
  if (cpu && rawFp.coresSource !== 'host') fp.hardwareConcurrency = cpu.threads
  if (rawFp.deviceName && (typeof rawFp.deviceName !== 'string' || !DEVICE_NAME_PATTERN.test(rawFp.deviceName.trim()))) {
    throw new Error('设备名称只能包含字母、数字和连字符，最长 63 个字符')
  }
  if (rawFp.macAddress && (typeof rawFp.macAddress !== 'string' || !MAC_ADDRESS_PATTERN.test(rawFp.macAddress.trim()))) {
    throw new Error('MAC 地址格式应为 7A:C5:6F:F2:C2:84')
  }
  const coresSource = rawFp.coresSource ?? 'profile'
  if (coresSource !== 'profile' && coresSource !== 'host') throw new Error('CPU 核数来源无效')
  if (rawFp.voicesLocale && !isVoiceLocale(rawFp.voicesLocale)) throw new Error('语音语言无效')
  if (rawFp.mediaDevices && !isMediaDevicesChoice(rawFp.mediaDevices)) throw new Error('媒体设备设置无效')
  if (rawFp.mediaLocale && !MEDIA_LOCALES.includes(rawFp.mediaLocale)) throw new Error('设备名称语言无效')
  if (rawFp.uiLocale && !CHROME_UI_LOCALES.includes(rawFp.uiLocale)) throw new Error('界面语言无效')
  if (rawFp.region !== undefined && (typeof rawFp.region !== 'string' || !/^[A-Z]{2}$/.test(rawFp.region))) throw new Error('地区无效')
  const screenSource = rawFp.screenSource ?? 'profile'
  if (screenSource !== 'profile' && screenSource !== 'host') throw new Error('分辨率来源无效')
  const geolocationPermission = rawFp.geolocationPermission ?? 'ask'
  if (!['ask', 'allow', 'block'].includes(geolocationPermission)) throw new Error('地理位置权限无效')
  const doNotTrack = rawFp.doNotTrack ?? 'default'
  if (!['default', 'on', 'off'].includes(doNotTrack)) throw new Error('Do Not Track 设置无效')
  if (rawFp.portScanProtection !== undefined && typeof rawFp.portScanProtection !== 'boolean') throw new Error('端口扫描保护设置无效')
  if (!['windows', 'macos'].includes(fp.platform) || !['Chrome', 'Edge'].includes(fp.brand)) {
    throw new Error('指纹平台或浏览器品牌无效')
  }
  if (!Number.isInteger(fp.hardwareConcurrency) || fp.hardwareConcurrency < 2 || fp.hardwareConcurrency > 64) {
    throw new Error('CPU 核心数必须是 2–64 的整数')
  }
  if (!Number.isInteger(fp.seed) || fp.seed < 0 || fp.seed > 0xffffffff) {
    throw new Error('指纹种子必须是 0–4294967295 的整数')
  }
  if (fp.gpu !== undefined && typeof fp.gpu !== 'string') throw new Error('显卡型号无效')
  // Cards of the removed upstream kernels (laptops, Apple, seeded tables) are dropped, not
  // refused, so old windows still open; they then get a card from the Prism list.
  if (fp.gpu !== undefined && !findKernelGpu(fp.gpu, fp.platform)) fp.gpu = undefined
  if (fp.renderIdentityVersion !== undefined
    && fp.renderIdentityVersion !== 1
    && fp.renderIdentityVersion !== 2
    && fp.renderIdentityVersion !== 3
    && fp.renderIdentityVersion !== 4) {
    throw new Error('渲染身份版本无效')
  }
  if (!Number.isInteger(fp.screenWidth) || !Number.isInteger(fp.screenHeight) || fp.screenWidth < 800 || fp.screenHeight < 600) {
    throw new Error('屏幕分辨率不能小于 800×600')
  }
  if (fp.screenWidth > 7680 || fp.screenHeight > 4320) throw new Error('屏幕分辨率不能超过 7680×4320')
  const textFields = [fp.language, fp.acceptLanguages, fp.timezone, fp.platformVersion, fp.brandVersion]
  if (!textFields.every((value) => typeof value === 'string')) throw new Error('指纹文本配置格式无效')
  if (!fp.language.trim() || !fp.acceptLanguages.trim() || !fp.timezone.trim()) {
    throw new Error('语言、Accept-Language 和时区不能为空')
  }
  if (fp.acceptLanguages.length > 200 || fp.timezone.length > 100) throw new Error('语言或时区配置过长')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fp.timezone.trim() }).format()
  } catch {
    throw new Error('时区必须是有效的 IANA 时区，例如 Asia/Shanghai')
  }
  try {
    Intl.getCanonicalLocales(fp.language.trim())
  } catch {
    throw new Error('界面语言必须是有效的语言代码，例如 zh-CN')
  }
  // Windows saved before v0.5 may still say 'public_only' (仅公网); it is now 允许.
  const rawWebrtcPolicy = (fp.webrtcPolicy as string | undefined) ?? 'proxy_only'
  const webrtcPolicy = (rawWebrtcPolicy === 'public_only' ? 'default' : rawWebrtcPolicy) as WebRtcPolicy
  if (!['proxy_only', 'privacy', 'default', 'disabled'].includes(webrtcPolicy)) throw new Error('WebRTC 防泄漏策略无效')
  const networkIdentityMode = fp.networkIdentityMode ?? 'manual'
  if (!['manual', 'proxy'].includes(networkIdentityMode)) throw new Error('网络身份同步策略无效')
  const proxyExitPolicy = fp.proxyExitPolicy ?? 'warn'
  if (!['warn', 'block'].includes(proxyExitPolicy)) throw new Error('代理出口变化策略无效')
  if (fp.platformVersion.trim() && !/^\d+(?:\.\d+){0,3}$/.test(fp.platformVersion.trim())) {
    throw new Error('系统版本必须是 1–4 段数字，例如 10.0.0')
  }
  if (fp.brandVersion.trim() && !/^\d+(?:\.\d+){0,3}$/.test(fp.brandVersion.trim())) {
    throw new Error('浏览器品牌版本必须是 1–4 段数字，例如 148 或 148.0.7778.215')
  }
  const allowedSpoofing = new Set(['font', 'audio', 'canvas', 'clientrects', 'gpu'])
  if (!Array.isArray(fp.disabledSpoofing) || !fp.disabledSpoofing.every((item) => allowedSpoofing.has(item))) {
    throw new Error('指纹禁用项无效')
  }

  return {
    name,
    note: draft.note.trim(),
    group,
    tags,
    extensionIds,
    color: draft.color.trim(),
    startUrls: urls,
    startupMode: draft.startupMode ?? 'urls',
    kernelVersion,
    window: {
      mode: rawWindow.mode,
      x: rawWindow.x,
      y: rawWindow.y,
      width: rawWindow.width,
      height: rawWindow.height
    },
    proxy,
    account,
    fingerprint: {
      seed: fp.seed,
      hardwareProfileId: fp.hardwareProfileId,
      ...(fp.gpu ? { gpu: fp.gpu } : {}),
      ...(cpu && rawFp.coresSource !== 'host' ? { cpu: cpu.model } : {}),
      ...(rawFp.deviceName ? { deviceName: rawFp.deviceName.trim() } : {}),
      ...(rawFp.macAddress ? { macAddress: rawFp.macAddress.trim().toUpperCase() } : {}),
      renderIdentityVersion: fp.renderIdentityVersion,
      platform: fp.platform,
      language: fp.language.trim(),
      acceptLanguages: fp.acceptLanguages.trim(),
      timezone: fp.timezone.trim(),
      webrtcPolicy,
      networkIdentityMode,
      proxyExitPolicy,
      platformVersion: fp.platformVersion.trim(),
      brand: fp.brand,
      brandVersion: fp.brandVersion.trim(),
      hardwareConcurrency: fp.hardwareConcurrency,
      screenWidth: fp.screenWidth,
      screenHeight: fp.screenHeight,
      disabledSpoofing: [...fp.disabledSpoofing],
      ...(overrides.length ? { overrides } : {}),
      ...(screenSource !== 'profile' ? { screenSource } : {}),
      ...(coresSource !== 'profile' ? { coresSource } : {}),
      ...(rawFp.deviceMemory !== undefined && rawFp.deviceMemory !== 8 ? { deviceMemory: rawFp.deviceMemory } : {}),
      ...(geolocationPermission !== 'ask' ? { geolocationPermission } : {}),
      ...(doNotTrack !== 'default' ? { doNotTrack } : {}),
      ...(rawFp.portScanProtection === false ? { portScanProtection: false } : {}),
      ...(rawFp.voicesLocale ? { voicesLocale: rawFp.voicesLocale } : {}),
      ...(rawFp.mediaDevices && rawFp.mediaDevices !== 'auto' ? { mediaDevices: rawFp.mediaDevices } : {}),
      ...(rawFp.mediaLocale ? { mediaLocale: rawFp.mediaLocale } : {}),
      ...(rawFp.uiLocale ? { uiLocale: rawFp.uiLocale } : {}),
      ...(rawFp.region ? { region: rawFp.region } : {})
    }
  }
}

export function validateProxyConfig(input: ProxyConfig): ProxyConfig {
  if (!input || typeof input.protocol !== 'string') throw new Error('代理配置不完整')
  if (typeof input.host !== 'string' || typeof input.username !== 'string' || typeof input.password !== 'string') {
    throw new Error('代理配置格式无效')
  }
  const allowed = new Set(['direct', 'http', 'https', 'socks5'])
  if (!allowed.has(input.protocol)) throw new Error('不支持的代理协议')
  let host = input.host.trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const proxy: ProxyConfig = {
    protocol: input.protocol,
    host,
    port: input.port,
    username: input.username,
    password: input.password
  }
  if (input.passwordStored === true) proxy.passwordStored = true
  if (proxy.protocol === 'direct') {
    return { protocol: 'direct', host: '', username: '', password: '' }
  }
  if (!proxy.host) throw new Error('代理地址不能为空')
  if (proxy.host.length > 255) throw new Error('代理地址不能超过 255 个字符')
  if (/[/?#@\s]/.test(proxy.host) || proxy.host.includes('://')) {
    throw new Error('代理地址只能填写主机名或 IP，不能包含协议、端口、路径或认证信息')
  }
  if (isIP(proxy.host) === 0) {
    const asciiHost = domainToASCII(proxy.host)
    if (!asciiHost || asciiHost.length > 253
      || !asciiHost.split('.').every((label) => label.length > 0 && label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) {
      throw new Error('代理主机名格式无效')
    }
    proxy.host = asciiHost.toLowerCase()
  }
  if (!Number.isInteger(proxy.port) || Number(proxy.port) < 1 || Number(proxy.port) > 65535) {
    throw new Error('代理端口必须在 1–65535 之间')
  }
  if (proxy.username.length > 1024 || proxy.password.length > 2048) throw new Error('代理凭据长度超出限制')
  return proxy
}

/** A proxy added to or edited in the proxy library. */
export function validateProxyDraft(input: ProxyDraft): ProxyDraft & { port: number; note: string } {
  if (!input || typeof input !== 'object') throw new Error('代理配置不完整')
  if (input.protocol as string === 'direct') throw new Error('代理库只保存代理，直连不需要添加')
  const proxy = validateProxyConfig({ ...input, password: typeof input.password === 'string' ? input.password : '' })
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length > 200) throw new Error('代理备注不能超过 200 个字符')
  return {
    protocol: proxy.protocol as ProxyDraft['protocol'],
    host: proxy.host,
    port: proxy.port!,
    username: proxy.username,
    password: proxy.password,
    ...(proxy.passwordStored ? { passwordStored: true } : {}),
    note
  }
}

export function validateGroupName(input: unknown): string {
  if (typeof input !== 'string') throw new Error('分组名称格式无效')
  const name = input.trim()
  if (!name) throw new Error('分组名称不能为空')
  if (name.length > 40) throw new Error('环境分组不能超过 40 个字符')
  return name
}

export function validateGroupDraft(input: GroupDraft): { name: string; color?: string; note: string } {
  if (!input || typeof input !== 'object') throw new Error('分组名称格式无效')
  const name = validateGroupName(input.name)
  const color = typeof input.color === 'string' && input.color.trim() ? input.color.trim() : undefined
  if (color && !/^#[\da-f]{6}$/i.test(color)) throw new Error('分组颜色必须是六位十六进制颜色')
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length > 200) throw new Error('分组备注不能超过 200 个字符')
  return { name, ...(color ? { color } : {}), note }
}
