import { getLocale, t, translateMessage as mt } from '../../../../shared/i18n'
import { fontPackLabel, windowsFontScript, type FontPackStatus } from '../../../../shared/windows-font-packs'
import { FontPackDownload } from '../../components/FontPackDownload'
import { effectiveScreen, kernelSpoofsScreen, randomScreen, screenChoices, screenFloor, screenKind } from '../../../../shared/screen'
import { relativeTime } from '../../components/format'
import {
  Alert,
  AutoComplete,
  Button,
  Collapse,
  ColorPicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
  Upload
} from 'antd'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultProfileDraft, randomSeed } from '../../../../shared/defaults'
import { fingerprintVersionWarning } from '../../../../shared/fingerprint-consistency'
import {
  applyHardwareProfile,
  defaultHardwareProfileId,
  editableFingerprint,
  effectiveGpu,
  gpuChoices
} from '../../../../shared/hardware-profiles'
import { deviceName, formatMac, isRandomMac, macAddress, macVendor, type NoiseSurface } from '../../../../shared/device-identity'
import { gpuKey, gpuLabel, kernelGpuList, kernelListLabel } from '../../../../shared/gpu-catalog'
import { CPU_MODELS, cpuFamilies, findCpu } from '../../../../shared/cpu-catalog'
import { kernelChromiumVersion } from '../../../../shared/kernel-id'
import { kernelTakesExplicitGpu, maxDeviceMemoryGb } from '../../../../shared/kernel-capabilities'
import { matchedHardware, matchedScreen } from '../../../../shared/hardware-match'
import { voiceLocaleForLanguage, WINDOWS_VOICE_LOCALES } from '../../../../shared/windows-voices'
import { autoMediaDevices, MEDIA_LOCALES, MEDIA_PRESETS } from '../../../../shared/media-devices'
import { CHROME_UI_LOCALES, chromeLanguageProfile, chromeUiLocaleFor } from '../../../../shared/chrome-languages'
import { checkedSettingsKey, checkProxyKey } from '../../../../shared/fingerprint-check-key'
import { acceptLanguageHeader, chromeAcceptLanguages, effectiveNetworkIdentity, localeForCountry } from '../../../../shared/network-identity'
import { allWindowsZones, countryWindowsZones, defaultCountryZone, windowsCountries, windowsReportedZone, windowsZoneLabel } from '../../../../shared/windows-time-zones'
import { PASTE_PLACEHOLDER, parsePastedProxy, pastedProxySummary, type PastedProxy } from '../../../../shared/proxy-paste'
import { parseCookieFile } from '../../../../main/cookie-file'
import { PLATFORMS } from '../../../../shared/platforms'
import type {
  BrowserExtension,
  BrowserPlatform,
  BrowserProfileView,
  EngineStatus,
  FingerprintCheckFix,
  FingerprintCheckItem,
  FingerprintCheckReport,
  FingerprintCheckRow,
  FingerprintConfig,
  KernelRelease,
  PlatformAccount,
  ProfileDraft,
  ProxyRecordView,
  ProxyConfig,
  ProxyTestResult,
  TunnelRoute
} from '../../../../shared/types'
import { DEVICE_MEMORY_CHOICES, type DeviceMemoryGb } from '../../../../shared/types'
import { proxyLabel } from '../../components/proxy'
import { defaultTunnelRoute, TunnelRouteField, useTunnelStatus } from '../../components/TunnelRouteField'
import { DeepCheck } from './DeepCheck'
import { kernelName } from '../../../../shared/kernel-id'

type SpoofSurface = FingerprintConfig['disabledSpoofing'][number]
type EditorTab = 'basic' | 'proxy' | 'fingerprint'
/** 'library' picks a proxy from the proxy library; the others type one in (it is saved into the library). */
type ProxyMode = 'direct' | 'http' | 'https' | 'socks5' | 'api' | 'library'

interface EditorValues extends Omit<ProfileDraft, 'startUrls' | 'color' | 'account' | 'proxyId'> {
  startUrlsText: string
  color: string | { toHexString: () => string }
  account: PlatformAccount
  cookieText: string
  proxyId: string
}

export interface ProfileEditorExtras {
  /** Cookie JSON pasted in the basic tab, imported after the window is saved. */
  cookieText: string
}

interface ProfileEditorProps {
  open: boolean
  profile?: BrowserProfileView
  suggestedIndex: number
  saving: boolean
  extensions: BrowserExtension[]
  engine: EngineStatus | null
  kernels: KernelRelease[]
  /** Group names from the group library. A new name typed here is added to the library on save. */
  groups: string[]
  /** The proxy library. */
  proxies: ProxyRecordView[]
  onCancel: () => void
  onSave: (draft: ProfileDraft, extras: ProfileEditorExtras) => Promise<void>
}

/** Login pages offered for the most common platforms; any other name can be typed. */
const WINDOWS_VERSIONS = [
  // What Chrome reports as Sec-CH-UA-Platform-Version (the UniversalApiContract major):
  // Windows 10 2004-22H2 report 10, Windows 11 24H2/25H2 report 19.
  { value: '10.0.0', label: 'Windows 10' },
  { value: '19.0.0', label: 'Windows 11' }
]
/** An older stored value: 13-18 are Windows 11 releases before 24H2, below 13 Windows 10. */
function windowsVersionLabel(value: string): string {
  return Number(value.split('.')[0]) >= 13 ? `Windows 11 · ${value}` : `Windows 10 · ${value}`
}
const MACOS_VERSIONS = [
  { value: '13.0.0', label: 'macOS 13' },
  { value: '14.0.0', label: 'macOS 14' },
  { value: '15.0.0', label: 'macOS 15' }
]

/** This computer's screen; kernels before prism5 can only claim one at least this large (screenFloor). */
function hostScreen(): { width: number; height: number } {
  return { width: window.screen.width, height: window.screen.height }
}
/** "1920 × 1080 · 1080p 16:9", "3440 × 1440 · 带鱼屏 21:9 2K", with the monitor size when the display is scaled. */
function screenLabel(width: number, height: number, physical: { width: number; height: number }): string {
  const kind = screenKind(physical)
  const note = [kind.ultrawide ? t("带鱼屏") : '', kind.ratio, kind.name ?? ''].filter(Boolean).join(' ')
  const scale = hostScale()
  return scale === 1
    ? `${width} × ${height} · ${note}`
    : t("{0} × {1} · {2} {3} 显示器 · 缩放 {4}%", width, height, `${physical.width}×${physical.height}`, note, Math.round(scale * 100))
}

/** This computer's Windows display scale; a window keeps it, so resolutions are offered at it. */
const hostScale = () => window.devicePixelRatio || 1
const isChoice = (width: number, height: number) => screenChoices(undefined, hostScale()).some((choice) => choice.width === width && choice.height === height)
const CORE_OPTIONS = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32]

function editorValues(profile: BrowserProfileView | undefined, index: number): EditorValues {
  const draft = profile ?? defaultProfileDraft(index)
  return {
    name: draft.name,
    note: draft.note,
    group: draft.group,
    tags: [...draft.tags],
    extensionIds: [...draft.extensionIds],
    color: draft.color,
    startUrlsText: draft.startUrls.join('\n'),
    startupMode: draft.startupMode ?? 'urls',
    kernelVersion: draft.kernelVersion,
    window: { ...draft.window },
    proxy: { ...draft.proxy },
    proxyId: profile && !profile.proxyMissing ? profile.proxyId : '',
    ...(profile?.tunnel ? { tunnel: { ...profile.tunnel } } : {}),
    account: profile
      ? { ...profile.account }
      : { platform: '', username: '', password: '' },
    cookieText: '',
    fingerprint: editableFingerprint({ ...draft.fingerprint, disabledSpoofing: [...draft.fingerprint.disabledSpoofing] })
  }
}

/** A different item from `list` than `current` (or any item when there is no other). */
function pickOther<T>(list: readonly T[], current: T): T {
  const others = list.filter((item) => item !== current)
  const pool = others.length ? others : list
  return pool[Math.floor(Math.random() * pool.length)]
}

/** Cores a real desktop commonly has; "换一换" picks from these. */
const COMMON_CORES = [4, 6, 8, 12, 16]

