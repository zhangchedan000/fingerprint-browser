import { getLocale, t, translateMessage as mt } from '../../../../shared/i18n'
import { fontPackLabel, windowsFontScript, type FontPackStatus } from '../../../../shared/windows-font-packs'
import { FontPackDownload } from '../../components/FontPackDownload'
import { cssScreenSize, effectiveScreen, kernelSpoofsScreen, randomScreen, scaledScreen, screenChoices, screenFloor, screenKind } from '../../../../shared/screen'
import { humanError, regionName, relativeTime } from '../../components/format'
import { forgetScroll, useScrollMemory } from '../../components/scroll-memory'
import { fittingCountryZone, ipZoneFix, ipZoneMismatch, languageFitsCountry, usualScreenFor } from '../../../../shared/quick-fix'
import {
  Alert,
  AutoComplete,
  Button,
  Collapse,
  ColorPicker,
  ConfigProvider,
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
  Tooltip,
  Typography,
  Upload
} from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultProfileDraft, randomSeed } from '../../../../shared/defaults'
import { fingerprintVersionWarning } from '../../../../shared/fingerprint-consistency'
import {
  applyHardwareProfile,
  defaultHardwareProfileId,
  editableFingerprint,
  effectiveGpu,
  gpuChoices,
  otherWindowsFonts
} from '../../../../shared/hardware-profiles'
import { deviceName, formatMac, isRandomMac, macAddress, macVendor, type NoiseSurface } from '../../../../shared/device-identity'
import { gpuKey, gpuLabel, kernelGpuList } from '../../../../shared/gpu-catalog'
import { CPU_MODELS, cpuFamilies, findCpu } from '../../../../shared/cpu-catalog'
import { kernelChromiumVersion } from '../../../../shared/kernel-id'
import { kernelTakesExplicitGpu, maxDeviceMemoryGb } from '../../../../shared/kernel-capabilities'
import { matchedHardware, matchedScreen, screenSuitsGpu } from '../../../../shared/hardware-match'
import { voiceLocaleForLanguage, WINDOWS_VOICE_LOCALES } from '../../../../shared/windows-voices'
import { KEYBOARD_LAYOUTS, keyboardLayoutFor, keyboardLayoutLocale, keyboardLayoutName } from '../../../../shared/keyboard-layouts'
import { autoMediaDevices, MEDIA_LOCALES, MEDIA_PRESETS, MEDIA_SETUPS, mediaLocaleFor, type MediaSetup } from '../../../../shared/media-devices'
import { CHROME_UI_LOCALES, chromeLanguageProfile, chromeUiLocaleFor } from '../../../../shared/chrome-languages'
import { checkedSettingsKey, checkProxyKey, noiseStillMatches } from '../../../../shared/fingerprint-check-key'
import { acceptLanguageHeader, chromeAcceptLanguages, effectiveNetworkIdentity, followingLocales, fixedIdentityForCheck, localeForCountry, savedFingerprint } from '../../../../shared/network-identity'
import { allWindowsZones, countryWindowsZones, defaultCountryZone, windowsCountries, windowsZoneLabel } from '../../../../shared/windows-time-zones'
import { PASTE_PLACEHOLDER, parsePastedProxy, pastedProxySummary, type PastedProxy } from '../../../../shared/proxy-paste'
import { parseCookieFile } from '../../../../main/cookie-file'
import { PLATFORM_URLS, PLATFORMS } from '../../../../shared/platforms'
import type {
  ApiCheckRecord,
  BrowserExtension,
  BrowserPlatform,
  BrowserProfileView,
  EngineStatus,
  FingerprintCheckItem,
  FingerprintCheckReport,
  FingerprintCheckRow,
  FingerprintConfig,
  ForgetProxyCheck,
  KernelRelease,
  PlatformAccount,
  ProfileDraft,
  ProxyRecordView,
  ProxyConfig,
  ProxyTestResult,
  ServerPlace,
  TunnelRoute
} from '../../../../shared/types'
import { DEVICE_MEMORY_CHOICES, SMALL_DEVICE_MEMORY, type DeviceMemoryGb } from '../../../../shared/types'
import { proxyLabel } from '../../components/proxy'
import { defaultTunnelRoute, TunnelRouteField, useTunnelStatus } from '../../components/TunnelRouteField'
import { ExitIpCard } from '../../components/ExitIpCard'
import { useIpScore } from '../../components/useIpScore'
import { DeepCheck } from './DeepCheck'
import { IpCheckSites } from './IpCheckSites'
import { useWindowLauncher } from '../../data/window-actions'
import { useWorkspace } from '../../data/workspace'
import type { IpSiteRecord } from '../../../../shared/ip-sites'
import { kernelName } from '../../../../shared/kernel-id'

type SpoofSurface = FingerprintConfig['disabledSpoofing'][number]
type EditorTab = 'basic' | 'proxy' | 'fingerprint'

/** The tab each window's editor was left on (this run of the app); a new window starts on 基础设置. */
const lastTabs = new Map<string, EditorTab>()
const editorBody = () => document.querySelector<HTMLElement>('.fb-editor .ant-drawer-body')
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
  /** The box held the window's own cookies and they were edited: the window keeps exactly cookieText. */
  cookieReplace?: boolean
  /** API 提取, exit IP left unticked on a saved window: that proxy and its records are dropped. */
  apiDiscard?: boolean
  /** A new window's IP 评分, read before it was saved. */
  ipSites?: IpSiteRecord
  /** A typed or library proxy's exit IP left unticked: nothing of that check is kept. */
  forgetCheck?: ForgetProxyCheck
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
  /** The window is open right now (it may open or close while being edited). */
  running?: boolean
}

/**
 * A tab whose settings the open browser was started with: shown, not changeable until the window
 * is closed. Checking stays possible (Unlocked).
 */
function Locked({ locked, children }: { locked: boolean; children: ReactNode }) {
  if (!locked) return <>{children}</>
  return (
    <>
      <Alert
        type="info"
        showIcon
        className="fb-locked-note"
        title={t("窗口运行中：这里是窗口打开时用的设置，关闭窗口后才能修改；名称、分组、备注等在「基础设置」里可以直接改并保存")}
      />
      <ConfigProvider componentDisabled>{children}</ConfigProvider>
    </>
  )
}

/** Usable inside a Locked tab (checks that change nothing). */
const Unlocked = ({ children }: { children: ReactNode }) => <ConfigProvider componentDisabled={false}>{children}</ConfigProvider>

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
  const label = scale === 1
    ? `${width} × ${height} · ${note}`
    : t("{0} × {1} · {2} {3} 显示器 · 缩放 {4}%", width, height, `${physical.width}×${physical.height}`, note, Math.round(scale * 100))
  // 4K at Windows' default 150% (shared/screen scaledScreen).
  const scaled = scaledScreen({ width, height })
  return scaled.scale ? `${label} · ${t("缩放 {0}%", Math.round(scaled.scale * 100))}` : label
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

/**
 * What the editor starts from. A saved window shows the values it keeps (one that still followed
 * its IP: those of its last check), with the languages that equal what they follow shown as 跟随….
 */
function openedValues(profile: BrowserProfileView | undefined, suggestedIndex: number): EditorValues {
  const values = editorValues(profile, suggestedIndex)
  if (profile) {
    const gpuModel = effectiveGpu(values.fingerprint, profile.kernelVersion)?.model
    values.fingerprint = followingLocales(savedFingerprint(values.fingerprint, profile.proxyCheck, { gpuModel }), gpuModel)
  }
  return values
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
/**
 * One editor row. `fix`: the one-click change for what does not fit in this row, shown inside the
 * choice's box at its right end (the same place in every row); the reason is the line under it.
 */
function Row({ label, children, hint, required, check, fix }: { label: ReactNode; children: ReactNode; hint?: ReactNode; required?: boolean; check?: ReactNode; fix?: QuickFix }) {
  return (
    <div className={`fb-form-row${fix ? ' has-fix' : ''}`}>
      <span className="fb-form-label">{label}{required && <em>*</em>}</span>
      <div className="fb-form-control">
        {children}
        {fix && (
          <Unlocked>
            <Button size="small" className="fb-inbox-fix" icon={<ThunderboltOutlined />} title={fix.label} onClick={fix.apply}>{t("一键修正")}</Button>
          </Unlocked>
        )}
        {hint && <span className="fb-form-hint">{hint}</span>}
        {check}
      </div>
    </div>
  )
}

/** Fingerprint check results for one row: green / yellow / red, each with an optional one-click fix. */
/** A one-click change that fixes a mismatch: what the button says and what it does. */
interface QuickFix {
  label: string
  apply: () => void
}

function CheckResults({ items, stale, fixOf, buttons, note }: { items: FingerprintCheckItem[]; stale: boolean; fixOf: (item: FingerprintCheckItem, stale: boolean) => QuickFix | undefined; buttons?: boolean; note?: string }) {
  if (!items.length) return null
  return (
    <div className={`fb-check-results${stale ? ' is-stale' : ''}`}>
      {note && <div className="fb-check-stale">{note}</div>}
      {items.map((item, index) => {
        const fix = item.status === 'ok' ? undefined : fixOf(item, stale)
        return (
          <div key={index} className={`fb-check-item is-${item.status}`}>
            <span className="fb-check-dot" />
            <span className="fb-check-message">{mt(item.message)}</span>
            {/* Under a row its 一键修正 is in the box; results that belong to no row keep their own button. */}
            {fix && (buttons ? <Button type="link" size="small" onClick={fix.apply}>{fix.label}</Button> : <span className="fb-check-fix">· {fix.label}</span>)}
          </div>
        )
      })}
    </div>
  )
}

/** A yellow note under a row that does not fit the rest, naming the change its 一键修正 makes. */
function RowWarning({ children, fix }: { children: ReactNode; fix?: QuickFix }) {
  return (
    <span className="fb-row-warning">
      {children}
      {fix && <span className="fb-row-fix"> · {fix.label}</span>}
    </span>
  )
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
  /** `short`: what the box shows once the option is chosen (the list shows `label`). */
  options: Array<ChoiceOption | { label: string; options: ChoiceOption[] }>
  onChange: (value: never) => void
  onShuffle?: () => void
  shuffleDisabled?: boolean
  label: string
  wide?: boolean
}) {
  return (
    <Space size={8} className="fb-value-choice">
      <Select<string | number>
        className="fb-fp-select"
        showSearch={wide ? { optionFilterProp: 'label' } : undefined}
        value={value}
        onChange={onChange as (value: string | number) => void}
        options={options}
        aria-label={label}
        popupMatchSelectWidth={wide ? false : undefined}
        labelRender={({ value: chosen, label: full }) => options
          .flatMap((option) => 'options' in option ? option.options : [option])
          .find((option) => option.value === chosen)?.short ?? full}
      />
      {onShuffle && (
        <Button type="link" size="small" disabled={shuffleDisabled} onClick={onShuffle} aria-label={t("换一换")}>{t("换一换")}</Button>
      )}
    </Space>
  )
}

type ChoiceOption = { value: string | number; label: string; short?: string; disabled?: boolean }

/** What each 指纹值 row is, in the line under it. */
function surfaceMeaning(surface: NoiseSurface): string {
  switch (surface) {
    case 'canvas': return t("画布指纹，网站能读取到")
    case 'audio': return t("音频指纹，网站能读取到")
    case 'clientrects': return t("元素尺寸指纹，网站能读取到")
    default: return t("字体指纹，网站能读取到")
  }
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
const MEDIA_KIND_LABELS: Record<MediaSetup['kind'], string> = {
  speakers: '只接音箱',
  headset: '只有 USB 耳麦',
  'speakers-headset': '音箱 + USB 耳麦',
  'speakers-webcam': '音箱 + 摄像头',
  'speakers-headset-webcam': '音箱 + USB 耳麦 + 摄像头'
}

/** Rows whose check results only depend on the seed, GPU, kernel and their own switch. */
const NOISE_ROWS = new Set<FingerprintCheckRow>(['canvas', 'audio', 'clientrects'])
// What the check said about these compared the page with the exit IP of that check.
const IP_ROWS = new Set<FingerprintCheckRow>(['timezone', 'webrtc'])

function Fixed({ children }: { children: ReactNode }) {
  return <span className="fb-fp-fixed">{children}</span>
}

/** Every IANA zone this Chromium knows, for the custom time zone dropdown. */
const TIME_ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf('timeZone') } catch { return ['Asia/Shanghai', 'America/New_York', 'Europe/London'] }
})()

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