/** The UA Chrome reports with the reduced user-agent policy for the chosen system and kernel. */
function userAgentPreview(platform: BrowserPlatform, brand: string, version: string | undefined): string {
  const major = kernelChromiumVersion(version)?.split('.')[0] || '156'
  const system = platform === 'windows' ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7'
  const edge = brand === 'Edge' ? ` Edg/${major}.0.0.0` : ''
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${edge}`
}

function countPastedCookies(text: string): { count?: number; error?: string } {
  if (!text.trim()) return {}
  try {
    return { count: parseCookieFile(text).length }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** One label + controls line, laid out like the design's two-column rows. */
function Row({ label, children, hint, required, check }: { label: ReactNode; children: ReactNode; hint?: ReactNode; required?: boolean; check?: ReactNode }) {
  return (
    <div className="fb-form-row">
      <span className="fb-form-label">{label}{required && <em>*</em>}</span>
      <div className="fb-form-control">
        {children}
        {hint && <span className="fb-form-hint">{hint}</span>}
        {check}
      </div>
    </div>
  )
}

/** Fingerprint check results for one row: green / yellow / red, each with an optional one-click fix. */
function CheckResults({ items, stale, onFix }: { items: FingerprintCheckItem[]; stale: boolean; onFix: (item: FingerprintCheckItem) => void }) {
  if (!items.length) return null
  return (
    <div className={`fb-check-results${stale ? ' is-stale' : ''}`}>
      {items.map((item, index) => (
        <div key={index} className={`fb-check-item is-${item.status}`}>
          <span className="fb-check-dot" />
          <span className="fb-check-message">{mt(item.message)}</span>
          {item.fix && !stale && item.status !== 'ok' && (
            <Button type="link" size="small" onClick={() => onFix(item)}>{fixLabel(item.fix)}</Button>
          )}
        </div>
      ))}
    </div>
  )
}

function fixLabel(fix: FingerprintCheckFix): string {
  switch (fix) {
    case 'follow-ip': return t("改为跟随 IP")
    case 'webrtc-replace': return t("改为替换")
    case 'reseed': return t("换一组")
    case 'shuffle-gpu': return t("换一块显卡")
    case 'use-real': return t("改为本机真实")
  }
}

/** Shows the first validation message of a field rendered with `noStyle`. */
function FieldError({ name }: { name: Array<string | number> | string }) {
  return (
    <Form.Item noStyle shouldUpdate>
      {(form) => {
        const errors = form.getFieldError(name)
        return errors.length ? <div className="fb-form-error">{errors[0]}</div> : null
      }}
    </Form.Item>
  )
}

/** A fixed value the user can open to pick another (or "real"), plus a button that rolls a new one. */
function ValueChoice({ value, options, onChange, onShuffle, shuffleDisabled, label, wide }: {
  value: string | number
  options: Array<{ value: string | number; label: string; disabled?: boolean } | { label: string; options: Array<{ value: string | number; label: string; disabled?: boolean }> }>
  onChange: (value: never) => void
  onShuffle?: () => void
  shuffleDisabled?: boolean
  label: string
  wide?: boolean
}) {
  return (
    <Space size={8} className="fb-value-choice">
      <Select<string | number>
        className={wide ? 'fb-wide-select' : 'fb-fp-select'}
        showSearch={wide ? { optionFilterProp: 'label' } : undefined}
        value={value}
        onChange={onChange as (value: string | number) => void}
        options={options}
        aria-label={label}
        popupMatchSelectWidth={wide ? false : undefined}
      />
      {onShuffle && (
        <Button type="link" size="small" disabled={shuffleDisabled} onClick={onShuffle} aria-label={t("换一换")}>{t("换一换")}</Button>
      )}
    </Space>
  )
}

/** A typed value with a Shuffle button (device name, MAC address). */
function TextWithShuffle({ value, onChange, onShuffle, label }: { value: string; onChange: (value: string) => void; onShuffle: () => void; label: string }) {
  return (
    <Space size={8} className="fb-value-choice">
      <Input className="fb-fp-select fb-mono" value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} />
      <Button type="link" size="small" onClick={onShuffle}>{t("换一换")}</Button>
    </Space>
  )
}

/** A line that only explains what happens; there is nothing to choose. */
function Fixed({ children }: { children: ReactNode }) {
  return <span className="fb-fp-fixed">{children}</span>
}

/** Every IANA zone this Chromium knows, for the custom time zone dropdown. */
const TIME_ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf('timeZone') } catch { return ['Asia/Shanghai', 'America/New_York', 'Europe/London'] }
})()

/** A country named in the launcher's language. */
function regionName(code: string): string {
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** Countries a window can be set to: a Windows zone and a language Chrome has for it. */
function regionChoices() {
  return windowsCountries()
    .map((code) => ({ code, locale: localeForCountry(code), zone: defaultCountryZone(code) }))
    .filter((item): item is { code: string; locale: NonNullable<ReturnType<typeof localeForCountry>>; zone: string } => Boolean(item.locale && item.zone))
    .map((item) => ({ ...item, name: regionName(item.code) }))
    .sort((a, b) => (a.code === 'US' ? -1 : b.code === 'US' ? 1 : a.name.localeCompare(b.name, getLocale())))
}

/** A Chrome interface language named in itself, the way Chrome's language list shows it (zh-TW as zh-Hant). */
function ownLanguageName(locale: string): string {
  const named = locale === 'zh-TW' ? 'zh-Hant' : locale === 'zh-CN' ? 'zh-Hans' : locale
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(named) ?? locale
  } catch {
    return locale
  }
}

const samePrimary = (first: string, second: string) => first.split('-')[0].toLowerCase() === second.split('-')[0].toLowerCase()

/**
 * The languages a window can have: Chrome's own interface languages (locales.gni), each with the
 * navigator.language / Accept-Language such a Chrome reports, and whether the Windows language
 * packs give it Microsoft voices and device names.
 */
// One entry per browser language: several Chrome interface languages start their list with the
// same language (Urdu's is en-US), so keep the one whose interface is that language.
const LANGUAGES = CHROME_UI_LOCALES.map((uiLocale) => {
  const { language, acceptLanguages } = chromeLanguageProfile(uiLocale)
  return {
    uiLocale,
    language,
    acceptLanguages,
    name: ownLanguageName(language),
    voices: WINDOWS_VOICE_LOCALES.some(({ locale }) => samePrimary(locale, language)),
    devices: MEDIA_LOCALES.some((locale) => samePrimary(locale, language))
  }
}).filter((item, _index, all) => {
  const same = all.filter((other) => other.language === item.language)
  return item === (same.find((other) => samePrimary(other.uiLocale, other.language)) ?? same[0])
})

export function ProfileEditor({ open, profile, suggestedIndex, saving, extensions, engine, kernels, groups, proxies, onCancel, onSave }: ProfileEditorProps) {
  const riskLabels: Record<NonNullable<ProxyTestResult['networkRisk']>, string> = {
    tor: t("Tor 出口"),
    vpn: t("VPN 网络"),
    proxy: t("代理网络"),
    hosting: t("机房网络")
  }
  const [form] = Form.useForm<EditorValues>()
  const [tab, setTab] = useState<EditorTab>('basic')
  const [testingProxy, setTestingProxy] = useState(false)
  // Each 检测代理 gets a number; a result that comes back after the editor was reopened (or another
  // check started) is dropped instead of showing up, or keeping the button spinning.
  const proxyCheckRun = useRef(0)
  const [proxyResult, setProxyResult] = useState<ProxyTestResult | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [pasted, setPasted] = useState<PastedProxy | null>(null)
  const [screenCustom, setScreenCustom] = useState(false)
  const [proxyMode, setProxyMode] = useState<ProxyMode>('direct')
  const [checking, setChecking] = useState(false)
  // 换一换 on a fingerprint value runs the check again once the new settings are in the form.
  const [recheck, setRecheck] = useState(false)
  const [checkReport, setCheckReport] = useState<FingerprintCheckReport | null>(null)
  const [fontPacks, setFontPacks] = useState<FontPackStatus>()
  const [checkError, setCheckError] = useState('')

  const typedProtocol = Form.useWatch(['proxy', 'protocol'], { form, preserve: true }) ?? 'direct'
  const proxyId = Form.useWatch('proxyId', { form, preserve: true }) ?? ''
  const libraryProxy = proxyMode === 'library' ? proxies.find((item) => item.id === proxyId) : undefined
  /** Protocol of the proxy the window will use, whether typed or picked. */
  const proxyProtocol = proxyMode === 'library' ? libraryProxy?.protocol ?? 'direct' : proxyMode === 'api' ? 'http' : typedProtocol
  const sharedWith = libraryProxy ? libraryProxy.profileIds.filter((id) => id !== profile?.id).length : 0
  const tunnelStatus = useTunnelStatus()
  const watchedRoute = Form.useWatch('tunnel', { form, preserve: true }) as TunnelRoute | undefined
  /** The window's 网络加速: its own, else its proxy's default (older proxies: what the old rule did). */
  const shownRoute = watchedRoute ?? (proxyMode === 'library'
    ? defaultTunnelRoute(tunnelStatus, libraryProxy?.tunnel, libraryProxy ? libraryProxy.check?.countryCode ?? '' : undefined)
    : defaultTunnelRoute(tunnelStatus))
  // An HTTPS proxy cannot go through the tunnel (its certificate is checked against its own name).
  const route = proxyProtocol === 'https' && !libraryProxy?.apiUrl ? { ...shownRoute, enabled: false } : shownRoute
  const proxyPassword = Form.useWatch(['proxy', 'password'], { form, preserve: true }) ?? ''
  const proxyPasswordStored = Form.useWatch(['proxy', 'passwordStored'], { form, preserve: true }) === true
  const accountPassword = Form.useWatch(['account', 'password'], { form, preserve: true }) ?? ''
  const accountPasswordStored = Form.useWatch(['account', 'passwordStored'], { form, preserve: true }) === true
  const cookieText = Form.useWatch('cookieText', { form, preserve: true }) ?? ''
  const kernelVersion = Form.useWatch('kernelVersion', { form, preserve: true }) ?? ''
  const windowMode = Form.useWatch(['window', 'mode'], { form, preserve: true }) ?? 'auto'
  const initialFingerprint = useMemo(() => editorValues(profile, suggestedIndex).fingerprint, [profile, suggestedIndex])
  const watchedFingerprint = Form.useWatch('fingerprint', { form, preserve: true }) as Partial<FingerprintConfig> | undefined
  // `preserve` makes the watch report the whole fingerprint, not just the few keys that have a
  // Form.Item; without it clicks looked dead and a partial object crashed the drawer. Gaps (the
  // render between resetFields and setFieldsValue) are filled from the window being edited.
  const fp: FingerprintConfig = { ...initialFingerprint }
  for (const [key, value] of Object.entries(watchedFingerprint ?? {})) {
    if (value !== undefined) (fp as unknown as Record<string, unknown>)[key] = value
  }

  useEffect(() => {
    if (!open) return
    form.resetFields()
    form.setFieldsValue(editorValues(profile, suggestedIndex))
    setTab('basic')
    proxyCheckRun.current += 1
    setTestingProxy(false)
    setProxyResult(null)
    void window.browserApi.app.fontPacks().then(setFontPacks).catch(() => undefined)
    setPasteText('')
    setPasted(null)
    setPasteError('')
    setProxyMode(profile?.proxyId && !profile.proxyMissing ? 'library' : profile?.proxy.protocol ?? 'direct')
    const initial = editorValues(profile, suggestedIndex).fingerprint
    setScreenCustom(Boolean(initial.overrides?.includes('screen')
      && !isChoice(initial.screenWidth, initial.screenHeight)))
    setCheckReport(null)
    setCheckError('')
    let current = true
    if (profile) void window.browserApi.profiles.lastFingerprintCheck(profile.id).then((report) => { if (current) setCheckReport(report) }).catch(() => undefined)
    return () => { current = false }
  }, [form, open, profile, suggestedIndex])

  const pinnedKernel = kernels.find((kernel) => kernel.version === kernelVersion)
  const selectedEngine: EngineStatus | null = kernelVersion
    ? {
        executable: pinnedKernel?.executable ?? null,
        source: pinnedKernel ? 'profile' : 'missing',
        fingerprintKernel: true,
        label: pinnedKernel ? t("Prism 内核（环境固定）") : t("固定内核未安装"),
        version: kernelVersion,
        windowScreen: pinnedKernel?.windowScreen,
        webrtcRelay: pinnedKernel?.webrtcRelay
      }
    : engine
  const versionWarning = fingerprintVersionWarning(fp.brandVersion ?? '', selectedEngine)
  // The GPU list depends on the kernel this window will actually run.
  const windowKernelVersion = selectedEngine?.fingerprintKernel ? selectedEngine.version : undefined
  // prism5+ kernels keep the window inside the claimed screen, so it may be smaller than this one.
  const windowScreen = Boolean(selectedEngine?.fingerprintKernel && selectedEngine.windowScreen)
  // prism7+ kernels relay WebRTC UDP through the proxy and can remove WebRTC.
  const webrtcRelay = Boolean(selectedEngine?.fingerprintKernel && selectedEngine.webrtcRelay)
  const floor = screenFloor(hostScreen(), windowScreen)
  // A check describes the settings it ran with; any change since makes it out of date.
  const typedProxy = Form.useWatch('proxy', { form, preserve: true }) as ProxyConfig | undefined
  const currentSettingsKey = checkedSettingsKey(
    fp,
    kernelVersion || engine?.version,
    checkProxyKey(proxyMode === 'library' ? proxyId : undefined, typedProxy ?? { protocol: 'direct', host: '' })
  )
  const checkStale = Boolean(checkReport && checkReport.checkedSettings !== currentSettingsKey)
  useEffect(() => {
    if (!recheck || checking) return
    setRecheck(false)
    void runCheck()
  }, [recheck, checking, currentSettingsKey])
  const checkFor = (...rows: FingerprintCheckRow[]) => checkReport
    ? <CheckResults items={checkReport.items.filter((item) => rows.includes(item.row))} stale={checkStale} onFix={applyFix} />
    : undefined
  const kernelGpus = kernelGpuList(windowKernelVersion, fp.platform)
  const gpu = effectiveGpu(fp, windowKernelVersion)
  const gpuMissing = Boolean(fp.gpu && kernelGpus && !kernelGpus.some((item) => gpuKey(item) === fp.gpu))
  const gpuOptions = useMemo(() => {
    const available = new Set(kernelGpus?.map(gpuKey))
    return gpuChoices(fp.platform)
      .map((choice) => ({
        value: choice.key,
        label: `${gpuLabel(choice)} · ${t("内核 {0}", choice.kernels.map(kernelListLabel).join('/'))}`,
        disabled: kernelGpus ? !available.has(choice.key) : false
      }))
      .sort((a, b) => Number(a.disabled) - Number(b.disabled))
  }, [fp.platform, kernelGpus])
  const followIp = fp.networkIdentityMode === 'proxy'
  const networkIdentity = effectiveNetworkIdentity(fp, proxyResult?.ok ? proxyResult : libraryProxy?.check ?? profile?.proxyCheck)
  const cookiePreview = useMemo(() => countPastedCookies(cookieText), [cookieText])
  const regions = useMemo(regionChoices, [])
  // The exit country the proxy was last seen in, against the country picked by hand.
  const lastCheck = proxyResult?.ok ? proxyResult : libraryProxy?.check ?? profile?.proxyCheck
  const exitCountry = lastCheck?.countryCode
  const regionMismatch = !followIp && fp.region && exitCountry && proxyProtocol !== 'direct' && exitCountry.toUpperCase() !== fp.region
    ? { ip: exitCountry.toUpperCase(), window: fp.region }
    : undefined
  // Windows only has its own zones: the picked country's first, then the rest as Windows lists them.
  const timezoneOptions = useMemo(() => {
    const locale = getLocale()
    if (fp.platform !== 'windows') return [{ label: t("全部时区"), options: TIME_ZONES.map((zone) => ({ value: zone, label: zone })) }]
    const local = fp.region ? countryWindowsZones(fp.region, locale) : []
    const shown = new Set(local.map((zone) => zone.windows))
    const option = (zone: { iana: string; label: string }) => ({ value: zone.iana, label: `${zone.label} · ${zone.iana}` })
    const groups = [
      ...(local.length ? [{ label: regionName(fp.region!), options: local.map(option) }] : []),
      { label: t("全部时区"), options: allWindowsZones(locale).filter((zone) => !shown.has(zone.windows)).map(option) }
    ]
    const known = groups.some((group) => group.options.some((item) => item.value === fp.timezone))
    return known || !fp.timezone ? groups : [{ label: t("当前"), options: [{ value: fp.timezone, label: windowsZoneLabel(fp.timezone, locale) }] }, ...groups]
  }, [fp.platform, fp.region, fp.timezone])

  function chooseRegion(value: string): void {
    if (value === 'ip') { patchFingerprint({ networkIdentityMode: 'proxy' }); return }
    if (value === 'custom') { patchFingerprint({ networkIdentityMode: 'manual' }); return }
    const item = regions.find((entry) => entry.code === value)
    if (!item) return
    patchFingerprint({
      networkIdentityMode: 'manual',
      region: item.code,
      language: item.locale.language,
      acceptLanguages: item.locale.acceptLanguages,
      uiLocale: undefined,
      timezone: item.zone
    })
  }
  const running = Boolean(profile && profile.status !== 'closed' && profile.status !== 'error')

  function patchFingerprint(patch: Partial<FingerprintConfig>): void {
    form.setFieldValue('fingerprint', { ...form.getFieldValue('fingerprint'), ...patch })
  }

  function setSpoofing(surface: SpoofSurface, random: boolean): void {
    const current = new Set<SpoofSurface>(form.getFieldValue(['fingerprint', 'disabledSpoofing']) ?? [])
    if (random) current.delete(surface)
    else current.add(surface)
    patchFingerprint({ disabledSpoofing: [...current] })
  }

  /** The GPU shown now: the picked one, or what the kernel derives from the seed. */
  const gpuReal = fp.disabledSpoofing.includes('gpu')
  const shownGpuKey = fp.gpu ?? (gpu ? gpuKey(gpu) : undefined)

  // A new window starts as one coherent machine: the CPU and memory follow its GPU.
  useEffect(() => {
    if (!open || profile || fp.cpu || gpuReal || !shownGpuKey) return
    patchFingerprint({ gpu: shownGpuKey, ...matchedToGpu(shownGpuKey) })
  }, [open, profile, fp.cpu, gpuReal, shownGpuKey])

  /** New noise for every surface. The GPU is pinned first so only the noise changes. */
  // Device name and MAC: stored once shuffled or typed, otherwise derived from the seed.
  const shownDeviceName = fp.deviceName || deviceName(fp.seed, fp.platform)
  // Random addresses earlier launchers stored give way to a real maker's, in the system's own format.
  const shownGpuModel = shownGpuKey?.split('|')[0]
  const shownMacAddress = fp.macAddress && !isRandomMac(fp.macAddress)
    ? formatMac(fp.macAddress, fp.platform)
    : macAddress(fp.seed, fp.platform, shownGpuModel)
  const shownMacVendor = macVendor(shownMacAddress)

  /** New noise for every surface. GPU, device name and MAC are pinned first so only the noise changes. */
  function reseedNoise(): void {
    const current = form.getFieldValue('fingerprint') as FingerprintConfig
    patchFingerprint({
      seed: randomSeed(),
      gpu: current.gpu ?? shownGpuKey,
      deviceName: shownDeviceName,
      macAddress: shownMacAddress,
      renderIdentityVersion: 4
    })
  }

  /** The value a site sees, as the last check measured it; never a made-up stand-in. */
  function measured(surface: NoiseSurface): string | undefined {
    return checkReport && !checkStale ? checkReport.observed[surface][0] : undefined
  }

  function shownNoise(surface: NoiseSurface): string {
    return measured(surface) ?? t("每个窗口不同")
  }

  /** 换一换 on Canvas / AudioContext / ClientRects: new values, then the check reads what they are. */
  function reseedAndCheck(): void {
    reseedNoise()
    setRecheck(true)
  }

  /**
   * What a site reads for this value in this window, measured by the fingerprint check (the kernel
   * computes it on this computer's GPU and CPU, so the launcher cannot know it beforehand).
   */
  function measuredLine(surface: NoiseSurface) {
    const value = measured(surface)
    if (checking) return <span className="fb-fp-measured fb-muted">{t("正在检测实际值…")}</span>
    if (value) {
      return (
        <span className="fb-fp-measured">
          {t("网站读到")}<b className="fb-mono">{value}</b>
          <span className="fb-muted"> · {relativeTime(checkReport!.checkedAt, getLocale())}</span>
        </span>
      )
    }
    return (
      <span className="fb-fp-measured fb-muted">
        {checkReport ? t("设置已修改") : t("未检测")}
        <Button type="link" size="small" className="fb-deep-link" onClick={() => void runCheck()}>{t("检测实际值")}</Button>
      </span>
    )
  }

  /** Audio and ClientRects stay as the real machine computes them (kernel patches 006, 008). */
  function realSurface(surface: NoiseSurface) {
    const value = measured(surface)
    return <Fixed>{value ? t("本机真实 · {0}", value) : t("本机真实（与真实 Chrome 一致）")}</Fixed>
  }

  /** prism7+: each window its own audio / ClientRects (patches 006, 008), or the real values. */
  function seededControl(surface: NoiseSurface, label: string) {
    const real = fp.disabledSpoofing.includes(surface)
    return (
      <ValueChoice
        label={label}
        value={real ? 'real' : 'noise'}
        onChange={(next: string) => setSpoofing(surface, next === 'noise')}
        options={[{ value: 'noise', label: t("每个窗口不同") }, { value: 'real', label: t("本机真实") }]}
        onShuffle={reseedAndCheck}
        shuffleDisabled={real}
      />
    )
  }

  function noiseControl(surface: NoiseSurface, label: string) {
    const real = fp.disabledSpoofing.includes(surface)
    return (
      <ValueChoice
        label={label}
        value={real ? 'real' : 'noise'}
        onChange={(next: string) => setSpoofing(surface, next === 'noise')}
        options={[{ value: 'noise', label: webrtcRelay ? t("每个窗口不同") : shownNoise(surface) }, { value: 'real', label: t("本机真实") }]}
        onShuffle={webrtcRelay ? reseedAndCheck : reseedNoise}
        shuffleDisabled={real}
      />
    )
  }

  function chooseGpu(value: string): void {
    const disabled = (form.getFieldValue(['fingerprint', 'disabledSpoofing']) ?? []) as SpoofSurface[]
    if (value === 'real') {
      patchFingerprint({ gpu: undefined, disabledSpoofing: [...new Set([...disabled, 'gpu' as const])] })
      return
    }
    patchFingerprint({
      gpu: value,
      renderIdentityVersion: 4,
      disabledSpoofing: disabled.filter((item) => item !== 'gpu'),
      ...matchedToGpu(value)
    })
  }

  /** A CPU, core count and memory a real desktop with this card would have; all stay editable. */
  function matchedToGpu(key: string): Partial<FingerprintConfig> {
    if (fp.platform !== 'windows') return {}
    const model = key.split('|')[0]
    const { cpu, deviceMemory } = matchedHardware(model, maxDeviceMemoryGb(windowKernelVersion))
    const screen = kernelSpoofsScreen(windowKernelVersion) ? matchedScreen(model, floor, Math.random, hostScale()) : undefined
    return {
      cpu: cpu.model,
      coresSource: 'profile',
      hardwareConcurrency: cpu.threads,
      deviceMemory,
      ...(screen ? { screenSource: 'profile' as const, screenWidth: screen.width, screenHeight: screen.height } : {})
    }
  }

  function shuffleGpu(): void {
    if (!kernelGpus?.length) return
    chooseGpu(pickOther(kernelGpus.map(gpuKey), shownGpuKey ?? ''))
  }

  function chooseScreen(mode: string): void {
    if (mode === 'host') {
      patchFingerprint({ screenSource: 'host' })
      setScreenCustom(false)
      return
    }
    if (mode === 'custom') {
      patchFingerprint({ screenSource: 'profile' })
      setScreenCustom(true)
      return
    }
    const [width, height] = mode.split('x').map(Number)
    patchFingerprint({ screenSource: 'profile', screenWidth: width, screenHeight: height })
    setScreenCustom(false)
  }

  function shuffleScreen(): void {
    const current = `${fp.screenWidth}x${fp.screenHeight}`
    chooseScreen(pickOther(screenChoices(floor, hostScale()).map(({ width, height }) => `${width}x${height}`), current))
  }

  function chooseCores(value: number | 'host'): void {
    // A core count the chosen CPU does not have would describe no real machine: drop the CPU.
    const keepCpu = value !== 'host' && findCpu(fp.cpu)?.threads === value
    patchFingerprint(value === 'host'
      ? { coresSource: 'host', cpu: undefined }
      : { coresSource: 'profile', hardwareConcurrency: value, ...(keepCpu ? {} : { cpu: undefined }) })
  }

  function chooseCpu(model: string): void {
    const cpu = findCpu(model)
    patchFingerprint(cpu
      ? { cpu: cpu.model, coresSource: 'profile', hardwareConcurrency: cpu.threads }
      : { cpu: undefined })
  }

  function randomCpu(): typeof CPU_MODELS[number] {
    return CPU_MODELS[Math.floor(Math.random() * CPU_MODELS.length)]
  }

  function choosePlatformVersion(value: string): void {
    patchFingerprint({ platformVersion: value })
  }

  function choosePlatform(platform: BrowserPlatform): void {
    if (platform === fp.platform) return
    // A different system brings its own coherent defaults (version, screen, cores); the GPU is
    // rolled from the new system's list when it is known.
    const next = applyHardwareProfile(form.getFieldValue('fingerprint'), defaultHardwareProfileId(platform), { refreshSeededGpu: true })
    const list = kernelGpuList(windowKernelVersion, platform)
    const gpu = list?.length ? gpuKey(list[Math.floor(Math.random() * list.length)]) : undefined
    form.setFieldValue('fingerprint', {
      ...next,
      overrides: [],
      gpu,
      disabledSpoofing: next.disabledSpoofing.filter((item) => item !== 'gpu'),
      // "DESKTOP-…" on Windows, "Name-MacBook-Pro" on macOS; an Apple adapter on a Mac.
      deviceName: deviceName(randomSeed(), platform),
      macAddress: macAddress(randomSeed(), platform, gpu?.split('|')[0])
    })
  }

  /** "一键随机指纹": a new computer — new noise, GPU, cores and screen. */
  function randomizeAll(): void {
    const list = kernelGpuList(windowKernelVersion, fp.platform)
    const { width, height } = randomScreen(floor, Math.random, hostScale()) ?? hostScreen()
    const gpu = list?.length ? gpuKey(list[Math.floor(Math.random() * list.length)]) : undefined
    patchFingerprint({
      seed: randomSeed(),
      gpu,
      renderIdentityVersion: 4,
      coresSource: 'profile',
      ...(() => { const cpu = randomCpu(); return { cpu: cpu.model, hardwareConcurrency: cpu.threads } })(),
      screenSource: 'profile',
      screenWidth: width,
      screenHeight: height,
      // A picked card brings its own CPU, memory and resolution.
      ...(gpu ? matchedToGpu(gpu) : {}),
      disabledSpoofing: [],
      deviceName: deviceName(randomSeed(), fp.platform),
      macAddress: macAddress(randomSeed(), fp.platform, gpu?.split('|')[0])
    })
    setScreenCustom(false)
  }

  function applyPastedProxy(text: string): void {
    setPasteText(text)
    setPasted(null)
    if (!text.trim()) { setPasteError(''); return }
    try {
      const parsed = parsePastedProxy(text)
      setPasted(parsed)
      const current = form.getFieldValue('proxy')
      const protocol = parsed.protocol ?? (current.protocol === 'direct' ? 'socks5' : current.protocol)
      setProxyMode(protocol)
      form.setFieldValue('proxy', {
        ...current,
        protocol,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        passwordStored: false
      })
      setProxyResult(null)
      setPasteError('')
    } catch (error) {
      setPasteError(mt(error instanceof Error ? error.message : String(error)))
    }
  }

  function chooseProxyMode(mode: ProxyMode): void {
    setProxyMode(mode)
    setProxyResult(null)
    if (mode !== 'library' && mode !== 'api') form.setFieldValue(['proxy', 'protocol'], mode)
  }

  /**
   * A proxy checked while creating a window fills in its country, time zone and languages from that
   * IP and keeps them (the system language follows, and with it fonts, voices and device names):
   * a later IP, often another one for API and rotating proxies, does not change the window.
   * An existing window keeps its settings; a mismatch with the IP is only pointed out (regionMismatch).
   */
  function followCheckedIp(result: ProxyTestResult | null, run: number): void {
    if (run !== proxyCheckRun.current) return
    setProxyResult(result)
    if (!profile) fixToIp(result)
  }

  /** Fills in the country, time zone and languages of a checked IP and keeps them (they are not re-read at launch). */
  function fixToIp(result: ProxyTestResult | null | undefined): void {
    if (!result?.ok || result.geoConfidence === 'conflict' || !result.countryCode) return
    const region = regions.find((entry) => entry.code === result.countryCode!.toUpperCase())
    if (!region) return
    const current = form.getFieldValue('fingerprint') as FingerprintConfig
    const zone = result.timezone
      ? (current.platform === 'windows' ? windowsReportedZone(result.timezone, region.code) : result.timezone)
      : undefined
    patchFingerprint({
      networkIdentityMode: 'manual',
      region: region.code,
      language: region.locale.language,
      acceptLanguages: region.locale.acceptLanguages,
      uiLocale: undefined,
      timezone: zone ?? region.zone
    })
  }

  /** API 提取 typed into the window: only the link; the proxy comes from it when saved and at every launch. */
  function apiProxy(): ProxyConfig {
    return { protocol: 'http', host: '', username: '', password: '', apiUrl: String(form.getFieldValue(['proxy', 'apiUrl']) ?? '').trim(), tunnel: route }
  }

  async function testCurrentProxy(): Promise<void> {
    const run = ++proxyCheckRun.current
    try {
      if (proxyMode === 'library') {
        await form.validateFields(['proxyId'])
        setTestingProxy(true)
        setProxyResult(null)
        // Saved on the library proxy, so every window using it sees the result; reached the way this window will.
        followCheckedIp((await window.browserApi.proxy.check(form.getFieldValue('proxyId'), route)).check ?? null, run)
        return
      }
      if (proxyMode === 'api') {
        await form.validateFields([['proxy', 'apiUrl']])
        setTestingProxy(true)
        setProxyResult(null)
        followCheckedIp(await window.browserApi.proxy.test(apiProxy(), profile?.id), run)
        return
      }
      if (proxyProtocol !== 'direct') await form.validateFields([['proxy', 'host'], ['proxy', 'port']])
      setTestingProxy(true)
      setProxyResult(null)
      followCheckedIp(await window.browserApi.proxy.test({ ...form.getFieldValue('proxy'), tunnel: route }, profile?.id), run)
    } catch (error) {
      if (run !== proxyCheckRun.current) return
      if (!(error && typeof error === 'object' && 'errorFields' in error)) {
        setProxyResult({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) })
      } else {
        setTab('proxy')
      }
    } finally {
      if (run === proxyCheckRun.current) setTestingProxy(false)
    }
  }

  function onPlatformChange(platform: string): void {
    const known = PLATFORMS.find((item) => item.value === platform)
    const urls = String(form.getFieldValue('startUrlsText') ?? '').trim()
    if (known && (!urls || urls === 'https://browserleaks.com/')) form.setFieldValue('startUrlsText', known.url)
  }

  async function submit(): Promise<void> {
    try {
      await form.validateFields()
    } catch (error) {
      const fields = (error as { errorFields?: Array<{ name: Array<string | number> }> }).errorFields ?? []
      const first = fields[0]?.name[0]
      setTab(first === 'proxy' ? 'proxy' : first === 'fingerprint' ? 'fingerprint' : 'basic')
      return
    }
    if (cookiePreview.error) {
      setTab('basic')
      return
    }
    const values = form.getFieldsValue(true) as EditorValues
    await onSave(currentDraft(), { cookieText: values.cookieText ?? '' })
  }

  /** The window as currently edited, in the shape save and the fingerprint check both take. */
  function currentDraft(): ProfileDraft {
    const values = form.getFieldsValue(true) as EditorValues
    const color = typeof values.color === 'string' ? values.color : values.color.toHexString()
    return {
      name: values.name,
      note: values.note,
      group: values.group ?? '',
      tags: values.tags,
      color,
      startUrls: String(values.startUrlsText ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      startupMode: values.startupMode ?? 'urls',
      kernelVersion: values.kernelVersion,
      window: values.window,
      // A picked library proxy goes by id; a typed one is saved into the library by the store.
      ...(proxyMode === 'library'
        ? { proxyId: values.proxyId, proxy: { protocol: 'direct' as const, host: '', username: '', password: '' } }
        : proxyMode === 'api'
          ? { proxy: apiProxy() }
          : { proxy: values.proxy }),
      ...(proxyProtocol !== 'direct' ? { tunnel: route } : {}),
      account: values.account,
      extensionIds: values.extensionIds,
      fingerprint: values.fingerprint
    }
  }

  async function runCheck(): Promise<void> {
    setChecking(true)
    setCheckError('')
    try {
      setCheckReport(await window.browserApi.profiles.checkFingerprint(currentDraft(), profile?.id, currentSettingsKey))
    } catch (error) {
      setCheckError(mt(error instanceof Error ? error.message : String(error)))
    } finally {
      setChecking(false)
    }
  }

  function applyFix(item: FingerprintCheckItem): void {
    if (item.fix === 'follow-ip') patchFingerprint({ networkIdentityMode: 'proxy' })
    else if (item.fix === 'webrtc-replace') patchFingerprint({ webrtcPolicy: 'proxy_only' })
    else if (item.fix === 'reseed') reseedNoise()
    else if (item.fix === 'shuffle-gpu') shuffleGpu()
    else if (item.fix === 'use-real') {
      if (item.row === 'screen') chooseScreen('host')
      else if (item.row === 'gpu') chooseGpu('real')
      else if (item.row === 'canvas' || item.row === 'audio' || item.row === 'clientrects' || item.row === 'font') setSpoofing(item.row, false)
    }
  }

  const basic = (
    <div className="fb-editor-section">
      <Row label={t("窗口名称")} required>
        <Form.Item name="name" noStyle rules={[{ required: true, message: t("请输入环境名称") }]}>
          <Input placeholder={t("例如：TK-美区-01")} maxLength={60} />
        </Form.Item>
      </Row>
      <FieldError name="name" />
      <Row label={t("分组")}>
        <Form.Item name="group" noStyle>
          <AutoComplete
            allowClear
            options={groups.map((value) => ({ value }))}
            placeholder={t("选择已有分组，或输入新分组名称")}
            maxLength={40}
            filterOption={(input, option) => String(option?.value ?? '').toLocaleLowerCase().includes(input.toLocaleLowerCase())}
          />
        </Form.Item>
      </Row>
      <Row
        label={t("平台账号")}
        hint={accountPasswordStored && !accountPassword ? t("密码已加密保存；平台和账号不变时留空即保持原密码。") : t("账号密码只加密保存在本机，导出配置时不会带出密码。")}
      >
        <div className="fb-account-grid">
          <Form.Item name={['account', 'platform']} noStyle>
            <AutoComplete
              allowClear
              options={PLATFORMS.map((item) => ({ value: item.value }))}
              placeholder={t("平台")}
              maxLength={40}
              onChange={onPlatformChange}
            />
          </Form.Item>
          <Form.Item name={['account', 'username']} noStyle>
            <Input placeholder={t("账号")} autoComplete="off" maxLength={200} />
          </Form.Item>
          <Form.Item name={['account', 'password']} noStyle>
            <Input.Password placeholder={accountPasswordStored ? t("已保存，留空保持不变") : t("密码")} autoComplete="new-password" maxLength={500} />
          </Form.Item>
        </div>
      </Row>
      <Row label={t("启动页面")} hint={t("恢复此环境上次关闭时的标签页；首次使用时打开新标签页。指定网址每行一个，不填写协议时使用 HTTPS。")}>
        <div className="fb-stack">
          <Form.Item name="startupMode" noStyle>
            <Radio.Group options={[{ value: 'urls', label: t("打开指定页面") }, { value: 'restore', label: t("打开上次关闭的页面") }]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(before, after) => before.startupMode !== after.startupMode}>
            {() => <Form.Item name="startUrlsText" noStyle>
              <Input.TextArea disabled={form.getFieldValue('startupMode') === 'restore'} autoSize={{ minRows: 1, maxRows: 4 }} placeholder="https://seller-us.tiktok.com" />
            </Form.Item>}
          </Form.Item>
        </div>
      </Row>
      <Row
        label={t("Cookie")}
        hint={running
          ? t("窗口运行中，关闭后才能导入 Cookie")
          : cookiePreview.error
            ? <Typography.Text type="danger">{mt(cookiePreview.error)}</Typography.Text>
            : cookiePreview.count !== undefined
              ? t("识别到 {0} 条 Cookie，保存后导入此窗口", cookiePreview.count)
              : t("可选。已在别处登录的账号，把 Cookie 粘贴或导入到这里，保存后这个窗口直接是登录状态")}
      >
        <Form.Item name="cookieText" noStyle>
          <Input.TextArea
            disabled={running}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={t("支持 JSON（Cookie-Editor 等插件导出）、Netscape 文本（cookies.txt），或第一行写网址、第二行写 name=value; …")}
          />
        </Form.Item>
        <Upload
          accept=".json,.txt"
          showUploadList={false}
          disabled={running}
          beforeUpload={(file) => {
            void file.text().then((text) => form.setFieldValue('cookieText', text))
            return false
          }}
        >
          <Button size="small" disabled={running} className="fb-cookie-file">{t("从文件导入")}</Button>
        </Upload>
      </Row>
      <Row label={t("备注")}>
        <Form.Item name="note" noStyle>
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={500} placeholder={t("选填")} />
        </Form.Item>
      </Row>
      <Collapse
        ghost
        className="fb-more"
        items={[{
          key: 'more',
          label: t("更多设置：标签、颜色、扩展、窗口位置"),
          forceRender: true,
          children: (
            <>
              <Row label={t("标签")}>
                <Form.Item name="tags" noStyle>
                  <Select mode="tags" maxCount={20} tokenSeparators={[',']} placeholder={t("输入后回车")} />
                </Form.Item>
              </Row>
              <Row label={t("标记颜色")}>
                <Form.Item name="color" noStyle>
                  <ColorPicker showText />
                </Form.Item>
              </Row>
              <Row label={t("启动扩展")} hint={extensions.length ? undefined : t("尚未导入扩展")}>
                <Form.Item name="extensionIds" noStyle>
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder={t("选择该环境启动时加载的扩展")}
                    options={extensions.map((extension) => ({ value: extension.id, label: `${extension.name} · ${extension.version}` }))}
                  />
                </Form.Item>
              </Row>
              <Row label={t("浏览器窗口")} hint={windowMode === 'auto' ? t("和新装的 Chrome 一样打开默认大小的窗口，之后记住你拖动后的大小") : undefined}>
                <Form.Item name={['window', 'mode']} noStyle>
                  <Radio.Group size="small" optionType="button" options={[{ value: 'auto', label: t("自动尺寸与位置") }, { value: 'custom', label: t("固定尺寸与位置") }]} />
                </Form.Item>
              </Row>
              {windowMode === 'custom' && (
                <Row label={t("窗口尺寸")} hint={t("多显示器允许负坐标；显示器布局变化后，过期坐标可能让窗口出现在屏幕之外。")}>
                  <Space wrap>
                    <Form.Item name={['window', 'width']} noStyle><InputNumber min={480} max={7680} precision={0} prefix="W" /></Form.Item>
                    <Form.Item name={['window', 'height']} noStyle><InputNumber min={360} max={4320} precision={0} prefix="H" /></Form.Item>
                    <Form.Item name={['window', 'x']} noStyle><InputNumber min={-20000} max={20000} precision={0} prefix="X" /></Form.Item>
                    <Form.Item name={['window', 'y']} noStyle><InputNumber min={-20000} max={20000} precision={0} prefix="Y" /></Form.Item>
                  </Space>
                </Row>
              )}
            </>
          )
        }]}
      />
    </div>
  )

  const proxy = (
    <div className="fb-editor-section">
      <Row
        label={t("代理方式")}
        hint={proxyMode === 'api'
          ? t("保存时存入代理库（代理库里已有同一个链接时直接用那一条）；每次打开窗口都从链接取一个新代理，自动识别 SOCKS5 或 HTTP")
          : proxyMode !== 'direct' && proxyMode !== 'library' ? t("填写的代理会自动存入代理库；代理库里已有相同的代理时直接使用那一条。") : undefined}
      >
        <Radio.Group
          optionType="button"
          value={proxyMode}
          onChange={(event) => chooseProxyMode(event.target.value as ProxyMode)}
          options={[
            { value: 'direct', label: t("直连") },
            { value: 'http', label: 'HTTP' },
            { value: 'https', label: 'HTTPS' },
            { value: 'socks5', label: 'SOCKS5' },
            { value: 'api', label: t("API 提取") },
            { value: 'library', label: t("从代理库选择") }
          ]}
        />
      </Row>
      {proxyMode === 'library' && (
        <>
          <Row
            label={t("选择代理")}
            required
            hint={proxies.length ? undefined : t("代理库还是空的，可以先用上面的 HTTP / SOCKS5 填写一个")}
          >
            <Form.Item name="proxyId" noStyle rules={[{ required: true, message: t("请选择一个代理") }]}>
              <Select
                showSearch
                className="fb-wide-select"
                placeholder={t("搜索地址或备注")}
                optionFilterProp="search"
                onChange={() => {
                  setProxyResult(null)
                  // Another proxy: start from its 网络加速 default.
                  form.setFieldValue('tunnel', undefined)
                }}
                options={proxies.map((item) => ({
                  value: item.id,
                  search: `${item.host}:${item.port} ${item.username} ${item.note} ${item.check?.ip ?? ''}`,
                  label: proxyLabel(item)
                }))}
              />
            </Form.Item>
          </Row>
          <FieldError name="proxyId" />
          {sharedWith > 0 && (
            <Alert
              type="warning"
              showIcon
              className="fb-editor-alert"
              title={t("这个代理已被另外 {0} 个窗口使用", sharedWith)}
              description={t("多个窗口共用同一个出口 IP，可能被平台判定为关联账号。")}
            />
          )}
        </>
      )}
      {proxyMode === 'api' && (
        <>
          <Row label={t("API 链接")} required hint={t("白名单模式要先在服务商后台把这台电脑的 IP 加进白名单；只接受境外 IP 的服务商，打开下面的网络加速，把加速节点的 IP 加进白名单。")}>
            <Form.Item name={['proxy', 'apiUrl']} noStyle rules={[{ required: true, message: t("请输入 API 链接") }, { pattern: /^\s*https?:\/\//i, message: t("API 链接要以 http:// 或 https:// 开头") }]}>
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="https://example.com/api?num=1&format=txt" />
            </Form.Item>
          </Row>
          <FieldError name={['proxy', 'apiUrl']} />
        </>
      )}
      {proxyMode !== 'library' && proxyMode !== 'api' && proxyProtocol !== 'direct' && (
        <>
          <Row label={t("代理地址")} required>
            <div className="fb-host-grid">
              <Form.Item name={['proxy', 'host']} noStyle rules={[{ required: true, message: t("请输入代理主机") }]}>
                <Input placeholder="proxy.example.com" />
              </Form.Item>
              <Form.Item name={['proxy', 'port']} noStyle rules={[{ required: true, message: t("请输入端口") }]}>
                <InputNumber min={1} max={65535} precision={0} placeholder={t("端口")} className="full-width" />
              </Form.Item>
            </div>
          </Row>
          <FieldError name={['proxy', 'host']} />
          <FieldError name={['proxy', 'port']} />
          <Row
            label={t("账号 / 密码")}
            hint={proxyPasswordStored && !proxyPassword ? t("已保存；代理地址和用户名未修改时，留空可保持原密码。") : undefined}
          >
            <div className="fb-host-grid even">
              <Form.Item name={['proxy', 'username']} noStyle>
                <Input placeholder={t("用户名")} autoComplete="off" />
              </Form.Item>
              <Space.Compact block>
                <Form.Item name={['proxy', 'password']} noStyle>
                  <Input.Password autoComplete="new-password" placeholder={proxyPasswordStored ? t("已保存，留空保持不变") : t("密码")} />
                </Form.Item>
                {proxyPasswordStored && !proxyPassword && (
                  <Button onClick={() => form.setFieldValue(['proxy', 'passwordStored'], false)}>{t("清除已保存")}</Button>
                )}
              </Space.Compact>
            </div>
          </Row>
        </>
      )}
      {proxyMode !== 'api' && <Row
        label={t("快速粘贴")}
        hint={pasteError
          ? <Typography.Text type="danger">{pasteError}</Typography.Text>
          : pasted && proxyMode !== 'library' && proxyMode !== 'direct'
            ? <Typography.Text type="success">{t("已识别：{0}", pastedProxySummary(pasted, proxyMode))}{pasted.protocol ? '' : ` · ${t("未写协议，按当前选择的类型")}`}</Typography.Text>
            : t("支持 host:port:user:pass、user:pass@host:port、socks5:// 链接，以及“地址：… 端口：… 用户名：… 密码：…”这类文字，粘贴后自动填入")}
      >
        <Input.TextArea
          className="fb-paste"
          autoSize={{ minRows: 1, maxRows: 5 }}
          value={pasteText}
          placeholder={PASTE_PLACEHOLDER}
          onChange={(event) => applyPastedProxy(event.target.value)}
        />
      </Row>}
      {proxyProtocol !== 'direct' && (
        <Row label={t("网络加速")}>
          <TunnelRouteField
            value={route}
            status={tunnelStatus}
            disabledReason={route === shownRoute ? undefined : t("HTTPS 代理暂不支持网络加速，可改用 HTTP 或 SOCKS5")}
            onChange={(next) => { form.setFieldValue('tunnel', next); setProxyResult(null) }}
          />
        </Row>
      )}
      <Row label="">
        <div className="fb-proxy-test">
          <Button loading={testingProxy} onClick={() => void testCurrentProxy()}>{t("检测代理")}</Button>
          {proxyResult?.ok && (
            <span className={`fb-proxy-result ${proxyResult.geoConfidence === 'conflict' ? 'warn' : 'ok'}`}>
              {t("连接正常")} · {proxyResult.ip} · {[proxyResult.country, proxyResult.city].filter(Boolean).join(' ')} · {t("延迟 {0} ms", proxyResult.latencyMs)}
              {proxyResult.udp !== undefined && ` · ${proxyResult.udp ? t("支持 UDP") : t("不支持 UDP")}`}
              {proxyResult.networkRisk && <Tag color="warning" className="fb-inline-tag">{riskLabels[proxyResult.networkRisk]}</Tag>}
            </span>
          )}
          {proxyResult && !proxyResult.ok && <span className="fb-proxy-result bad">{t("连接失败：{0}", mt(proxyResult.error))}{proxyMode !== 'library' ? ` · ${t("请确认代理类型（HTTP / SOCKS5）是否选对")}` : ''}</span>}
        </div>
      </Row>
      {proxyResult?.ok && proxyResult.geoConfidence === 'conflict' && (
        <Alert
          type="warning"
          showIcon
          className="fb-editor-alert"
          title={proxyResult.geoConflict?.includes('轮换代理') ? t("这个代理在轮换出口 IP") : t("代理地理信息存在冲突")}
          description={proxyResult.geoConflict?.includes('轮换代理')
            ? t("{0}。网站会看到 IP 在变，时区和语言也对不上；请在代理商后台改成固定会话（粘性 IP）。启动时会再次检测，并由你确认是否继续。", mt(proxyResult.geoConflict))
            : t("{0}。继续使用可能影响指纹一致性；启动时会再次检测，并由用户确认是否继续。", mt(proxyResult.geoConflict))}
        />
      )}
      {proxyResult?.degraded && proxyResult.geoConfidence !== 'conflict' && <Alert type="warning" showIcon className="fb-editor-alert" title={mt(proxyResult.warning)} />}
      {proxyResult?.ok && regionMismatch && (
        <Alert
          type="warning"
          showIcon
          className="fb-editor-alert"
          title={t("代理 IP 在{0}，窗口地区是{1}", regionName(regionMismatch.ip), regionName(regionMismatch.window))}
          description={t("已经创建的窗口不会自动改国家、时区和语言；要和 IP 一致就点右边的按钮，或换一个那个国家的代理。")}
          action={<Button size="small" onClick={() => fixToIp(lastCheck)}>{t("改成和 IP 一致")}</Button>}
        />
      )}
      <Row label={t("时区和语言")}>
        <span className="fb-muted">
          {followIp
            ? proxyProtocol === 'direct'
              ? t("基于 IP 生成；直连时没有代理 IP，先用指纹里的时区和语言")
              : t("基于 IP 生成：{0} · {1}", networkIdentity.language, networkIdentity.timezone)
            : t("按地区「{0}」：{1} · {2}", fp.region ? regionName(fp.region) : t("自定义"), fp.language, fp.timezone)}
        </span>
        <Button size="small" type="link" onClick={() => setTab('fingerprint')}>{t("在指纹里修改")}</Button>
      </Row>
      <Row label={t("出口变化时")} hint={t("代理出口 IP 与上次检测不同时的处理方式")}>
        <Radio.Group
          size="small"
          optionType="button"
          value={fp.proxyExitPolicy}
          onChange={(event) => patchFingerprint({ proxyExitPolicy: event.target.value })}
          options={[{ value: 'block', label: t("阻止启动并确认（推荐）") }, { value: 'warn', label: t("仅告警，继续启动") }]}
        />
      </Row>
    </div>
  )

  /** The language the window launches with, for "follow the language" labels. */
  const shownLanguage = effectiveNetworkIdentity(fp, profile?.proxyCheck, { allowGeoConflict: true }).language
  const mediaLabel = (set: string) => {
    const [microphones, speakers, cameras] = set.split(',').map(Number)
    // Patch 014 names a second audio output "Headphones", so two outputs read as speakers + headphones.
    if (speakers === 1) return t("{0} 麦克风 · 扬声器 · {1} 摄像头", microphones, cameras)
    if (speakers === 2) return t("{0} 麦克风 · 扬声器 + 耳机 · {1} 摄像头", microphones, cameras)
    return t("{0} 麦克风 · {1} 扬声器 · {2} 摄像头", microphones, speakers, cameras)
  }
  const shownScreen = effectiveScreen(fp, windowKernelVersion, hostScreen(), windowScreen)
  const screenValue = fp.screenSource === 'host' || (shownScreen.width !== fp.screenWidth || shownScreen.height !== fp.screenHeight)
    ? 'host'
    : screenCustom || !isChoice(fp.screenWidth, fp.screenHeight)
      ? 'custom'
      : `${fp.screenWidth}x${fp.screenHeight}`
  const coreOptions = [...new Set([...CORE_OPTIONS, fp.hardwareConcurrency])].sort((a, b) => a - b)
  const gpuValue = gpuReal ? 'real' : shownGpuKey ?? 'kernel'
  const gpuSelectOptions = [
    { value: 'real', label: t("本机真实") },
    ...(!gpuReal && !shownGpuKey ? [{ value: 'kernel', label: t("由内核按种子决定") }] : []),
    ...(gpuOptions.some((option) => !option.disabled)
      ? [{ label: t("当前内核可用"), options: gpuOptions.filter((option) => !option.disabled) }]
      : []),
    // Prism kernels take any card from their own desktop list; other kernels' cards (laptops,
    // seeded tables) are not offered there.
    ...(gpuOptions.some((option) => option.disabled) && !kernelTakesExplicitGpu(windowKernelVersion)
      ? [{ label: t("需要其他内核版本（换内核后可选）"), options: gpuOptions.filter((option) => option.disabled) }]
      : [])
  ]
  const cpuSelectOptions = [
    { value: 'none', label: t("不指定") },
    ...cpuFamilies().map(({ family, cpus }) => ({
      label: family,
      options: cpus.map((cpu) => ({ value: cpu.model, label: `${cpu.model} · ${t("{0} 核 {1} 线程", cpu.cores, cpu.threads)}` }))
    }))
  ]
  const languageOptions = [
    ...LANGUAGES.map((item) => ({ value: item.language, label: `${item.name} · ${item.language}`, voices: item.voices, devices: item.devices })),
    ...(fp.language && !LANGUAGES.some((item) => item.language === fp.language) ? [{ value: fp.language, label: fp.language, voices: false, devices: false }] : [])
  ]
  const autoUiLocale = chromeUiLocaleFor(shownLanguage)
  // prism7+ kernels (same release as the WebRTC relay) show the fonts of the interface language.
  const windowUiLocale = fp.uiLocale ?? autoUiLocale
  const fontScript = windowsFontScript(windowUiLocale)

  const fingerprint = (
    <div className="fb-editor-section">
      <div className="fb-fp-intro">
        <span>{t("每个窗口独立指纹，重启后保持不变。不确定的选项保持默认即可。")}</span>
        <Button onClick={randomizeAll}>{t("一键随机指纹")}</Button>
      </div>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("系统与浏览器")}</h3>
        </div>
      <Row label={t("浏览器内核")} hint={t("每个窗口可单独指定，在内核管理里导入更多版本")}>
        <Form.Item name="kernelVersion" noStyle>
          <Select
            className="fb-wide-select"
            options={[
              { value: '', label: engine?.version ? t("跟随默认内核（{0}）", kernelName(engine.version)) : t("跟随默认内核") },
              ...kernels.map((kernel) => ({ value: kernel.version, label: `${kernelName(kernel.version)}${kernel.origin === 'local-build' ? ' · ' + t('本地构建') : ''}` })),
              ...(kernelVersion && !pinnedKernel ? [{ value: kernelVersion, label: t("{0} · 当前未安装", kernelName(kernelVersion)) }] : [])
            ]}
          />
        </Form.Item>
      </Row>
      {kernelVersion && !pinnedKernel && (
        <Alert type="error" showIcon className="fb-editor-alert" title={t("固定内核 {0} 当前不可用", kernelName(kernelVersion))} description={t("安装该版本后才能启动此环境，或者改回自动跟随。")} />
      )}
      <Row label={t("浏览器品牌")}>
        <Select
          className="fb-fp-select"
          value={fp.brand}
          onChange={(brand) => patchFingerprint({ brand })}
          options={[{ value: 'Chrome', label: 'Chrome' }, { value: 'Edge', label: 'Edge' }]}
        />
      </Row>
      <Row label={t("操作系统")} check={checkFor('system', 'platformVersion')}>
        <Space wrap size={8}>
          <Select
            className="fb-fp-select-half"
            value={fp.platform}
            onChange={choosePlatform}
            options={[{ value: 'windows', label: 'Windows' }, { value: 'macos', label: 'macOS' }]}
            aria-label={t("操作系统")}
          />
          <Select
            className="fb-fp-select-half"
            value={fp.platformVersion}
            onChange={choosePlatformVersion}
            options={fp.platform === 'windows'
              ? [...WINDOWS_VERSIONS, ...(WINDOWS_VERSIONS.some((item) => item.value === fp.platformVersion) ? [] : [{ value: fp.platformVersion, label: windowsVersionLabel(fp.platformVersion) }])]
              : MACOS_VERSIONS}
            aria-label={t("系统版本")}
          />
        </Space>
      </Row>
      <Row label="User-Agent" hint={t("与内核版本和系统自动匹配")}>
        <div className="fb-ua">
          <span title={userAgentPreview(fp.platform, fp.brand, selectedEngine?.version)}>{userAgentPreview(fp.platform, fp.brand, selectedEngine?.version)}</span>
        </div>
      </Row>
      {versionWarning && <Alert type="warning" showIcon className="fb-editor-alert" title={mt(versionWarning)} description={t("建议留空并自动匹配当前内核。")} />}
      </section>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("国家与语言")}</h3>
          <span className="fb-fp-card-sub">{t("以下随国家/地区自动配套，也可以单独修改")}</span>
        </div>
      <Row label={t("国家/地区")} hint={followIp ? t("按代理 IP 所在国家，自动配好下面三项") : t("这台电脑在哪个国家；选了它，下面三项自动配好，也能单独改")}>
        <Select
          showSearch
          optionFilterProp="label"
          className="fb-fp-select fb-fp-select-wide"
          value={followIp ? 'ip' : fp.region ?? 'custom'}
          onChange={chooseRegion}
          options={[
            { value: 'ip', label: t("基于 IP 生成") },
            ...(!followIp && !fp.region ? [{ value: 'custom', label: t("自定义") }] : []),
            ...regions.map((item) => ({ value: item.code, label: `${item.name} · ${ownLanguageName(item.locale.uiLocale)} · ${item.zone}` }))
          ]}
          aria-label={t("国家/地区")}
        />
      </Row>
      {regionMismatch && (
        <Alert
          type="warning"
          showIcon
          className="fb-editor-alert"
          title={t("代理 IP 在{0}，窗口地区是{1}", regionName(regionMismatch.ip), regionName(regionMismatch.window))}
          description={t("时区、语言和 IP 所在国家不一致，网站可能发现。可以点右边的按钮改成和 IP 一致（改完固定，不会随 IP 再变），或换一个那个国家的代理。")}
          action={<Button size="small" onClick={() => fixToIp(lastCheck)}>{t("改成和 IP 一致")}</Button>}
        />
      )}
      <Row label={t("时区")} check={checkFor('timezone')} hint={t("这台 Windows 的系统时区，网页里的时间按它显示")}>
        {followIp
          ? <Fixed>{t("基于 IP · {0}", fp.platform === 'windows' ? windowsZoneLabel(networkIdentity.timezone, getLocale()) : networkIdentity.timezone)}</Fixed>
          : (
            <Form.Item name={['fingerprint', 'timezone']} noStyle>
              <Select showSearch optionFilterProp="label" className="fb-fp-select fb-fp-select-wide" options={timezoneOptions} aria-label={t("时区")} />
            </Form.Item>
          )}
      </Row>
      <Row label={t("系统语言")} hint={t("这台 Windows 的显示语言，Chrome 菜单也是它；字体、语音、设备名都跟着它")}>
        <Select
          showSearch
          optionFilterProp="label"
          className="fb-fp-select fb-fp-select-wide"
          value={fp.uiLocale ?? 'auto'}
          onChange={(value: string) => patchFingerprint({ uiLocale: value === 'auto' ? undefined : value })}
          options={[
            { value: 'auto', label: t("跟随浏览器语言 · {0}", `${ownLanguageName(autoUiLocale)} · ${autoUiLocale}`) },
            ...CHROME_UI_LOCALES.map((locale) => ({ value: locale, label: `${ownLanguageName(locale)} · ${locale}` }))
          ]}
          aria-label={t("系统语言")}
        />
      </Row>
      <Row label={t("浏览器语言")} check={checkFor('language')} hint={`${t("Chrome 的首选语言，网站读到的就是它")} · Accept-Language: ${acceptLanguageHeader(chromeAcceptLanguages(networkIdentity.language, networkIdentity.acceptLanguages))}`}>
        {followIp
          ? <Fixed>{t("基于 IP · {0}", networkIdentity.language)}</Fixed>
          : (
            <Select
              showSearch
              optionFilterProp="label"
              className="fb-fp-select fb-fp-select-wide"
              value={fp.language}
              onChange={(language: string) => {
                const item = LANGUAGES.find((entry) => entry.language === language)
                if (item) patchFingerprint({ language: item.language, acceptLanguages: item.acceptLanguages })
              }}
              options={languageOptions}
              optionRender={(option) => (
                <span className="fb-language-option">
                  <span>{option.label}</span>
                  {option.data.voices && <Tag bordered={false} color="blue">{t("微软语音")}</Tag>}
                  {option.data.devices && <Tag bordered={false} color="green">{t("设备名")}</Tag>}
                </span>
              )}
              aria-label={t("浏览器语言")}
            />
          )}
      </Row>
      <Row label={t("地理位置")} hint={followIp ? t("基于 IP 生成经纬度") : undefined}>
        <Select
          className="fb-fp-select fb-fp-select-wide"
          value={fp.geolocationPermission ?? 'ask'}
          onChange={(geolocationPermission) => patchFingerprint({ geolocationPermission })}
          options={[{ value: 'ask', label: t("询问") }, { value: 'allow', label: t("允许") }, { value: 'block', label: t("禁止") }]}
        />
      </Row>
      {webrtcRelay ? (
        <Row
          label={t("字体")}
          check={checkFor('font')}
          hint={fp.fontSource === 'host'
            ? t("网页看到这台电脑装的所有字体，包括你另装的；所有用本机字体的窗口都一样")
            : t("Windows 自带字体，加上系统语言对应的语言字体包；本机另装的字体不显示")}
        >
          <Select
            className="fb-fp-select fb-fp-select-wide"
            value={fp.fontSource ?? 'language'}
            onChange={(fontSource) => patchFingerprint({ fontSource: fontSource === 'host' ? 'host' : undefined })}
            options={[
              { value: 'language', label: t("跟随系统语言 · {0}", `${ownLanguageName(windowUiLocale)} · ${windowUiLocale}`) },
              { value: 'host', label: t("本机真实字体") }
            ]}
          />
          {fp.fontSource !== 'host' && fontScript && fontPacks?.supported && (
            // Whether this computer has the package the window's language needs: red until it is
            // downloaded, since the window would lack fonts every Windows in that language has.
            <div className="fb-check-results">
              {fontPacks.missing.includes(fontScript) ? (
                <>
                  <div className="fb-check-item is-bad">
                    <span className="fb-check-dot" />
                    <span className="fb-check-message">
                      {t("这台电脑缺少{0}字体包：窗口里没有这些字体，和真实的该语言 Windows 不一致。请下载，从微软官方下载，不需要管理员权限。", fontPackLabel(fontScript, getLocale()))}
                    </span>
                  </div>
                  <FontPackDownload scripts={[fontScript]} onInstalled={setFontPacks} />
                </>
              ) : (
                <div className="fb-check-item is-ok">
                  <span className="fb-check-dot" />
                  <span className="fb-check-message">{t("已安装{0}字体包", fontPackLabel(fontScript, getLocale()))}</span>
                </div>
              )}
            </div>
          )}
        </Row>
      ) : (
        <Row label={t("字体")} check={checkFor('font')}>{noiseControl('font', t("字体"))}</Row>
      )}

      <Row label={t("随系统语言")}>
        <span className="fb-muted">
          {t("语音：{0}", WINDOWS_VOICE_LOCALES.find((item) => item.locale === voiceLocaleForLanguage(windowUiLocale))?.voices.join(', ') ?? '—')}
          {' · '}
          {t("媒体设备名：{0}", ownLanguageName(windowUiLocale))}
        </span>
      </Row>
      </section>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("硬件")}</h3>
          <span className="fb-fp-card-sub">{t("以下随显卡自动配套，也可以单独修改")}</span>
        </div>
      <Row
        label={t("显卡")}
        check={checkFor('gpu')}
        hint={gpuReal
          ? t("使用这台电脑的真实显卡（WebGL、WebGPU 一起）")
          : [gpu?.renderer, windowKernelVersion && (kernelGpus ? t("内核 {0} 的显卡清单", windowKernelVersion) : t("内核 {0} 还没有显卡清单", windowKernelVersion))].filter(Boolean).join(' · ')}
      >
        <ValueChoice
          wide
          label={t("显卡")}
          value={gpuValue}
          onChange={chooseGpu}
          onShuffle={shuffleGpu}
          shuffleDisabled={!kernelGpus?.length}
          options={gpuSelectOptions}
        />
      </Row>
      {gpuMissing && (
        <Alert type="warning" showIcon className="fb-editor-alert" title={t("内核 {0} 里没有这块显卡，打开窗口前请重新选择", windowKernelVersion ?? '')} />
      )}
      <Row label={t("CPU 型号")} hint={t("网页读不到 CPU 型号；选定后硬件并发数自动等于它的线程数，保证是一台真实存在的电脑")}>
        <ValueChoice
          wide
          label={t("CPU 型号")}
          value={fp.coresSource === 'host' ? 'none' : fp.cpu ?? 'none'}
          onChange={(value: string) => chooseCpu(value)}
          onShuffle={() => chooseCpu(randomCpu().model)}
          options={cpuSelectOptions}
        />
      </Row>
      <Row label={t("硬件并发数")} check={checkFor('cores')}>
        <ValueChoice
          label={t("硬件并发数")}
          value={fp.coresSource === 'host' ? 'host' : fp.hardwareConcurrency}
          onChange={chooseCores}
          onShuffle={() => chooseCores(pickOther(COMMON_CORES, fp.hardwareConcurrency))}
          options={[{ value: 'host', label: t("本机真实") }, ...coreOptions.map((value) => ({ value, label: t("{0} 核", value) }))]}
        />
      </Row>
      <Row label={t("设备内存")} check={checkFor('memory')} hint={t("网站读到的内存由内核决定：内核 147 及以上可选 16、32 GB，旧内核最多 8 GB")}>
        <ValueChoice
          label={t("设备内存")}
          value={fp.deviceMemory ?? 8}
          onChange={(value: DeviceMemoryGb) => patchFingerprint({ deviceMemory: value })}
          onShuffle={() => patchFingerprint({ deviceMemory: pickOther(DEVICE_MEMORY_CHOICES, fp.deviceMemory ?? 8) })}
          options={DEVICE_MEMORY_CHOICES.map((value) => ({ value, label: `${value} GB` }))}
        />
      </Row>
      {kernelSpoofsScreen(windowKernelVersion) ? (
        <Row label={t("分辨率")} check={checkFor('screen')} hint={windowScreen
          ? t("浏览器窗口会被限制在所选分辨率以内，比这台电脑屏幕（{0} × {1}）小也可以", hostScreen().width, hostScreen().height)
          : t("当前内核只能选不小于这台电脑屏幕（{0} × {1}）的分辨率；要选 1920 × 1080 等更小的，请换 prism5 及以上内核，或在内核管理里重新导入本地内核", hostScreen().width, hostScreen().height)}>
          <Space wrap size={8}>
            <ValueChoice
              label={t("分辨率")}
              wide
              value={screenValue}
              onChange={chooseScreen}
              onShuffle={shuffleScreen}
              options={[
                { value: 'host', label: t("本机真实") },
                ...screenChoices(floor, hostScale()).map(({ width, height, physical }) => ({
                  value: `${width}x${height}`,
                  label: screenLabel(width, height, physical)
                })),
                { value: 'custom', label: screenValue === 'custom' && !screenCustom ? `${fp.screenWidth} × ${fp.screenHeight}` : t("自定义") }
              ]}
            />
            {screenValue === 'custom' && screenCustom && (
              <>
                <Form.Item name={['fingerprint', 'screenWidth']} noStyle><InputNumber min={floor?.width ?? 800} max={7680} precision={0} prefix="W" aria-label={t("屏幕宽度")} /></Form.Item>
                <Form.Item name={['fingerprint', 'screenHeight']} noStyle><InputNumber min={floor?.height ?? 600} max={4320} precision={0} prefix="H" aria-label={t("屏幕高度")} /></Form.Item>
              </>
            )}
          </Space>
        </Row>
      ) : (
        <Row label={t("分辨率")} check={checkFor('screen')} hint={t("这个内核不支持修改分辨率，网站读到的是这台电脑的屏幕尺寸")}>
          <Fixed>{t("本机真实 · {0} × {1}", window.screen.width, window.screen.height)}</Fixed>
        </Row>
      )}
      <Row label={t("媒体设备")} hint={t("网站未授权时只能看到有哪几种设备；授权后看到的设备名按系统语言的 Windows 名称生成")}>
        <Select
          className="fb-fp-select"
          value={fp.mediaDevices ?? 'auto'}
          onChange={(value: string) => patchFingerprint({ mediaDevices: value === 'auto' ? undefined : value })}
          options={[
            { value: 'auto', label: t("自动 · {0}", mediaLabel(autoMediaDevices(fp.seed >>> 0, gpu?.model))) },
            ...MEDIA_PRESETS.map((value) => ({ value, label: mediaLabel(value) })),
            { value: 'real', label: t("本机真实") }
          ]}
        />
      </Row>
      </section>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("网络")}</h3>
        </div>
      <Row
        label="WebRTC"
        check={checkFor('webrtc')}
        hint={fp.webrtcPolicy === 'proxy_only'
          ? webrtcRelay
            ? proxyResult?.udp === true
              ? t("这个代理支持 UDP：WebRTC 走代理，网站看到代理 IP，视频通话可用")
              : proxyResult?.udp === false
                ? t("这个代理不支持 UDP：WebRTC 只报代理 IP、不发 UDP，视频通话不可用")
                : t("代理支持 UDP 时 WebRTC 真的走代理（网站看到代理 IP，视频通话可用）；不支持时只报代理 IP")
            : t("替换为代理 IP，防止泄露本机 IP")
          : fp.webrtcPolicy === 'privacy'
            ? t("开启 WebRTC，但网站拿不到任何 IP")
            : fp.webrtcPolicy === 'disabled'
              ? webrtcRelay
                ? t("完全关闭 WebRTC；真实 Chrome 不会没有 WebRTC，网站可能视为异常")
                : t("这个内核不能关闭 WebRTC，按「隐私」处理")
              : t("原版 Chrome 行为，不经过代理，会暴露本机真实 IP")}
      >
        <Select
          className="fb-fp-select"
          value={fp.webrtcPolicy}
          onChange={(webrtcPolicy) => patchFingerprint({ webrtcPolicy })}
          options={[
            { value: 'proxy_only', label: t("替换") },
            { value: 'privacy', label: t("隐私") },
            { value: 'default', label: t("允许") },
            { value: 'disabled', label: t("禁止") }
          ]}
        />
      </Row>
      </section>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("指纹值")}</h3>
          <span className="fb-fp-card-sub">{t("每个窗口不同，同一个窗口每次读取都相同")}</span>
        </div>
      <Row label="Canvas" check={checkFor('canvas')} hint={webrtcRelay ? t("每个窗口一个种子，换一换会换成另一组 Canvas 值") : t("字体和 Canvas 共用一个种子，换一换会一起换")}>
        {noiseControl('canvas', 'Canvas')}
        {webrtcRelay && measuredLine('canvas')}
      </Row>
      <Row label="AudioContext" check={checkFor('audio')} hint={webrtcRelay ? t("每个窗口微调极少数音频采样，同一窗口每次相同") : t("这个内核只能用本机真实值")}>
        {webrtcRelay ? seededControl('audio', 'AudioContext') : realSurface('audio')}
        {webrtcRelay && measuredLine('audio')}
      </Row>
      <Row label="ClientRects" check={checkFor('clientrects')} hint={webrtcRelay ? t("每个窗口整体偏移几个 1/64 像素，数值仍是真实浏览器的格式") : t("这个内核只能用本机真实值")}>
        {webrtcRelay ? seededControl('clientrects', 'ClientRects') : realSurface('clientrects')}
        {webrtcRelay && measuredLine('clientrects')}
      </Row>
      </section>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("其他")}</h3>
        </div>
      <Row label={t("设备名称")} hint={t("网页读取不到，仅用于显示和区分窗口")}>
        <TextWithShuffle
          label={t("设备名称")}
          value={shownDeviceName}
          onChange={(value) => patchFingerprint({ deviceName: value })}
          onShuffle={() => patchFingerprint({ deviceName: deviceName(randomSeed(), fp.platform) })}
        />
      </Row>
      <Row
        label={t("MAC 地址")}
        hint={shownMacVendor
          ? t("{0} 网卡 · 网页读取不到，仅用于显示和区分窗口", shownMacVendor)
          : t("网页读取不到，仅用于显示和区分窗口")}
      >
        <TextWithShuffle
          label={t("MAC 地址")}
          value={shownMacAddress}
          onChange={(value) => patchFingerprint({ macAddress: value })}
          onShuffle={() => patchFingerprint({ macAddress: macAddress(randomSeed(), fp.platform, shownGpuModel) })}
        />
      </Row>
      <Row label="Do Not Track">
        <Select
          className="fb-fp-select"
          value={fp.doNotTrack ?? 'default'}
          onChange={(doNotTrack) => patchFingerprint({ doNotTrack })}
          options={[{ value: 'default', label: t("默认") }, { value: 'on', label: t("开启") }, { value: 'off', label: t("关闭") }]}
        />
      </Row>
      <Row label={t("端口扫描保护")}>
        <Switch checked={fp.portScanProtection !== false} onChange={(on) => patchFingerprint({ portScanProtection: on ? undefined : false })} aria-label={t("端口扫描保护")} />
      </Row>
      </section>

      <h3 className="fb-fp-group">{t("指纹检测")}</h3>
      <div className="fb-check-panel">
        <div className="fb-check-head">
          <span className="fb-check-summary">
            {checking
              ? t("正在用这些设置启动一个临时浏览器检测，大约需要 10–30 秒…")
              : checkReport
                ? [
                    t("{0} 项正常", checkReport.items.filter((item) => item.status === 'ok').length),
                    t("{0} 项有风险", checkReport.items.filter((item) => item.status === 'warn').length),
                    t("{0} 项需修正", checkReport.items.filter((item) => item.status === 'bad').length),
                    relativeTime(checkReport.checkedAt, getLocale())
                  ].join(' · ')
                : t("用这些设置启动一个临时浏览器，检查网站实际看到的指纹；不会动这个窗口的 Cookie 和登录数据")}
          </span>
          <Button type="primary" loading={checking} onClick={() => void runCheck()}>{checkReport ? t("重新检测") : t("检测指纹")}</Button>
        </div>
        {checkStale && !checking && <div className="fb-check-stale">{t("设置已修改，结果可能已过时，请重新检测")}</div>}
        {checkError && <Alert type="error" showIcon title={checkError} />}
        {checkReport && <CheckResults items={checkReport.items.filter((item) => item.row === 'general')} stale={checkStale} onFix={applyFix} />}
        {checkReport && !checkStale && (
          <div className="fb-check-values">
            {[
              ['Canvas', checkReport.observed.canvas[0]],
              ['AudioContext', checkReport.observed.audio[0]],
              ['ClientRects', checkReport.observed.clientrects[0]],
              [t("字体"), checkReport.observed.font[0]],
              [t("出口 IP"), checkReport.exitIp ?? t("直连")]
            ].map(([name, value]) => <span key={name}>{name}<b className="fb-mono">{value}</b></span>)}
          </div>
        )}
        <DeepCheck draft={currentDraft} profileId={profile?.id} settingsKey={currentSettingsKey} />
      </div>
    </div>
  )

  return (
    <Drawer
      open={open}
      width={720}
      placement="right"
      destroyOnHidden
      className="fb-editor"
      onClose={onCancel}
      title={(
        <span className="fb-editor-title">
          {profile ? t("编辑窗口") : t("新建窗口")}
          {profile && <Tag>{t("序号 #{0}", profile.serialNumber)}</Tag>}
        </span>
      )}
      footer={(
        <div className="fb-editor-footer">
          <Button onClick={onCancel}>{t("取消")}</Button>
          <Button type="primary" loading={saving} onClick={() => void submit()}>{profile ? t("保存修改") : t("确定创建")}</Button>
        </div>
      )}
    >
      <Form
        form={form}
        requiredMark={false}
        onValuesChange={(changed) => { if ('proxy' in changed) setProxyResult(null) }}
      >
        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key as EditorTab)}
          items={[
            { key: 'basic', label: t("基础设置"), children: basic, forceRender: true },
            { key: 'proxy', label: t("代理设置"), children: proxy, forceRender: true },
            { key: 'fingerprint', label: t("指纹设置"), children: fingerprint, forceRender: true }
          ]}
        />
      </Form>
    </Drawer>
  )
}