/**
 * The country a language is listed under: its own region (es-MX, pt-BR, es-419 → 拉丁美洲), else
 * where it is mostly used, from Chrome's locale data (CLDR likely subtags: ar → 埃及, af → 南非).
 */
function languageCountry(locale: string): string {
  try {
    const region = new Intl.Locale(locale).maximize().region
    return region ? regionName(region) : ''
  } catch {
    return ''
  }
}

/** 国家 · language in itself · code, as every language list shows it. */
function countryLanguageLabel(locale: string, country = languageCountry(locale)): string {
  return [country, ownLanguageName(locale), locale].filter(Boolean).join(' · ')
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

export function ProfileEditor({ open, profile, suggestedIndex, saving, extensions, engine, kernels, groups, proxies, onCancel, onSave, running: runningNow }: ProfileEditorProps) {
  const [form] = Form.useForm<EditorValues>()
  const [tab, setTab] = useState<EditorTab>('basic')
  // Each tab of each window keeps how far down it was scrolled.
  useScrollMemory(editorBody, open ? `editor:${profile?.id ?? 'new'}:${tab}` : undefined)
  const [testingProxy, setTestingProxy] = useState(false)
  // Each 检测代理 gets a number; a result that comes back after the editor was reopened (or another
  // check started) is dropped instead of showing up, or keeping the button spinning.
  const proxyCheckRun = useRef(0)
  // The last check's result stays shown, also when the editor is opened again, until 检测代理 is
  // clicked again; a proxy changed since is marked, not cleared.
  const [proxyResult, setProxyResult] = useState<ProxyTestResult | null>(null)
  const [editingIpSites, setEditingIpSites] = useState(false)
  const workspace = useWorkspace()
  const launcher = useWindowLauncher()
  // What the IP check sites said about the exit IP (IP 评分), read after each check that worked.
  const ipScore = useIpScore({ draft: () => currentDraft(), profileId: profile?.id, onOpen: profile ? (url) => void openInWindow(url) : undefined })
  const [proxyCheckedAt, setProxyCheckedAt] = useState<string>()
  const [proxyEdited, setProxyEdited] = useState(false)
  const [showApiLog, setShowApiLog] = useState(false)
  // An API window as its last check left it (its current proxy and IP history).
  const [apiView, setApiView] = useState<BrowserProfileView | undefined>()
  // API 提取: the window opens on the IP checked (勾选); unticked, its next launch takes a new one.
  const [useApiIp, setUseApiIp] = useState(true)
  // A typed or library proxy's exit IP: ticked, the window keeps the check; unticked, nothing of it is kept.
  const [keepCheck, setKeepCheck] = useState(true)
  // What the library proxies' checks were when the editor opened, to put back for an unticked one.
  const libraryChecksAtOpen = useRef(new Map<string, Pick<ProxyRecordView, 'check' | 'ipSites'>>())
  const checkedHere = useRef(false)
  // The library proxies checked in this editor (their earlier result is what an untick puts back).
  const checkedLibrary = useRef(new Set<string>())
  // The library entry the typed proxy is (same address, account and password), when there is one.
  const matchedLibrary = useRef<string | undefined>(undefined)
  // The result shown is the library proxy's latest check, made elsewhere (another window, the proxy page).
  const [resultShared, setResultShared] = useState(false)
  const draftSession = useRef('')
  const profileIdRef = useRef<string | undefined>(undefined)
  profileIdRef.current = open ? profile?.id : undefined
  // Closed (saved or not): the proxies this editor's API link gave are forgotten here.
  useEffect(() => {
    if (open) return
    if (draftSession.current) void window.browserApi.proxy.forgetDraft(draftSession.current).catch(() => undefined)
    draftSession.current = ''
  }, [open])
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
  /** A new window's country picked by hand: a proxy picked afterwards leaves it as it is. */
  const countryByHand = useRef(false)

  const typedProtocol = Form.useWatch(['proxy', 'protocol'], { form, preserve: true }) ?? 'direct'
  const typedHost = String(Form.useWatch(['proxy', 'host'], { form, preserve: true }) ?? '').trim()
  const typedPort = Form.useWatch(['proxy', 'port'], { form, preserve: true }) as number | undefined
  const typedUsername = String(Form.useWatch(['proxy', 'username'], { form, preserve: true }) ?? '')
  const proxyId = Form.useWatch('proxyId', { form, preserve: true }) ?? ''
  const startupMode = Form.useWatch('startupMode', { form, preserve: true })
  const startUrlText = String(Form.useWatch('startUrlsText', { form, preserve: true }) ?? '')
  const accountPlatform = String(Form.useWatch(['account', 'platform'], { form, preserve: true }) ?? '')
  /** The seller sites of the account's platform, when it has one per region. */
  const platformSites = PLATFORMS.find((item) => item.value === accountPlatform)?.sites
  const libraryProxy = proxyMode === 'library' ? proxies.find((item) => item.id === proxyId) : undefined
  /** Protocol of the proxy the window will use, whether typed or picked. */
  const proxyProtocol = proxyMode === 'library' ? libraryProxy?.protocol ?? 'direct' : proxyMode === 'api' ? 'http' : typedProtocol
  const sharedWith = libraryProxy ? libraryProxy.profileIds.filter((id) => id !== profile?.id).length : 0
  const tunnelStatus = useTunnelStatus()
  const watchedRoute = Form.useWatch('tunnel', { form, preserve: true }) as TunnelRoute | undefined
  /**
   * The window's 网络加速: its own, else the picked library proxy's (off when that proxy has none).
   * A window from before 0.5.9 still on its saved proxy keeps the old rule.
   */
  const proxyRoute = proxyMode === 'library' ? libraryProxy?.tunnel : undefined
  const legacyRoute = Boolean(profile && proxyMode === 'library' && proxyId === profile.proxyId && !profile.tunnel)
  const shownRoute = watchedRoute ?? (legacyRoute
    ? defaultTunnelRoute(tunnelStatus, proxyRoute, libraryProxy ? libraryProxy.check?.countryCode ?? '' : undefined)
    : defaultTunnelRoute(tunnelStatus, proxyRoute))
  // An HTTPS proxy cannot go through the tunnel (its certificate is checked against its own name).
  const route = proxyProtocol === 'https' && !libraryProxy?.apiUrl ? { ...shownRoute, enabled: false } : shownRoute
  const proxyPassword = Form.useWatch(['proxy', 'password'], { form, preserve: true }) ?? ''
  const apiUrlTyped = String(Form.useWatch(['proxy', 'apiUrl'], { form, preserve: true }) ?? '').trim()
  const proxyPasswordStored = Form.useWatch(['proxy', 'passwordStored'], { form, preserve: true }) === true
  const accountPassword = Form.useWatch(['account', 'password'], { form, preserve: true }) ?? ''
  const accountPasswordStored = Form.useWatch(['account', 'passwordStored'], { form, preserve: true }) === true
  const cookieText = Form.useWatch('cookieText', { form, preserve: true }) ?? ''
  const kernelVersion = Form.useWatch('kernelVersion', { form, preserve: true }) ?? ''
  const windowMode = Form.useWatch(['window', 'mode'], { form, preserve: true }) ?? 'auto'
  const initialFingerprint = useMemo(() => openedValues(profile, suggestedIndex).fingerprint, [profile, suggestedIndex])
  const watchedFingerprint = Form.useWatch('fingerprint', { form, preserve: true }) as Partial<FingerprintConfig> | undefined
  // `preserve` makes the watch report the whole fingerprint, not just the few keys that have a
  // Form.Item; without it clicks looked dead and a partial object crashed the drawer. Gaps (the
  // render between resetFields and setFieldsValue) are filled from the window being edited.
  const fp: FingerprintConfig = { ...initialFingerprint }
  // A key set to undefined (a value back to 跟随…) counts too; only missing keys are filled in.
  for (const [key, value] of Object.entries(watchedFingerprint ?? {})) {
    if (value === undefined) delete (fp as unknown as Record<string, unknown>)[key]
    else (fp as unknown as Record<string, unknown>)[key] = value
  }

  useEffect(() => {
    if (!open) return
    form.resetFields()
    const values = openedValues(profile, suggestedIndex)
    form.setFieldsValue(values)
    // Back where this window's editor was left: its tab, and (useScrollMemory) how far down.
    setTab(profile ? lastTabs.get(profile.id) ?? 'basic' : 'basic')
    if (!profile) forgetScroll('editor:new:')
    proxyCheckRun.current += 1
    countryByHand.current = false
    setTestingProxy(false)
    setProxyResult(profile?.proxyCheck ?? null)
    setProxyCheckedAt(profile?.proxyCheck?.checkedAt)
    setProxyEdited(false)
    setShowApiLog(false)
    setApiView(profile)
    setUseApiIp(true)
    setKeepCheck(true)
    checkedHere.current = false
    checkedLibrary.current = new Set()
    matchedLibrary.current = undefined
    setResultShared(Boolean(profile?.proxyCheck && profile.proxyId && !profile.apiProxy))
    libraryChecksAtOpen.current = new Map(proxies.map((item) => [item.id, { check: item.check, ipSites: item.ipSites }]))
    setCurrentCookies({})
    if (profile && (profile.status === 'closed' || profile.status === 'error')) {
      setCurrentCookies({ loading: true })
      const shownFor = profile.id
      void window.browserApi.profiles.currentCookies(profile.id).then(({ text, count }) => {
        // Only while this window is still the one being edited and nothing was typed into the box yet.
        if (shownFor !== profileIdRef.current || String(form.getFieldValue('cookieText') ?? '').trim()) { setCurrentCookies({}); return }
        form.setFieldValue('cookieText', count ? text : '')
        setCurrentCookies({ text: count ? text : '', count })
      }, (error: unknown) => setCurrentCookies({ error: error instanceof Error ? error.message : String(error) }))
    }
    // This editor's own id: what its API links give belongs to this window only.
    draftSession.current = crypto.randomUUID()
    ipScore.reset()
    ipScore.forgetAutoReads()
    // The last reading about the IP shown (a library proxy's, wherever it was read); one still being read
    // comes in. A window on a library proxy whose check worked and that has none about this IP reads it.
    const onLibrary = Boolean(profile?.proxyId && proxies.some((item) => item.id === profile.proxyId && !item.apiUrl))
    if (profile) void ipScore.follow({ profileId: profile.id }, profile.proxyCheck?.ip, { readIfMissing: onLibrary && profile.proxyCheck?.ok === true })
    void window.browserApi.app.fontPacks().then(setFontPacks).catch(() => undefined)
    setPasteText('')
    setPasted(null)
    setPasteError('')
    setProxyMode(profile?.apiProxy ? 'api' : profile?.proxyId && !profile.proxyMissing ? 'library' : profile?.proxy.protocol ?? 'direct')
    const initial = values.fingerprint
    setScreenCustom(Boolean(initial.overrides?.includes('screen')
      && !isChoice(initial.screenWidth, initial.screenHeight)))
    setCheckReport(null)
    setCheckError('')
    let current = true
    if (profile) void window.browserApi.profiles.lastFingerprintCheck(profile.id).then((report) => { if (current) setCheckReport(report) }).catch(() => undefined)
    // Saved passwords fill their boxes as dots; the eye button shows them.
    if (profile) {
      void window.browserApi.profiles.passwords(profile.id).then(({ proxy, account }) => {
        if (!current) return
        if (proxy && form.getFieldValue(['proxy', 'passwordStored']) && !form.getFieldValue(['proxy', 'password'])) form.setFieldValue(['proxy', 'password'], proxy)
        if (account && form.getFieldValue(['account', 'passwordStored']) && !form.getFieldValue(['account', 'password'])) form.setFieldValue(['account', 'password'], account)
      }).catch(() => undefined)
    }
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
  const otherFonts = fontPacks?.otherWindowsFonts
    ? otherWindowsFonts(fp, { platform: 'windows', platformVersion: fontPacks.otherWindowsFonts.hostPlatformVersion }, selectedEngine?.fingerprintKernel === true)
    : undefined
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
  // Canvas, AudioContext and ClientRects only change with the seed, GPU, kernel or their own switch.
  const noiseCurrent = Boolean(checkReport && noiseStillMatches(checkReport.checkedSettings, fp, kernelVersion || engine?.version))
  useEffect(() => {
    if (!recheck || checking) return
    setRecheck(false)
    void runCheck()
  }, [recheck, checking, currentSettingsKey])
  // The 指纹值 rows show their value in the box: only a problem with it adds a line.
  /** The first one-click change the check offers for these rows (shown in the row's box). */
  const rowsStale = (rows: FingerprintCheckRow[]) => rows.every((row) => NOISE_ROWS.has(row))
    ? !noiseCurrent
    : checkStale || (checkIpChanged && rows.some((row) => IP_ROWS.has(row)))
  const checkFix = (...rows: FingerprintCheckRow[]): QuickFix | undefined => {
    const stale = rowsStale(rows)
    for (const item of checkReport?.items ?? []) {
      if (!rows.includes(item.row) || item.status === 'ok') continue
      const fix = fixOf(item, stale)
      if (fix) return fix
    }
    return undefined
  }
  const checkFor = (...rows: FingerprintCheckRow[]) => {
    const items = checkReport?.items.filter((item) => rows.includes(item.row) && !(NOISE_ROWS.has(item.row) && item.status === 'ok'))
    return items?.length
      ? <CheckResults
          items={items}
          stale={rowsStale(rows)}
          fixOf={fixOf}
          note={checkIpChanged && !checkStale && rows.some((row) => IP_ROWS.has(row)) ? t("检测时的出口 IP 是 {0}，现在是 {1}，请重新检测", checkReport!.exitIp!, lastCheck!.ip!) : undefined}
        />
      : undefined
  }
  const kernelGpus = kernelGpuList(windowKernelVersion, fp.platform)
  const gpu = effectiveGpu(fp, windowKernelVersion)
  const gpuMissing = Boolean(fp.gpu && kernelGpus && !kernelGpus.some((item) => gpuKey(item) === fp.gpu))
  const gpuOptions = useMemo(() => {
    const available = new Set(kernelGpus?.map(gpuKey))
    return gpuChoices(fp.platform)
      .map((choice) => ({
        value: choice.key,
        label: gpuLabel(choice),
        disabled: kernelGpus ? !available.has(choice.key) : false
      }))
      .sort((a, b) => Number(a.disabled) - Number(b.disabled))
  }, [fp.platform, kernelGpus])
  /** The country was filled in from a checked proxy IP (基于 IP 生成) rather than picked (手动选择). */
  const fromIp = fp.regionSource === 'ip'
  const networkIdentity = effectiveNetworkIdentity(fp, proxyResult?.ok ? proxyResult : undefined)
  const cookiePreview = useMemo(() => countPastedCookies(cookieText), [cookieText])
  // A saved, closed window's cookies as they are now, shown in the box (edits replace them when saved).
  const [currentCookies, setCurrentCookies] = useState<{ loading?: boolean; text?: string; count?: number; error?: string }>({})
  const cookiesEdited = currentCookies.text !== undefined && cookieText !== currentCookies.text
  const regions = useMemo(regionChoices, [])
  // The exit country this window's last check saw (shown as its result), against the country picked by hand.
  /**
   * A new window's library proxy as last checked (on the 代理 IP page or by another window): its
   * country fills the window in until this window checks the proxy itself; its result is not shown here.
   */
  const libraryCheck = !profile && libraryProxy && !libraryProxy.apiUrl && libraryProxy.check?.ok ? libraryProxy.check : undefined
  const lastCheck = proxyResult ? (proxyResult.ok ? proxyResult : undefined) : libraryCheck
  // The fingerprint check went out through another exit IP than the latest proxy check's.
  const checkIpChanged = Boolean(checkReport?.exitIp && lastCheck?.ip && checkReport.exitIp !== lastCheck.ip)

  /**
   * A typed proxy that is in the library already (same address, account and password) shows that
   * entry's latest check and IP 评分, as picking it would; a new window takes its country.
   */
  const typedMode = proxyMode !== 'library' && proxyMode !== 'api' && proxyMode !== 'direct'
  useEffect(() => {
    if (!open || !typedMode || !typedHost || !typedPort) {
      matchedLibrary.current = undefined
      return
    }
    let current = true
    const timer = setTimeout(() => {
      const typed: ProxyConfig = { protocol: typedProtocol, host: typedHost, port: Number(typedPort), username: typedUsername, password: proxyPassword }
      void window.browserApi.proxy.match(typed).then((found) => {
        if (!current) return
        const id = found && !found.apiUrl ? found.id : undefined
        if (id === matchedLibrary.current) return
        matchedLibrary.current = id
        if (!found || !id || !found.check || testingProxy) return
        proxyCheckRun.current += 1
        setProxyResult(found.check)
        setProxyCheckedAt(found.check.checkedAt)
        setProxyEdited(false)
        setResultShared(true)
        setKeepCheck(true)
        void ipScore.follow({ proxyId: id }, found.check.ip, { readIfMissing: found.check.ok })
        if (!profile && !countryByHand.current && found.check.ok) fixToIp(found.check)
      }).catch(() => undefined)
    }, 400)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [open, typedMode, typedProtocol, typedHost, typedPort, typedUsername, proxyPassword])

  /**
   * The shown library proxy checked or read again elsewhere (another window, the proxy page) while
   * this editor is open: the newer result and IP 评分 show here too.
   */
  const sharedRecord = proxyMode === 'library' ? libraryProxy : typedMode && matchedLibrary.current ? proxies.find((item) => item.id === matchedLibrary.current) : undefined
  const sharedCheck = sharedRecord && !sharedRecord.apiUrl ? sharedRecord.check : undefined
  useEffect(() => {
    if (!open || !sharedRecord || sharedRecord.apiUrl || testingProxy || proxyEdited) return
    if (sharedCheck && (!proxyCheckedAt || Date.parse(sharedCheck.checkedAt) > Date.parse(proxyCheckedAt))) {
      setProxyResult(sharedCheck)
      setProxyCheckedAt(sharedCheck.checkedAt)
      setResultShared(true)
      setKeepCheck(true)
    }
    const kept = sharedRecord.ipSites
    if (!ipScore.loading && (sharedRecord.ipSitesPending || (kept && kept.checkedAt !== ipScore.record?.checkedAt))) {
      void ipScore.follow({ proxyId: sharedRecord.id }, (sharedCheck ?? proxyResult ?? undefined)?.ip)
    }
  }, [open, sharedRecord?.id, sharedCheck?.checkedAt, sharedRecord?.ipSites?.checkedAt, sharedRecord?.ipSitesPending, testingProxy])
  const exitCountry = lastCheck?.countryCode
  // A rotating proxy or databases that disagree say nothing reliable about the country (its own warning shows).
  const regionMismatch = fp.region && exitCountry && proxyProtocol !== 'direct' && lastCheck?.geoConfidence !== 'conflict' && exitCountry.toUpperCase() !== fp.region
    ? { ip: exitCountry.toUpperCase(), window: fp.region }
    : undefined
  // The IP's own country but another clock (a new IP elsewhere in it): pointed out, its fix sets the zone and position.
  const ipZone = proxyProtocol !== 'direct' && !regionMismatch ? ipZoneMismatch(fp.timezone, fp.region, lastCheck, fp.platform) : undefined
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
    if (value === 'ip') {
      // Filled in once from the last check (or a new one); kept from then on.
      void chooseByIp()
      return
    }
    if (value === 'custom') { countryByHand.current = true; patchFingerprint({ networkIdentityMode: 'manual' }); return }
    const item = regions.find((entry) => entry.code === value)
    if (!item) return
    countryByHand.current = true
    patchFingerprint({
      networkIdentityMode: 'manual',
      region: item.code,
      regionSource: undefined,
      location: undefined,
      language: item.locale.language,
      acceptLanguages: item.locale.acceptLanguages,
      uiLocale: undefined,
      voicesLocale: undefined,
      mediaLocale: undefined,
      keyboardLayout: undefined,
      timezone: item.zone
    })
  }
  const running = runningNow ?? Boolean(profile && profile.status !== 'closed' && profile.status !== 'error')

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
    return checkReport && noiseCurrent ? checkReport.observed[surface][0] : undefined
  }

  /** 换一换 on Canvas / AudioContext / ClientRects: new values, then the check reads what they are. */
  function reseedAndCheck(): void {
    reseedNoise()
    setRecheck(true)
  }

  /**
   * What a site reads for this value in this window, measured by the fingerprint check (the kernel
   * computes it on this computer's GPU and CPU, so the launcher cannot know it beforehand). The value
   * itself is shown in the choice above (noiseOptions); this line says when it was read, or offers the check.
   */
  function measuredLine(surface: NoiseSurface) {
    const value = measured(surface)
    if (checking) return <span className="fb-fp-measured fb-muted">{t("正在检测实际值…")}</span>
    if (value) return <span className="fb-fp-measured fb-muted">{surfaceMeaning(surface)}</span>
    return (
      <span className="fb-fp-measured fb-muted">
        {surfaceMeaning(surface)}
        <Unlocked><Button type="link" size="small" className="fb-deep-link" onClick={() => void runCheck()}>{t("检测实际值")}</Button></Unlocked>
      </span>
    )
  }

  /** Audio and ClientRects stay as the real machine computes them (kernel patches 006, 008). */
  function realSurface(surface: NoiseSurface) {
    const value = measured(surface)
    return <Fixed>{value ? t("本机真实 · {0}", value) : t("本机真实（与真实 Chrome 一致）")}</Fixed>
  }

  /** The two choices, each showing the value a site reads once the check has measured it. */
  function noiseOptions(surface: NoiseSurface, real: boolean) {
    const value = measured(surface)
    const pending = checking ? t("正在检测…") : t("待检测")
    return [
      { value: 'noise', label: !real && value ? value : `${t("每个窗口不同")} · ${real ? '' : pending}`.replace(/ · $/, '') },
      { value: 'real', label: real && value ? t("本机真实 · {0}", value) : t("本机真实") }
    ]
  }

  /** prism7+: each window its own audio / ClientRects (patches 006, 008), or the real values. */
  function seededControl(surface: NoiseSurface, label: string) {
    const real = fp.disabledSpoofing.includes(surface)
    return (
      <ValueChoice
        label={label}
        value={real ? 'real' : 'noise'}
        onChange={(next: string) => setSpoofing(surface, next === 'noise')}
        options={noiseOptions(surface, real)}
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
        options={noiseOptions(surface, real)}
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
      setProxyEdited(true)
      setPasteError('')
    } catch (error) {
      setPasteError(mt(error instanceof Error ? error.message : String(error)))
    }
  }

  function chooseProxyMode(mode: ProxyMode): void {
    setProxyMode(mode)
    setProxyEdited(true)
    if (mode !== 'library' && mode !== 'api') form.setFieldValue(['proxy', 'protocol'], mode)
  }

  /**
   * A proxy typed, pasted or picked: nothing is checked until 检测代理 is clicked (the proxy, its
   * 网络加速 or a whitelist may still be being set up). The last result stays, marked as older.
   * A library proxy brings its latest check and IP 评分, wherever they were made (another window, the proxy page).
   */
  function onFormChange(changed: Partial<EditorValues>): void {
    if (!('proxy' in changed) && !('proxyId' in changed)) return
    if ('proxyId' in changed) {
      proxyCheckRun.current += 1
      setTestingProxy(false)
      // The picked proxy's latest check (the window's saved proxy: the newer of its own and the proxy's).
      const picked = proxies.find((item) => item.id === changed.proxyId)
      const shared = picked && !picked.apiUrl ? picked.check : undefined
      const own = profile && changed.proxyId === profile.proxyId ? profile.proxyCheck : undefined
      const shown = own && (!shared || Date.parse(own.checkedAt) >= Date.parse(shared.checkedAt)) ? own : shared
      setProxyResult(shown ?? null)
      setResultShared(Boolean(shown))
      setKeepCheck(true)
      // No IP 评分 kept about the IP shown (checked where none was read): read it now.
      if (picked && !picked.apiUrl) void ipScore.follow({ proxyId: picked.id }, shown?.ip, { readIfMissing: shown?.ok === true })
      else ipScore.reset()
      // 网络加速 follows the picked proxy; back on its saved proxy the window has its own again.
      form.setFieldValue('tunnel', profile?.tunnel && changed.proxyId === profile.proxyId ? { ...profile.tunnel } : undefined)
      setProxyCheckedAt(shown?.checkedAt)
      setProxyEdited(false)
      // A new window takes the country the picked proxy was last checked in, unless one was picked by hand.
      if (!profile && !countryByHand.current && picked && !picked.apiUrl && picked.check?.ok) fixToIp(picked.check)
      return
    }
    setProxyEdited(true)
  }

  /**
   * A proxy checked while creating a window fills in its country, time zone and languages from that
   * IP and keeps them (the system language follows, and with it fonts, voices and device names):
   * a later IP, often another one for API and rotating proxies, does not change the window.
   * An existing window keeps its settings; a mismatch with the IP is only pointed out (regionMismatch).
   */
  function followCheckedIp(result: ProxyTestResult | null, run: number, fill = false): void {
    if (run !== proxyCheckRun.current) return
    setProxyResult(result)
    setProxyCheckedAt(new Date().toISOString())
    setProxyEdited(false)
    // The IP just checked is the one in use; what the IP check sites say about it comes next.
    setUseApiIp(true)
    setKeepCheck(true)
    setResultShared(false)
    checkedHere.current = true
    // A library proxy (picked, or typed and in the library): its result is the proxy's now.
    if (result?.libraryProxyId) matchedLibrary.current = result.libraryProxyId
    const libraryId = proxyMode === 'library' ? form.getFieldValue('proxyId') as string | undefined : result?.libraryProxyId
    if (libraryId) checkedLibrary.current.add(libraryId)
    if (result?.ok) void ipScore.read()
    else ipScore.reset()
    // A new window takes the country of the IP it is checked with; a rotating or unclear IP changes nothing.
    if (fill || !profile) fixToIp(result)
  }

  /**
   * 基于 IP 生成: picks the checked IP's country and fills in its time zone, languages and location.
   * The values are kept; a later IP does not change them. False when the check cannot say.
   */
  function fixToIp(result: ProxyTestResult | null | undefined): boolean {
    const fixed = fixedIdentityForCheck(form.getFieldValue('fingerprint') as FingerprintConfig, result ?? undefined, { followUiLocale: true })
    if (!fixed) return false
    // Everything under the country follows it again (voices and device names through the system language).
    patchFingerprint({ ...fixed, voicesLocale: undefined, mediaLocale: undefined, keyboardLayout: undefined })
    countryByHand.current = false
    return true
  }

  /** The IP's zone and position for a window already in the IP's country: the rest fits as it is. */
  function zoneToIp(result: ProxyTestResult): void {
    const current = form.getFieldValue('fingerprint') as FingerprintConfig
    const fixed = fixedIdentityForCheck(current, result)
    if (!fixed?.timezone) return
    // A window placed by its IP moves with it; one without a position keeps none.
    patchFingerprint({ timezone: fixed.timezone, ...(current.location && fixed.location ? { location: fixed.location } : {}) })
  }

  /** 基于 IP 生成 picked by hand: the last check's IP, or a new check when there is none yet. */
  async function chooseByIp(): Promise<void> {
    if (fixToIp(lastCheck)) return
    await testCurrentProxy(true)
  }

  /** API 提取 typed into the window: only the link; the proxy comes from it when saved and at every launch. */
  function apiProxy(): ProxyConfig {
    return { protocol: 'http', host: '', username: '', password: '', apiUrl: String(form.getFieldValue(['proxy', 'apiUrl']) ?? '').trim(), tunnel: route }
  }

  /** The window's saved API link, unchanged in the form: its kept proxy is the one to check. */
  function savedApiLink(): boolean {
    return Boolean(profile?.apiProxy && String(form.getFieldValue(['proxy', 'apiUrl']) ?? '').trim() === profile.apiProxy.url)
  }

  async function testCurrentProxy(fill = false, refresh = false): Promise<void> {
    const run = ++proxyCheckRun.current
    try {
      if (proxyMode === 'library') {
        await form.validateFields(['proxyId'])
        setTestingProxy(true)
        const picked = proxies.find((item) => item.id === form.getFieldValue('proxyId'))
        // The result is this window's (saved with it); reached the way this window will, through its 网络加速.
        followCheckedIp(picked && !picked.apiUrl
          ? await window.browserApi.proxy.test({ ...picked, tunnel: route }, profile?.id, picked.id)
          : (await window.browserApi.proxy.check(form.getFieldValue('proxyId'), route)).check ?? null, run, fill)
        return
      }
      if (proxyMode === 'api') {
        await form.validateFields([['proxy', 'apiUrl']])
        setTestingProxy(true)
        if (savedApiLink()) {
          // Its current proxy while it works (a new one when it does not, or on 换一个 IP); saved with its history.
          // Unticked: that IP is not used again, a new one is taken.
          const view = await window.browserApi.profiles.testProxy(profile!.id, refresh || !useApiIp, route)
          if (run === proxyCheckRun.current) setApiView(view)
          followCheckedIp(view.proxyCheck ?? null, run, fill)
          return
        }
        // A new window or a new link: the proxy the link gave (kept for the next 检测, and the one the
        // window starts on once saved); 换一个 IP or 取消勾选 take a new one.
        followCheckedIp(await window.browserApi.proxy.test(apiProxy(), profile?.id, undefined, refresh || !useApiIp, draftSession.current), run, fill)
        return
      }
      if (proxyProtocol !== 'direct') await form.validateFields([['proxy', 'host'], ['proxy', 'port']])
      setTestingProxy(true)
      followCheckedIp(await window.browserApi.proxy.test({ ...form.getFieldValue('proxy'), tunnel: route }, profile?.id), run, fill)
    } catch (error) {
      if (run !== proxyCheckRun.current) return
      if (proxyMode === 'api' && profile && savedApiLink()) {
        void window.browserApi.profiles.list().then((all) => {
          const fresh = all.find((item) => item.id === profile.id)
          if (fresh && run === proxyCheckRun.current) setApiView(fresh)
        }).catch(() => undefined)
      }
      if (!(error && typeof error === 'object' && 'errorFields' in error)) {
        setProxyResult({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) })
        setProxyCheckedAt(new Date().toISOString())
        setProxyEdited(false)
      } else {
        setTab('proxy')
      }
    } finally {
      if (run === proxyCheckRun.current) setTestingProxy(false)
    }
  }

  /** A site in this window itself (saved windows): a new tab when it runs, otherwise it starts with it. */
  async function openInWindow(url: string): Promise<void> {
    const saved = profile ? workspace.profiles.find((item) => item.id === profile.id) ?? profile : undefined
    if (!saved) return
    try {
      const next = await launcher.openUrl(saved, url)
      if (next) workspace.upsertProfiles([next])
    } catch (reason) {
      workspace.notify.error(humanError(reason))
    }
  }

  /** The start addresses are empty or only what a platform filled in (none typed by hand). */
  function startUrlsAreFilledIn(): boolean {
    const urls = String(form.getFieldValue('startUrlsText') ?? '').trim()
    return !urls || urls === 'https://browserleaks.com/' || PLATFORM_URLS.has(urls)
  }

  /** A platform picked (or cleared): its address replaces one a platform filled in; one typed by hand stays. */
  function onPlatformChange(platform: string): void {
    const known = PLATFORMS.find((item) => item.value === platform)
    // A platform's page opens the first time; after that the window carries on where it was left.
    if (known) form.setFieldValue('startupMode', 'restore')
    if (!startUrlsAreFilledIn()) return
    form.setFieldValue('startUrlsText', known?.url ?? '')
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
    // API 提取 left unticked: the window keeps nothing about that IP (a new one comes next time).
    const unticked = proxyMode === 'api' && !useApiIp
    const forget = checkForgotten()
    const draft = currentDraft()
    // The box shows the window's own cookies: unchanged, nothing to import; changed, they replace them.
    const ownCookies = currentCookies.text !== undefined
    await onSave(unticked ? { ...draft, draftSession: undefined } : draft, {
      cookieText: ownCookies && !cookiesEdited ? '' : values.cookieText ?? '',
      ...(ownCookies && cookiesEdited ? { cookieReplace: true } : {}),
      ...(unticked && profile?.apiProxy?.endpoint ? { apiDiscard: true } : {}),
      ...(forget ? { forgetCheck: forget } : {}),
      // A new window keeps the IP 评分 read before it was saved.
      ...(!profile && !unticked && !forget && ipScore.record ? { ipSites: ipScore.record } : {})
    })
  }

  /**
   * A typed or library proxy's exit IP left unticked: what to undo when the editor closes. The
   * window keeps no check and no IP 评分; a library proxy checked here gets its earlier result back.
   */
  function checkForgotten(): ForgetProxyCheck | undefined {
    if (proxyMode === 'api' || keepCheck || !proxyResult?.ok || proxyEdited) return undefined
    const libraryId = proxyMode === 'library' ? form.getFieldValue('proxyId') as string | undefined : matchedLibrary.current
    const typed = proxyMode !== 'library' ? currentDraft().proxy : undefined
    // Checked here: the proxy's result from before; a result from elsewhere taken off: the proxy has none.
    const before = libraryId && checkedLibrary.current.has(libraryId) ? libraryChecksAtOpen.current.get(libraryId) : undefined
    return {
      ...(profile ? { profileId: profile.id, windowCheck: null, ipSites: null } : {}),
      ...(libraryId ? { proxyId: libraryId, libraryCheck: before?.check ?? null, libraryIpSites: before?.ipSites ?? null } : {}),
      ...(typed && checkedHere.current ? { proxy: typed } : {})
    }
  }

  /** Closed without saving: an exit IP left unticked is dropped from the window all the same. */
  function cancel(): void {
    if (proxyMode === 'api' && !useApiIp && profile?.apiProxy?.endpoint) void window.browserApi.profiles.discardApiIp(profile.id).catch(() => undefined)
    const forget = checkForgotten()
    if (forget) void window.browserApi.profiles.forgetProxyCheck(forget).catch(() => undefined)
    onCancel()
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
      draftSession: draftSession.current,
      account: values.account,
      extensionIds: values.extensionIds,
      // Device name and MAC are kept as the values shown, not worked out again from the seed.
      fingerprint: { ...values.fingerprint, deviceName: shownDeviceName, macAddress: shownMacAddress }
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

  /**
   * The one-click change for a check result that does not match, as precise as the result allows
   * (the time zone alone, not the whole country). None once the setting already has it; changes that
   * depend on what was measured (new noise, real values) only while the result is current.
   */
  function fixOf(item: FingerprintCheckItem, stale: boolean): QuickFix | undefined {
    // Results saved before 0.5.21 offered the whole country for a time zone: the IP's time zone alone now,
    // as Chrome on this system reports it (an IP in Detroit is America/New_York on Windows).
    const ipZone = item.fix === 'set-timezone' || (item.fix === 'follow-ip' && item.row === 'timezone')
      ? item.fixValue ?? (lastCheck?.ok ? lastCheck.timezone : undefined)
      : undefined
    const timezone = ipZone ? ipZoneFix(ipZone, lastCheck?.countryCode ?? fp.region, fp.platform) : undefined
    if (timezone) return fp.timezone === timezone ? undefined : { label: t("改成 {0}", timezone), apply: () => patchFingerprint({ timezone }) }
    switch (item.fix) {
      case 'follow-ip': return lastCheck?.ok ? { label: t("改为跟随 IP"), apply: () => fixToIp(lastCheck) } : undefined
      case 'webrtc-replace': return fp.webrtcPolicy === 'proxy_only' ? undefined : { label: t("改为替换"), apply: () => patchFingerprint({ webrtcPolicy: 'proxy_only' }) }
      case 'reseed': return stale ? undefined : { label: t("换一组"), apply: reseedNoise }
      case 'shuffle-gpu': return stale ? undefined : { label: t("换一块显卡"), apply: shuffleGpu }
      case 'use-noise':
        if (stale || !(item.row === 'canvas' || item.row === 'audio' || item.row === 'clientrects' || item.row === 'font')) return undefined
        return fp.disabledSpoofing.includes(item.row) ? { label: t("改为每个窗口不同"), apply: () => setSpoofing(item.row as SpoofSurface, true) } : undefined
      case 'set-memory': {
        // A kernel that cannot set the memory: the setting takes what pages see.
        const gb = Number(item.fixValue)
        return (DEVICE_MEMORY_CHOICES as readonly number[]).includes(gb) && fp.deviceMemory !== gb
          ? { label: t("改成 {0}", `${gb} GB`), apply: () => patchFingerprint({ deviceMemory: gb as DeviceMemoryGb }) }
          : undefined
      }
      case 'use-prism': {
        // The newest installed Prism kernel (prism7 and later).
        const prism = kernels.filter((kernel) => kernel.installed && kernel.webrtcRelay).map((kernel) => kernel.version).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
        return prism && kernelVersion !== prism ? { label: t("改用内核 {0}", kernelName(prism)), apply: () => form.setFieldValue('kernelVersion', prism) } : undefined
      }
      case 'use-real':
        if (item.row === 'screen') return fp.screenSource === 'host' ? undefined : { label: t("改为本机真实"), apply: () => chooseScreen('host') }
        if (item.row === 'gpu') return gpuReal ? undefined : { label: t("改为本机真实"), apply: () => chooseGpu('real') }
        if (stale || !(item.row === 'canvas' || item.row === 'audio' || item.row === 'clientrects' || item.row === 'font')) return undefined
        return fp.disabledSpoofing.includes(item.row) ? undefined : { label: t("改为本机真实"), apply: () => setSpoofing(item.row as SpoofSurface, false) }
      default: return undefined
    }
  }

  const basic = (
    <div className="fb-editor-section">
      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("基本信息")}</h3>
        </div>
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
        hint={accountPasswordStored && !accountPassword ? t("已加密保存；平台和账号不变时留空保持原密码") : t("密码加密保存；导出文件不带密码，同步到团队时会一起同步")}
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
      <Row label={t("启动页面")} hint={startupMode === 'restore' ? t("第一次打开这些网址，之后打开上次关闭的页面") : t("每次都打开这些网址；每行一个，没写 http 的按 https 打开")}>
        <div className="fb-stack">
          <Form.Item name="startupMode" noStyle>
            <Radio.Group options={[{ value: 'restore', label: t("打开上次关闭的页面") }, { value: 'urls', label: t("每次打开指定页面") }]} />
          </Form.Item>
          {platformSites && (
            // Amazon and TikTok Shop have a seller site per region: the one picked here is the start page.
            <Select
              className="fb-site-select"
              prefix={t("站点")}
              placeholder={t("选择站点")}
              value={platformSites.find((site) => site.url === startUrlText.trim())?.region}
              onChange={(region: string) => form.setFieldValue('startUrlsText', platformSites.find((site) => site.region === region)?.url ?? '')}
              options={platformSites.map((site) => ({ value: site.region, label: site.region === 'EU' ? t("欧洲（英国、德国、法国、意大利、西班牙）") : regionName(site.region) }))}
              showSearch
              optionFilterProp="label"
              popupMatchSelectWidth={false}
            />
          )}
          <Form.Item noStyle shouldUpdate={(before, after) => before.startupMode !== after.startupMode}>
            {() => <Form.Item name="startUrlsText" noStyle>
              <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} placeholder="https://seller-us.tiktok.com" />
            </Form.Item>}
          </Form.Item>
        </div>
      </Row>
      </section>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("登录状态与备注")}</h3>
        </div>
      <Row
        label={t("Cookie")}
        hint={running
          ? t("窗口运行中，关闭后才能查看和修改 Cookie")
          : currentCookies.loading
            ? t("正在读取这个窗口现在的 Cookie…")
            : cookiePreview.error
              ? <Typography.Text type="danger">{mt(cookiePreview.error)}</Typography.Text>
              : currentCookies.text !== undefined
                ? cookiesEdited
                  ? t("已修改：保存后这个窗口的 Cookie 换成框里的 {0} 条，并同步到云端", cookiePreview.count ?? 0)
                  : t("这个窗口现在有 {0} 条 Cookie；改了保存后替换并同步到云端", currentCookies.count ?? 0)
                : cookiePreview.count !== undefined
                  ? t("识别到 {0} 条 Cookie，保存后导入此窗口并同步到云端", cookiePreview.count)
                  : currentCookies.error
                    ? <Typography.Text type="danger">{t("读取现在的 Cookie 失败：{0}", mt(currentCookies.error))}</Typography.Text>
                    : t("可选：粘贴或导入已登录账号的 Cookie，保存后直接是登录状态")}
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
      </section>
      <Collapse
        ghost
        className="fb-more"
        items={[{
          key: 'more',
          label: t("更多设置：标签、颜色、扩展"),
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
            </>
          )
        }]}
      />
    </div>
  )

  const placeText = (place?: ServerPlace) => [place?.countryCode, place?.city].filter(Boolean).join(' ')
  // API 提取: the address the link gave (the provider's server) beside the exit IP websites see.
  const keptEndpoint = proxyMode === 'api' && apiView?.apiProxy?.endpoint && apiUrlTyped === apiView.apiProxy.url ? apiView.apiProxy.endpoint : undefined
  const resultAddress = proxyMode !== 'api' ? undefined
    : proxyResult?.apiAddress ? { address: proxyResult.apiAddress, place: proxyResult.apiAddressPlace }
      : keptEndpoint ? { address: `${keptEndpoint.host}:${keptEndpoint.port}`, place: keptEndpoint.place } : undefined
  const resultNote = [
    proxyCheckedAt ? t("检测于 {0}", relativeTime(proxyCheckedAt, getLocale(), '')) : '',
    resultShared && !proxyEdited && proxyMode !== 'api' ? t("代理 IP 库里这个代理最近一次的检测，用它的窗口都一样") : '',
    proxyEdited ? t("代理已修改，未重新检测") : ''
  ].filter(Boolean).join(' · ')
  const apiTriggerLabels: Record<ApiCheckRecord['trigger'], string> = { check: t("检测代理"), refresh: t("换一个 IP"), launch: t("打开窗口") }
  const apiLog = keptEndpoint || (apiView?.apiProxy && apiUrlTyped === apiView.apiProxy.url) ? apiView?.apiProxy?.log ?? [] : []

  /** What a check found, as the chosen exit IP: the window uses this IP; its country sets the identity below. */
  const exitCard = !proxyResult
    ? <span className="fb-muted">{proxyProtocol === 'direct' ? t("还没检测；检测后这里是本机的出口 IP") : t("还没检测；检测后这里是这个窗口的出口 IP")}</span>
    : (
      <ExitIpCard
        result={proxyResult}
        stale={proxyEdited}
        typeHint={proxyMode !== 'library' && proxyMode !== 'api'}
        chosen={!proxyResult.ok || proxyEdited ? undefined
          : proxyMode === 'api' ? { checked: useApiIp, onChange: setUseApiIp, api: true }
            : { checked: keepCheck, onChange: setKeepCheck }}
        aside={proxyResult.ok ? ipScore.panel(proxyResult.ip) : undefined}
        notes={[
          resultNote,
          // The link is not used again by itself: a new proxy comes from 换一个 IP.
          proxyMode === 'api' && !proxyResult.ok ? t("点「换一个 IP」从链接取一个新的") : '',
          resultAddress && (
            <>
              {t("提取地址")} <span className="fb-mono">{resultAddress.address}</span>{placeText(resultAddress.place) && `（${placeText(resultAddress.place)}）`}
              {keptEndpoint?.fetchedAt && ` · ${t("取于 {0}", relativeTime(keptEndpoint.fetchedAt, getLocale(), ''))}`}
            </>
          )
        ]}
      />
    )
  const apiRecords = proxyMode === 'api' && (apiView?.apiProxy?.history?.length || apiLog.length) ? (
    <section className="fb-fp-card">
      <div className="fb-fp-card-head">
        <h3 className="fb-fp-group">{t("记录")}</h3>
      </div>
      <Tabs
        size="small"
        items={[
          {
            key: 'ips',
            label: t("IP 使用记录 · {0}", apiView?.apiProxy?.history?.length ?? 0),
            children: (
              <div className="fb-record-list">
                {(apiView?.apiProxy?.history ?? []).slice(0, 10).map((entry) => (
                  <div key={`${entry.at}-${entry.ip}`}>
                    <span className="fb-muted">{relativeTime(entry.at, getLocale(), '')}</span>
                    <span className="fb-mono">{entry.ip}{entry.port ? `:${entry.port}` : ''}</span>
                    <span>{[entry.countryCode ? regionName(entry.countryCode.toUpperCase()) : '', entry.city].filter(Boolean).join(' ')}</span>
                  </div>
                ))}
                {(apiView?.apiProxy?.history?.length ?? 0) > 10 && <span className="fb-muted">{t("共 {0} 条，只显示最近 10 条", apiView?.apiProxy?.history?.length ?? 0)}</span>}
              </div>
            )
          },
          {
            key: 'log',
            label: t("检测记录 · {0}", apiLog.length),
            children: (
              <div className="fb-record-list">
                {apiLog.slice(0, showApiLog ? apiLog.length : 5).map((entry) => (
                  <div key={`${entry.at}-${entry.address ?? ''}-${entry.trigger}`}>
                    <span className="fb-muted">{relativeTime(entry.at, getLocale(), '')} · {apiTriggerLabels[entry.trigger]}</span>
                    <span className="fb-mono">{[entry.address, entry.ok ? entry.ip : ''].filter(Boolean).join(' → ')}</span>
                    {entry.ok
                      ? <span className="fb-success-text">{t("成功")}{entry.fetched ? ` · ${t("新提取")}` : ''}{entry.rotating && <Tag color="warning" className="fb-inline-tag">{t("轮换 IP")}</Tag>}</span>
                      : <span className="fb-danger-text">{t("失败：{0}", mt(entry.error))}</span>}
                  </div>
                ))}
                {apiLog.length > 5 && (
                  <Button size="small" type="link" className="fb-link-start" onClick={() => setShowApiLog(!showApiLog)}>
                    {showApiLog ? t("收起") : t("展开全部 {0} 条", apiLog.length)}
                  </Button>
                )}
              </div>
            )
          }
        ]}
      />
    </section>
  ) : null

  const proxy = (
    <div className="fb-editor-section">
      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("代理")}</h3>
          <span className="fb-fp-card-sub">{proxyMode === 'api' ? t("填好服务商给的 API 链接") : t("填好或选好要用的代理")}</span>
        </div>
      <Row
        label={t("代理方式")}
        hint={proxyMode === 'api'
          ? t("链接只存在这个窗口；一个 IP 用到失效才取新的")
          : proxyMode !== 'direct' && proxyMode !== 'library' ? t("保存后自动存进代理库，库里已有相同的就用那一条") : undefined}
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
      {proxyMode !== 'api' && <Row
        label={t("快速粘贴")}
        hint={pasteError
          ? <Typography.Text type="danger">{pasteError}</Typography.Text>
          : pasted && proxyMode !== 'library' && proxyMode !== 'direct'
            ? <Typography.Text type="success">{t("已识别：{0}", pastedProxySummary(pasted, proxyMode))}{pasted.protocol ? '' : ` · ${t("未写协议，按当前选择的类型")}`}</Typography.Text>
            : undefined}
      >
        <Input.TextArea
          className="fb-paste"
          autoSize={{ minRows: 1, maxRows: 5 }}
          value={pasteText}
          placeholder={PASTE_PLACEHOLDER}
          onChange={(event) => applyPastedProxy(event.target.value)}
        />
      </Row>}
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
              title={t("这个代理已被另外 {0} 个窗口使用，共用出口 IP 可能被判定为关联账号", sharedWith)}
            />
          )}
        </>
      )}
      {proxyMode === 'api' && (
        <>
          <Row label={t("API 链接")} required hint={t("白名单模式：先把本机 IP 加进服务商白名单；只认境外 IP 的，开网络加速，加节点 IP")}>
            <Form.Item name={['proxy', 'apiUrl']} noStyle rules={[{ required: true, message: t("请输入 API 链接") }, { pattern: /^\s*https?:\/\//i, message: t("API 链接要以 http:// 或 https:// 开头") }]}>
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="https://example.com/api?num=1&format=txt" />
            </Form.Item>
          </Row>
          <FieldError name={['proxy', 'apiUrl']} />
        </>
      )}
      {proxyMode !== 'library' && proxyMode !== 'api' && proxyProtocol !== 'direct' && (
        <>
          <Row label={t("地址 / 端口")} required>
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
      {proxyProtocol !== 'direct' && (
        <Row label={t("网络加速")}>
          <TunnelRouteField
            value={route}
            status={tunnelStatus}
            disabledReason={route === shownRoute ? undefined : t("HTTPS 代理暂不支持网络加速，可改用 HTTP 或 SOCKS5")}
            onChange={(next) => { form.setFieldValue('tunnel', next); setProxyEdited(true) }}
          />
        </Row>
      )}
      </section>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("出口 IP")}</h3>
          <span className="fb-fp-card-sub">{proxyMode === 'api' ? t("一个 IP 用到失效才从链接取新的") : t("检测后就是这个窗口用的 IP")}</span>
          <span className="fb-fp-card-actions">
            <Button type="link" onClick={() => setEditingIpSites(true)}>{t("检测网站")}</Button>
            <IpCheckSites open={editingIpSites} onClose={() => setEditingIpSites(false)} />
            {proxyMode === 'api' && (keptEndpoint || proxyResult) && (
              <Tooltip title={t("从 API 链接取一个新代理，换掉现在这个")}>
                <Button disabled={testingProxy} onClick={() => void testCurrentProxy(false, true)}>{t("换一个 IP")}</Button>
              </Tooltip>
            )}
            {/* An open API window is not checked here: a dead proxy would be replaced under the running browser. */}
            {proxyMode === 'api'
              ? <Button type="primary" ghost loading={testingProxy} onClick={() => void testCurrentProxy()}>{proxyResult ? t("重新检测") : t("检测代理")}</Button>
              : <Unlocked><Button type="primary" ghost loading={testingProxy} onClick={() => void testCurrentProxy()}>{proxyResult ? t("重新检测") : t("检测代理")}</Button></Unlocked>}
          </span>
        </div>
        {exitCard}
        {proxyResult?.ok && proxyResult.geoConfidence === 'conflict' && (
          <Alert
            type="warning"
            showIcon
            className="fb-editor-alert fb-exit-alert"
            title={proxyResult.geoConflict?.includes('轮换代理')
              ? t("{0}；不会按它配置国家和语言，请在代理商后台改成固定会话（粘性 IP）", mt(proxyResult.geoConflict))
              : t("{0}；不会按它配置国家和语言，启动时会再检测并由你确认", mt(proxyResult.geoConflict))}
          />
        )}
        {proxyResult?.degraded && proxyResult.geoConfidence !== 'conflict' && <Alert type="warning" showIcon className="fb-editor-alert fb-exit-alert" title={mt(proxyResult.warning)} />}
        <div className="fb-ip-identity">
          <Row label={t("网络身份")}>
            <span className="fb-identity-line">
              <span>{[fp.region ? regionName(fp.region) : t("自定义"), fp.language, fp.timezone].join(' · ')}</span>
              <span className={`fb-region-source${fromIp ? ' is-ip' : ''}`}>{fromIp ? t("基于 IP 生成") : t("手动选择")}</span>
              <Button size="small" type="link" onClick={() => setTab('fingerprint')}>{t("在指纹里修改")}</Button>
            </span>
            {proxyResult?.ok && !proxyEdited && regionMismatch && (
              <RowWarning>
                {t("代理 IP 在{0}，窗口是{1}，网站可能发现", regionName(regionMismatch.ip), regionName(regionMismatch.window))}
                <Button type="link" size="small" className="fb-link-start" onClick={() => fixToIp(lastCheck)}>{t("改成和 IP 一致")}</Button>
              </RowWarning>
            )}
          </Row>
          {/* An API window takes a new proxy when its own stops working: an exit change is expected there. */}
          {proxyMode !== 'api' && (
            <Row label={t("IP 变了时")}>
              <Radio.Group
                size="small"
                optionType="button"
                value={fp.proxyExitPolicy}
                onChange={(event) => patchFingerprint({ proxyExitPolicy: event.target.value })}
                options={[{ value: 'block', label: t("阻止启动并确认（推荐）") }, { value: 'warn', label: t("仅提醒，继续启动") }]}
              />
            </Row>
          )}
        </div>
      </section>
      {apiRecords}
    </div>
  )

  /** The language the window launches with, for "follow the language" labels. */
  const shownLanguage = effectiveNetworkIdentity(fp, profile?.proxyCheck, { allowGeoConflict: true }).language
  /** Every kind with its count, and what is plugged in. */
  const mediaLabel = (set: string) => {
    const setup = MEDIA_SETUPS.find((item) => item.set === set)
    if (setup) {
      return t("麦克风 {0} · 扬声器 {1} · 耳机 {2} · 摄像头 {3}（{4}）", setup.microphones, setup.speakers, setup.headphones, setup.cameras, t(MEDIA_KIND_LABELS[setup.kind]))
    }
    // A set chosen before these setups (kept as it was saved).
    const [microphones, outputs, cameras] = set.split(',').map(Number)
    return t("麦克风 {0} · 音频输出 {1} · 摄像头 {2}", microphones, outputs, cameras)
  }
  const shownScreen = effectiveScreen(fp, windowKernelVersion, hostScreen(), windowScreen)
  const screenValue = fp.screenSource === 'host' || (shownScreen.width !== fp.screenWidth || shownScreen.height !== fp.screenHeight)
    ? 'host'
    : screenCustom || !isChoice(fp.screenWidth, fp.screenHeight)
      ? 'custom'
      : `${fp.screenWidth}x${fp.screenHeight}`
  // The resolution a site sees, as the monitor's own pixels, against what desktops with this card have.
  const screenPhysical = { width: Math.round(shownScreen.width * hostScale()), height: Math.round(shownScreen.height * hostScale()) }
  const screenOdd = Boolean(gpu?.model && !gpuReal && !screenSuitsGpu(gpu.model, screenPhysical))
  // No longer offered: today mostly 16-inch laptops.
  const laptopScreen = fp.screenSource !== 'host' && screenPhysical.width === 2560 && screenPhysical.height === 1600
  // Larger than this computer's monitor: maximize stops at this monitor, full screen gives a smaller page.
  const hostPhysical = { width: Math.round(hostScreen().width * hostScale()), height: Math.round(hostScreen().height * hostScale()) }
  const screenLarger = fp.screenSource !== 'host' && (screenPhysical.width > hostPhysical.width || screenPhysical.height > hostPhysical.height)
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
    ...LANGUAGES.map((item) => ({ value: item.language, label: [languageCountry(item.language), item.name, item.language].filter(Boolean).join(' · '), voices: item.voices, devices: item.devices })),
    ...(fp.language && !LANGUAGES.some((item) => item.language === fp.language) ? [{ value: fp.language, label: fp.language, voices: false, devices: false }] : [])
  ]
  const autoUiLocale = chromeUiLocaleFor(shownLanguage)
  // prism7+ kernels (same release as the WebRTC relay) show the fonts of the interface language.
  const windowUiLocale = fp.uiLocale ?? autoUiLocale
  const fontScript = windowsFontScript(windowUiLocale)
  const autoVoicesLocale = voiceLocaleForLanguage(windowUiLocale)
  const autoMediaLocale = mediaLocaleFor(windowUiLocale)
  const countryLocale = localeForCountry(fp.region)
  // What the language rows follow in the end: the country (from the IP or picked) while the browser
  // language is still the country's own, else the browser language; below the system language, that
  // language when it was picked on its own.
  const languageFromCountry = Boolean(fp.region && countryLocale?.language === fp.language)
  // Following the country (from the IP or picked): the country's name says where it comes from.
  const followUi = (value: string) => languageFromCountry && fp.region
    ? `${regionName(fp.region)} · ${value}`
    : t("跟随浏览器语言 · {0}", value)
  const followSystem = (value: string) => fp.uiLocale ? t("跟随系统语言 · {0}", value) : followUi(value)
  const voicesLabel = (locale: string) => `${locale} · ${WINDOWS_VOICE_LOCALES.find((item) => item.locale === locale)?.voices.join(', ') ?? ''}`
  // A value picked on its own that does not fit the country: pointed out, not stopped.
  const countryZones = fp.platform === 'windows' && fp.region ? countryWindowsZones(fp.region, getLocale()) : []
  const timezoneMismatch = countryZones.length > 0 && !countryZones.some((zone) => zone.iana === fp.timezone)
  const languageMismatch = countryLocale && fp.language && fp.region && !languageFitsCountry(fp.language, fp.region)
    ? { expected: countryLocale.language }
    : undefined
  // The fix for each (shared/quick-fix): the IP's zone when the IP is in this country, else the usual one there; the country's language.
  const fittingZone = timezoneMismatch && fp.region ? fittingCountryZone(fp.region, lastCheck?.ok ? lastCheck.timezone : undefined) : undefined
  const timezoneFix: QuickFix | undefined = timezoneMismatch && fittingZone
    ? { label: t("改成 {0}", fittingZone), apply: () => patchFingerprint({ timezone: fittingZone }) }
    : undefined
  const ipZoneFixLink: QuickFix | undefined = ipZone && lastCheck ? { label: t("改成和 IP 一致"), apply: () => zoneToIp(lastCheck) } : undefined
  const languageFix: QuickFix | undefined = languageMismatch && countryLocale
    ? { label: t("改成 {0}", countryLocale.language), apply: () => patchFingerprint({ language: countryLocale.language, acceptLanguages: countryLocale.acceptLanguages }) }
    : undefined
  const followSystemLanguage = (key: 'voicesLocale' | 'mediaLocale'): QuickFix => ({ label: t("改成跟随系统语言"), apply: () => patchFingerprint({ [key]: undefined }) })
  // The keyboard a fresh Windows in the browser language starts with (what the kernel reports unless picked).
  const autoKeyboardLayout = keyboardLayoutFor(fp.language ?? '')
  const keyboardPicked = fp.keyboardLayout && fp.keyboardLayout !== autoKeyboardLayout
  const followLanguageKeyboard: QuickFix = { label: t("改成 {0}", keyboardLayoutName(autoKeyboardLayout ?? '') ?? ''), apply: () => patchFingerprint({ keyboardLayout: undefined }) }
  // A size desktops with this card usually have (the first 常见 one in the list).
  const usualScreen = screenOdd ? usualScreenFor(gpu!.model, screenChoices(floor, hostScale())) : undefined
  const screenFix: QuickFix | undefined = usualScreen
    ? { label: t("改成 {0}", `${usualScreen.physical.width} × ${usualScreen.physical.height}`), apply: () => chooseScreen(`${usualScreen.width}x${usualScreen.height}`) }
    : undefined
  // No longer offered (today mostly 16-inch laptops): the desktop size next to it.
  const laptopFix: QuickFix = {
    label: t("改成 {0}", '2560 × 1440'),
    apply: () => { const size = cssScreenSize({ width: 2560, height: 1440 }, hostScale()); chooseScreen(`${size.width}x${size.height}`) }
  }
  const smallMemoryFix: QuickFix | undefined = fp.deviceMemory && SMALL_DEVICE_MEMORY.includes(fp.deviceMemory)
    ? { label: t("改为 8 GB"), apply: () => patchFingerprint({ deviceMemory: 8 }) }
    : undefined
  // Larger than this computer's monitor: the largest offered size that fits it (one desktops with this card have, when there is one).
  const fittingScreens = screenLarger
    ? screenChoices(floor, hostScale())
      .filter((choice) => choice.physical.width <= hostPhysical.width && choice.physical.height <= hostPhysical.height)
      .sort((x, y) => y.physical.width * y.physical.height - x.physical.width * x.physical.height)
    : []
  const fittingScreen = (gpu?.model && !gpuReal ? usualScreenFor(gpu.model, fittingScreens) : undefined) ?? fittingScreens[0]
  // None offered fits (a monitor smaller than every common size): this computer's own.
  const largerFix: QuickFix | undefined = !screenLarger ? undefined : fittingScreen
    ? { label: t("改成 {0}", `${fittingScreen.physical.width} × ${fittingScreen.physical.height}`), apply: () => chooseScreen(`${fittingScreen.width}x${fittingScreen.height}`) }
    : { label: t("改为本机真实"), apply: () => chooseScreen('host') }

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
              ...kernels.map((kernel) => ({ value: kernel.version, label: kernelName(kernel.version, kernels.map((item) => item.version)) })),
              ...(kernelVersion && !pinnedKernel ? [{ value: kernelVersion, label: t("{0} · 当前未安装", kernelName(kernelVersion)) }] : [])
            ]}
          />
        </Form.Item>
      </Row>
      {kernelVersion && !pinnedKernel && (
        <Alert
          type="error"
          showIcon
          className="fb-editor-alert"
          title={t("固定内核 {0} 当前不可用，安装该版本后才能启动，或改回自动跟随", kernelName(kernelVersion))}
          action={<Button size="small" onClick={() => form.setFieldValue('kernelVersion', '')}>{t("改回自动跟随")}</Button>}
        />
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
      {versionWarning && (
        <Alert
          type="warning"
          showIcon
          className="fb-editor-alert"
          title={`${mt(versionWarning)} · ${t("建议留空并自动匹配当前内核。")}`}
          action={<Button size="small" onClick={() => patchFingerprint({ brandVersion: '' })}>{t("改为自动匹配")}</Button>}
        />
      )}
      </section>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("国家与语言")}</h3>
          <span className="fb-fp-card-sub">{t("以下随国家/地区自动配套，也可以单独修改")}</span>
        </div>
      <Row
        label={t("国家/地区")}
        hint={!profile && libraryProxy && !libraryProxy.apiUrl && !libraryCheck && !proxyResult && !countryByHand.current
          ? t("这个代理还没检测，检测后按 IP 配")
          : fromIp
            ? profile
              ? t("已固定，IP 再变只提醒，不自动改")
              : resultShared && proxyResult?.ok && proxyCheckedAt && proxyResult.countryCode?.toUpperCase() === fp.region
                ? t("按代理库上次检测的 IP 配好（{0}）", relativeTime(proxyCheckedAt, getLocale()))
                : t("按检测到的 IP 配好；保存后固定，IP 再变只提醒")
            : t("窗口装成哪个国家的电脑，下面几项跟着配")}
        fix={regionMismatch && lastCheck ? { label: t("改成和 IP 一致"), apply: () => fixToIp(lastCheck) } : undefined}
      >
        <div className="fb-region-line">
          <Select
            showSearch
            optionFilterProp="label"
            className="fb-fp-select"
            value={fp.region ?? 'custom'}
            onChange={chooseRegion}
            options={[
              { value: 'ip', label: t("基于 IP 生成") },
              ...(!fp.region ? [{ value: 'custom', label: t("自定义") }] : []),
              ...regions.map((item) => ({ value: item.code, label: `${item.name} · ${ownLanguageName(item.locale.uiLocale)} · ${item.zone}` }))
            ]}
            aria-label={t("国家/地区")}
          />
          <span className={`fb-region-source${fromIp ? ' is-ip' : ''}`}>{fromIp ? t("基于 IP 生成") : t("手动选择")}</span>
        </div>
        {regionMismatch && (
          <RowWarning fix={lastCheck ? { label: t("改成和 IP 一致"), apply: () => fixToIp(lastCheck) } : undefined}>
            {t("代理 IP 在{0}，窗口是{1}，网站可能发现", regionName(regionMismatch.ip), regionName(regionMismatch.window))}
          </RowWarning>
        )}
      </Row>
      <Row label={t("时区")} check={checkFor('timezone')} fix={timezoneFix ?? ipZoneFixLink ?? checkFix('timezone')} hint={t("网页里的时间按它显示")}>
        <Form.Item name={['fingerprint', 'timezone']} noStyle>
          <Select showSearch optionFilterProp="label" className="fb-fp-select" options={timezoneOptions} aria-label={t("时区")} />
        </Form.Item>
        {timezoneMismatch && <RowWarning fix={timezoneFix}>{t("这个时区不在{0}，网站可能发现时区和国家对不上", regionName(fp.region!))}</RowWarning>}
        {!timezoneMismatch && ipZone && (
          <RowWarning fix={ipZoneFixLink}>
            {t("代理 IP 的时区是 {0}，窗口是 {1}，网站能看出时间和 IP 所在地对不上", windowsZoneLabel(ipZone, getLocale(), fp.region), windowsZoneLabel(fp.timezone!, getLocale(), fp.region))}
          </RowWarning>
        )}
      </Row>
      <Row label={t("系统语言")} hint={t("Windows 和 Chrome 菜单的语言；字体、语音、设备名跟着它")}>
        <Select
          showSearch
          optionFilterProp="label"
          className="fb-fp-select"
          value={fp.uiLocale ?? 'auto'}
          // Voices and device names follow the system language again.
          onChange={(value: string) => patchFingerprint({ uiLocale: value === 'auto' ? undefined : value, voicesLocale: undefined, mediaLocale: undefined })}
          options={[
            { value: 'auto', label: followUi(`${ownLanguageName(autoUiLocale)} · ${autoUiLocale}`) },
            ...CHROME_UI_LOCALES.map((locale) => ({ value: locale, label: countryLanguageLabel(locale) }))
          ]}
          aria-label={t("系统语言")}
        />
      </Row>
      <Row label={t("浏览器语言")} check={checkFor('language')} fix={languageFix ?? checkFix('language')} hint={`${t("网站读到的语言")} · Accept-Language: ${acceptLanguageHeader(chromeAcceptLanguages(networkIdentity.language, networkIdentity.acceptLanguages))}`}>
        <Select
          showSearch
          optionFilterProp="label"
          className="fb-fp-select"
          value={fp.language}
          onChange={(language: string) => {
            const item = LANGUAGES.find((entry) => entry.language === language)
            // The system language, voices and device names follow it again.
            if (item) patchFingerprint({ language: item.language, acceptLanguages: item.acceptLanguages, uiLocale: undefined, voicesLocale: undefined, mediaLocale: undefined, keyboardLayout: undefined })
          }}
          // The country's own language under the country itself, so it can be picked back after a change.
          options={languageOptions.map((option) => option.value === countryLocale?.language && fp.region
            ? { ...option, label: [regionName(fp.region), LANGUAGES.find((item) => item.language === option.value)?.name, option.value].filter(Boolean).join(' · ') }
            : option)}
          optionRender={(option) => (
            <span className="fb-language-option">
              <span>{option.label}</span>
              {option.data.voices && <Tag bordered={false} color="blue">{t("微软语音")}</Tag>}
              {option.data.devices && <Tag bordered={false} color="green">{t("设备名")}</Tag>}
            </span>
          )}
          aria-label={t("浏览器语言")}
        />
        {languageMismatch && <RowWarning fix={languageFix}>{t("{0}常用的是 {1}，这里是 {2}；网站可能发现语言和国家对不上", regionName(fp.region!), languageMismatch.expected, fp.language)}</RowWarning>}
      </Row>
      <Row label={t("地理位置")} hint={fp.location ? t("经纬度按代理 IP 的位置{0}", networkIdentity.latitude !== undefined ? `：${networkIdentity.latitude.toFixed(2)}, ${networkIdentity.longitude!.toFixed(2)}` : '') : undefined}>
        <Select
          className="fb-fp-select"
          value={fp.geolocationPermission ?? 'ask'}
          onChange={(geolocationPermission) => patchFingerprint({ geolocationPermission })}
          options={[{ value: 'ask', label: t("询问") }, { value: 'allow', label: t("允许") }, { value: 'block', label: t("禁止") }]}
        />
      </Row>
      {webrtcRelay ? (
        <Row
          label={t("字体")}
          check={checkFor('font')}
          fix={checkFix('font')}
          hint={fp.fontSource === 'host'
            ? t("这台电脑装的所有字体，用本机字体的窗口都一样")
            : t("Windows 自带字体 + 系统语言的字体包，本机另装的不显示")}
        >
          <Select
            className="fb-fp-select"
            value={fp.fontSource ?? 'language'}
            onChange={(fontSource) => patchFingerprint({ fontSource: fontSource === 'host' ? 'host' : undefined })}
            options={[
              { value: 'language', label: followSystem(`${ownLanguageName(windowUiLocale)} · ${windowUiLocale}`) },
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
          {otherFonts && fontPacks?.otherWindowsFonts && (
            // Fonts of the other Windows this window needs on this computer: they come with the
            // kernel and are installed when the window opens; until then they are this computer's.
            <div className="fb-check-results">
              {fontPacks.otherWindowsFonts[otherFonts] ? (
                <div className="fb-check-item is-ok">
                  <span className="fb-check-dot" />
                  <span className="fb-check-message">{t("已装好 Windows {0} 窗口要用的字体", otherFonts === 'win11' ? '11' : '10')}</span>
                </div>
              ) : (
                <div className="fb-check-item is-warn">
                  <span className="fb-check-dot" />
                  <span className="fb-check-message">
                    {t("这台电脑是 Windows {0}：Windows {1} 窗口要用 Windows {1} 自己的字体（随内核附带），打开窗口时自动安装。", otherFonts === 'win11' ? '10' : '11', otherFonts === 'win11' ? '11' : '10')}
                  </span>
                </div>
              )}
            </div>
          )}
        </Row>
      ) : (
        <Row label={t("字体")} check={checkFor('font')} fix={checkFix('font')}>{noiseControl('font', t("字体"))}</Row>
      )}

      <Row label={t("语音")} hint={t("网页能读到的朗读语音")} fix={fp.voicesLocale && fp.voicesLocale !== autoVoicesLocale ? followSystemLanguage('voicesLocale') : undefined}>
        <Select
          showSearch
          optionFilterProp="label"
          className="fb-fp-select"
          value={fp.voicesLocale ?? 'auto'}
          onChange={(value: string) => patchFingerprint({ voicesLocale: value === 'auto' ? undefined : value })}
          options={[
            { value: 'auto', label: followSystem(voicesLabel(autoVoicesLocale)) },
            ...WINDOWS_VOICE_LOCALES.map((item) => ({ value: item.locale, label: `${languageCountry(item.locale)} · ${voicesLabel(item.locale)}` }))
          ]}
          aria-label={t("语音")}
        />
        {fp.voicesLocale && fp.voicesLocale !== autoVoicesLocale && <RowWarning fix={followSystemLanguage('voicesLocale')}>{t("真实 Windows 的语音一般和系统语言一致")}</RowWarning>}
      </Row>
      <Row label={t("媒体设备名")} fix={fp.mediaLocale && fp.mediaLocale !== autoMediaLocale ? followSystemLanguage('mediaLocale') : undefined} hint={t("网站拿到麦克风、摄像头权限后看到的设备名，如「扬声器」或「Speakers」")}>
        <Select
          showSearch
          optionFilterProp="label"
          className="fb-fp-select"
          value={fp.mediaLocale ?? 'auto'}
          onChange={(value: string) => patchFingerprint({ mediaLocale: value === 'auto' ? undefined : value })}
          options={[
            { value: 'auto', label: followSystem(`${ownLanguageName(autoMediaLocale)} · ${autoMediaLocale}`) },
            ...MEDIA_LOCALES.map((locale) => ({ value: locale, label: countryLanguageLabel(locale) }))
          ]}
          aria-label={t("媒体设备名")}
        />
        {fp.mediaLocale && fp.mediaLocale !== autoMediaLocale && <RowWarning fix={followSystemLanguage('mediaLocale')}>{t("真实 Windows 的设备名和系统语言一致")}</RowWarning>}
      </Row>
      <Row label={t("键盘布局")} fix={keyboardPicked ? followLanguageKeyboard : undefined} hint={t("网站读到的键盘按键排列（navigator.keyboard），如德语键盘 Y、Z 互换")}>
        <Select
          showSearch
          optionFilterProp="label"
          className="fb-fp-select"
          value={fp.keyboardLayout ?? 'auto'}
          onChange={(value: string) => patchFingerprint({ keyboardLayout: value === 'auto' ? undefined : value })}
          options={[
            ...(autoKeyboardLayout ? [{ value: 'auto', label: followUi([keyboardLayoutName(autoKeyboardLayout), keyboardLayoutLocale(autoKeyboardLayout)].filter(Boolean).join(' · ')) }] : []),
            ...KEYBOARD_LAYOUTS.map((layout) => ({ value: layout.klid, label: [languageCountry(layout.locale), layout.name, layout.locale].filter(Boolean).join(' · ') }))
          ]}
          aria-label={t("键盘布局")}
        />
        {keyboardPicked && <RowWarning fix={followLanguageKeyboard}>{t("真实 Windows 的键盘一般和语言一致")}</RowWarning>}
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
        fix={gpuMissing ? { label: t("换一块显卡"), apply: shuffleGpu } : checkFix('gpu')}
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
        {gpuMissing && (
          <RowWarning fix={{ label: t("换一块显卡"), apply: shuffleGpu }}>{t("内核 {0} 里没有这块显卡，打开窗口前请重新选择", windowKernelVersion ?? '')}</RowWarning>
        )}
      </Row>
      <Row label={t("CPU 型号")} hint={t("网页读不到型号；硬件并发数自动等于它的线程数")}>
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
      <Row label={t("设备内存")} check={checkFor('memory')} fix={smallMemoryFix ?? checkFix('memory')} hint={maxDeviceMemoryGb(windowKernelVersion) < 32 ? t("网站读到的内存由内核决定：内核 147 及以上可选 16、32 GB，旧内核最多 8 GB") : undefined}>
        <ValueChoice
          label={t("设备内存")}
          value={fp.deviceMemory ?? 8}
          onChange={(value: DeviceMemoryGb) => patchFingerprint({ deviceMemory: value })}
          onShuffle={() => patchFingerprint({ deviceMemory: pickOther(DEVICE_MEMORY_CHOICES, fp.deviceMemory ?? 8) })}
          // A window saved with 2 or 4 GB shows it, but they are no longer offered.
          options={[...(fp.deviceMemory && SMALL_DEVICE_MEMORY.includes(fp.deviceMemory) ? [fp.deviceMemory] : []), ...DEVICE_MEMORY_CHOICES]
            .map((value) => ({ value, label: `${value} GB` }))}
        />
        {fp.deviceMemory && SMALL_DEVICE_MEMORY.includes(fp.deviceMemory) && (
          <RowWarning fix={smallMemoryFix}>
            {t("{0} GB 内存的电脑上 Chrome 的 JS 内存上限更小，这个窗口报的是 8 GB 及以上电脑的值，网站能对比出来", fp.deviceMemory)}
          </RowWarning>
        )}
      </Row>
      {kernelSpoofsScreen(windowKernelVersion) ? (
        <Row label={t("分辨率")} check={checkFor('screen')} fix={(laptopScreen ? laptopFix : screenOdd ? screenFix : undefined) ?? (screenLarger ? largerFix : undefined) ?? checkFix('screen')} hint={windowScreen
          ? t("网站读到的屏幕尺寸，浏览器窗口不会比它大")
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
                // The sizes desktops with this card usually have come first, marked 常见.
                ...screenChoices(floor, hostScale())
                  .map(({ width, height, physical }) => ({ width, height, physical, usual: Boolean(gpu?.model && !gpuReal && screenSuitsGpu(gpu.model, physical)) }))
                  .sort((a, b) => Number(b.usual) - Number(a.usual))
                  .map(({ width, height, physical, usual }) => ({
                    value: `${width}x${height}`,
                    label: usual ? `${screenLabel(width, height, physical)} · ${t("常见")}` : screenLabel(width, height, physical)
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
          {fp.screenSource !== 'host' && scaledScreen({ width: fp.screenWidth, height: fp.screenHeight }).scale && (
            <div className="fb-muted fb-row-note">
              {t("4K 显示器按 Windows 默认的 150% 缩放：网页看到 {0} × {1}，devicePixelRatio 1.5", scaledScreen({ width: fp.screenWidth, height: fp.screenHeight }).screen.width, scaledScreen({ width: fp.screenWidth, height: fp.screenHeight }).screen.height)}
            </div>
          )}
          {laptopScreen ? (
            <RowWarning fix={laptopFix}>
              {t("2560 × 1600 现在主要是 16 寸笔记本的屏幕，和台式机显卡不搭")}
            </RowWarning>
          ) : screenOdd && <RowWarning fix={screenFix}>{t("{0} 的电脑很少配 {1} × {2} 的屏幕，网站可能觉得不像真电脑", gpu!.model, screenPhysical.width, screenPhysical.height)}</RowWarning>}
          {screenLarger && (
            <RowWarning fix={largerFix}>
              {t("比本机屏幕（{0} × {1}）大：最大化只铺满本机屏幕；别用网页全屏，网站能看出来", hostPhysical.width, hostPhysical.height)}
            </RowWarning>
          )}
        </Row>
      ) : (
        <Row label={t("分辨率")} check={checkFor('screen')} fix={checkFix('screen')} hint={t("这个内核不支持修改分辨率，网站读到的是这台电脑的屏幕尺寸")}>
          <Fixed>{t("本机真实 · {0} × {1}", window.screen.width, window.screen.height)}</Fixed>
        </Row>
      )}
      <Row label={t("浏览器窗口")} hint={windowMode === 'auto' ? t("和新装的 Chrome 一样打开默认大小的窗口，之后记住你拖动后的大小") : undefined}>
        <Form.Item name={['window', 'mode']} noStyle>
          <Radio.Group size="small" optionType="button" options={[{ value: 'auto', label: t("自动尺寸与位置") }, { value: 'custom', label: t("固定尺寸与位置") }]} />
        </Form.Item>
      </Row>
      {windowMode === 'custom' && (
        <Row label={t("窗口尺寸")} hint={t("坐标从主显示器左上角算，换了显示器可能跑到屏幕外")}>
          <Space wrap>
            <Form.Item name={['window', 'width']} noStyle><InputNumber min={480} max={7680} precision={0} prefix="W" /></Form.Item>
            <Form.Item name={['window', 'height']} noStyle><InputNumber min={360} max={4320} precision={0} prefix="H" /></Form.Item>
            <Form.Item name={['window', 'x']} noStyle><InputNumber min={-20000} max={20000} precision={0} prefix="X" /></Form.Item>
            <Form.Item name={['window', 'y']} noStyle><InputNumber min={-20000} max={20000} precision={0} prefix="Y" /></Form.Item>
          </Space>
        </Row>
      )}
      <Row label={t("媒体设备")} hint={t("自动：音箱 + USB 耳麦，保存后固定；没授权的网站只看到有哪几类设备")}>
        <Select
          className="fb-fp-select"
          value={fp.mediaDevices ?? 'auto'}
          onChange={(value: string) => patchFingerprint({ mediaDevices: value === 'auto' ? undefined : value })}
          options={[
            { value: 'auto', label: t("自动 · {0}", mediaLabel(autoMediaDevices(fp.seed >>> 0, gpu?.model))) },
            ...MEDIA_PRESETS.map((value) => ({ value, label: mediaLabel(value) })),
            // A set saved before these setups stays selectable as it is.
            ...(fp.mediaDevices && fp.mediaDevices !== 'real' && !MEDIA_PRESETS.includes(fp.mediaDevices) ? [{ value: fp.mediaDevices, label: mediaLabel(fp.mediaDevices) }] : []),
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
        fix={checkFix('webrtc')}
        hint={fp.webrtcPolicy === 'proxy_only'
          ? webrtcRelay
            ? proxyResult?.udp === true
              ? t("网站看到代理 IP，视频通话能用")
              : proxyResult?.udp === false
                ? t("只报代理 IP，这个代理不支持 UDP，视频通话用不了")
                : t("报代理 IP；代理支持 UDP 时还能视频通话")
            : t("替换为代理 IP，防止泄露本机 IP")
          : fp.webrtcPolicy === 'privacy'
            ? t("开着 WebRTC，网站拿不到 IP")
            : fp.webrtcPolicy === 'disabled'
              ? webrtcRelay
                ? t("完全关掉；真 Chrome 都有 WebRTC，网站可能起疑")
                : t("这个内核不能关闭 WebRTC，按「隐私」处理")
              : t("和原版 Chrome 一样，会暴露本机真实 IP")}
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
          <span className="fb-fp-card-sub">{t("每个窗口不同，同一窗口每次一样")}</span>
        </div>
      <Row label="Canvas" check={checkFor('canvas')} fix={checkFix('canvas')} hint={webrtcRelay ? undefined : t("字体和 Canvas 共用一个种子，换一换会一起换")}>
        {noiseControl('canvas', 'Canvas')}
        {webrtcRelay && measuredLine('canvas')}
      </Row>
      <Row label="AudioContext" check={checkFor('audio')} fix={checkFix('audio')} hint={webrtcRelay ? undefined : t("这个内核只能用本机真实值")}>
        {webrtcRelay ? seededControl('audio', 'AudioContext') : realSurface('audio')}
        {webrtcRelay && measuredLine('audio')}
      </Row>
      <Row label="ClientRects" check={checkFor('clientrects')} fix={checkFix('clientrects')} hint={webrtcRelay ? undefined : t("这个内核只能用本机真实值")}>
        {webrtcRelay ? seededControl('clientrects', 'ClientRects') : realSurface('clientrects')}
        {webrtcRelay && measuredLine('clientrects')}
      </Row>
      </section>

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("其他")}</h3>
        </div>
      <Row label={t("设备名称")} hint={t("网页读不到，只用来区分窗口")}>
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
          ? t("{0} 网卡 · 网页读不到，只用来区分窗口", shownMacVendor)
          : t("网页读不到，只用来区分窗口")}
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

      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("指纹检测")}</h3>
        </div>
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
          <Unlocked><Button type="primary" loading={checking} onClick={() => void runCheck()}>{checkReport ? t("重新检测") : t("检测指纹")}</Button></Unlocked>
        </div>
        {checkStale && !checking && <div className="fb-check-stale">{t("设置已修改，结果可能已过时，请重新检测")}</div>}
        {!checkStale && checkIpChanged && !checking && <div className="fb-check-stale">{t("检测时的出口 IP 是 {0}，现在是 {1}，请重新检测", checkReport!.exitIp!, lastCheck!.ip!)}</div>}
        {checkError && <Alert type="error" showIcon title={checkError} />}
        {checkReport && <CheckResults items={checkReport.items.filter((item) => item.row === 'general')} stale={checkStale} fixOf={fixOf} buttons />}
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
      </div>
      </section>

      {/* Outside sites judging the window: kept apart from the check above, which reads the values itself. */}
      <section className="fb-fp-card">
        <div className="fb-fp-card-head">
          <h3 className="fb-fp-group">{t("深度检测")}</h3>
        </div>
        <div className="fb-check-panel">
          <DeepCheck draft={currentDraft} profileId={profile?.id} settingsKey={currentSettingsKey} />
        </div>
      </section>
    </div>
  )

  return (
    <Drawer
      // Only × or 取消 closes it: a click beside it or Esc would lose what was typed.
      maskClosable={false}
      keyboard={false}
      open={open}
      width={720}
      placement="right"
      destroyOnHidden
      className="fb-editor"
      onClose={cancel}
      title={(
        <span className="fb-editor-title">
          {profile ? t("编辑窗口") : t("新建窗口")}
          {profile && <Tag>{t("序号 #{0}", profile.serialNumber)}</Tag>}
        </span>
      )}
      footer={(
        <div className="fb-editor-footer">
          <Button onClick={cancel}>{t("取消")}</Button>
          <Button type="primary" loading={saving} onClick={() => void submit()}>{profile ? t("保存修改") : t("确定创建")}</Button>
        </div>
      )}
    >
      <Form
        form={form}
        requiredMark={false}
        onValuesChange={onFormChange}
      >
        <Tabs
          activeKey={tab}
          onChange={(key) => {
            if (profile) lastTabs.set(profile.id, key as EditorTab)
            setTab(key as EditorTab)
          }}
          items={[
            { key: 'basic', label: t("基础设置"), children: basic, forceRender: true },
            { key: 'proxy', label: t("代理设置"), children: <Locked locked={running}>{proxy}</Locked>, forceRender: true },
            { key: 'fingerprint', label: t("指纹设置"), children: <Locked locked={running}>{fingerprint}</Locked>, forceRender: true }
          ]}
        />
      </Form>
    </Drawer>
  )
}
