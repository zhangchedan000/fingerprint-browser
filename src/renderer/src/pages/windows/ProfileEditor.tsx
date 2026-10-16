import { t, translateMessage as mt } from '../../../../shared/i18n'
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
  Tooltip,
  Typography
} from 'antd'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { defaultPlatform, defaultProfileDraft, randomSeed } from '../../../../shared/defaults'
import { fingerprintVersionWarning } from '../../../../shared/fingerprint-consistency'
import {
  applyHardwareProfile,
  defaultHardwareProfileId,
  effectiveGpuIdentity,
  HARDWARE_PROFILES,
  hardwareProfile,
  refreshSeededGpuIdentity
} from '../../../../shared/hardware-profiles'
import { effectiveNetworkIdentity } from '../../../../shared/network-identity'
import { parsePastedProxy } from '../../../../shared/proxy-paste'
import { parseCookieFile } from '../../../../main/cookie-file'
import { PLATFORMS } from '../../../../shared/platforms'
import type {
  FingerprintOverride,
  BrowserExtension,
  BrowserPlatform,
  BrowserProfileView,
  EngineStatus,
  FingerprintConfig,
  HardwareProfileId,
  KernelRelease,
  PlatformAccount,
  ProfileDraft,
  ProxyRecordView,
  ProxyTestResult
} from '../../../../shared/types'
import { proxyLabel } from '../../components/proxy'

type SpoofSurface = FingerprintConfig['disabledSpoofing'][number]
type EditorTab = 'basic' | 'proxy' | 'fingerprint'
/** 'library' picks a proxy from the proxy library; the others type one in (it is saved into the library). */
type ProxyMode = 'direct' | 'http' | 'https' | 'socks5' | 'library'

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
  { value: '10.0.0', label: 'Windows 10' },
  { value: '15.0.0', label: 'Windows 11' }
]
const MACOS_VERSIONS = [
  { value: '13.0.0', label: 'macOS 13' },
  { value: '14.0.0', label: 'macOS 14' },
  { value: '15.0.0', label: 'macOS 15' }
]

/** Common desktop sizes used when the user asks for a random resolution. */
const COMMON_SCREENS: Array<[number, number]> = [
  [1920, 1080], [1536, 864], [1366, 768], [1440, 900], [1600, 900], [2560, 1440], [1680, 1050], [1280, 800]
]
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
    kernelVersion: draft.kernelVersion,
    window: { ...draft.window },
    proxy: { ...draft.proxy },
    proxyId: profile && !profile.proxyMissing ? profile.proxyId : '',
    account: profile
      ? { ...profile.account }
      : { platform: '', username: '', password: '' },
    cookieText: '',
    fingerprint: { ...draft.fingerprint, disabledSpoofing: [...draft.fingerprint.disabledSpoofing] }
  }
}

/** The UA Chrome reports with the reduced user-agent policy for the chosen system and kernel. */
function userAgentPreview(platform: BrowserPlatform, brand: string, version: string | undefined): string {
  const major = version?.split('.')[0] || '144'
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
function Row({ label, children, hint, required }: { label: ReactNode; children: ReactNode; hint?: ReactNode; required?: boolean }) {
  return (
    <div className="fb-form-row">
      <span className="fb-form-label">{required && <em>*</em>}{label}</span>
      <div className="fb-form-control">
        {children}
        {hint && <span className="fb-form-hint">{hint}</span>}
      </div>
    </div>
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

/** A choice the current kernel cannot apply yet: shown, never clickable. */
function Unsupported({ value, reason }: { value: string; reason: string }) {
  return (
    <Tooltip title={reason}>
      <span className="fb-unsupported">
        <Select className="fb-fp-select" disabled value={value} options={[{ value, label: value }]} />
      </span>
    </Tooltip>
  )
}

/** Every IANA zone this Chromium knows, for the custom time zone dropdown. */
const TIME_ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf('timeZone') } catch { return ['Asia/Shanghai', 'America/New_York', 'Europe/London'] }
})()

/** Languages offered when the language is set by hand; any other tag can still be typed. */
const LANGUAGES: Array<[string, string]> = [
  ['zh-CN', '中文（简体）'], ['zh-TW', '中文（繁體）'], ['zh-HK', '中文（香港）'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'],
  ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['de-DE', 'Deutsch'], ['fr-FR', 'Français'], ['es-ES', 'Español'], ['es-MX', 'Español (México)'],
  ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português'], ['it-IT', 'Italiano'], ['ru-RU', 'Русский'], ['uk-UA', 'Українська'],
  ['tr-TR', 'Türkçe'], ['vi-VN', 'Tiếng Việt'], ['th-TH', 'ไทย'], ['id-ID', 'Bahasa Indonesia'], ['ms-MY', 'Bahasa Melayu'],
  ['hi-IN', 'हिन्दी'], ['ar-SA', 'العربية'], ['nl-NL', 'Nederlands'], ['pl-PL', 'Polski'], ['sv-SE', 'Svenska']
]

/** Accept-Language a browser set to `language` sends: the tag, its base language, then English. */
function acceptLanguagesFor(language: string): string {
  const base = language.split('-')[0]
  return [...new Set([language, base, 'en-US', 'en'])].join(',')
}

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
  const [proxyResult, setProxyResult] = useState<ProxyTestResult | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [screenCustom, setScreenCustom] = useState(false)
  const [proxyMode, setProxyMode] = useState<ProxyMode>('direct')

  const typedProtocol = Form.useWatch(['proxy', 'protocol'], { form, preserve: true }) ?? 'direct'
  const proxyId = Form.useWatch('proxyId', { form, preserve: true }) ?? ''
  const libraryProxy = proxyMode === 'library' ? proxies.find((item) => item.id === proxyId) : undefined
  /** Protocol of the proxy the window will use, whether typed or picked. */
  const proxyProtocol = proxyMode === 'library' ? libraryProxy?.protocol ?? 'direct' : typedProtocol
  const sharedWith = libraryProxy ? libraryProxy.profileIds.filter((id) => id !== profile?.id).length : 0
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
    setProxyResult(null)
    setPasteText('')
    setPasteError('')
    setProxyMode(profile?.proxyId && !profile.proxyMissing ? 'library' : profile?.proxy.protocol ?? 'direct')
    const initial = editorValues(profile, suggestedIndex).fingerprint
    setScreenCustom(Boolean(initial.overrides?.includes('screen')
      && !COMMON_SCREENS.some(([width, height]) => width === initial.screenWidth && height === initial.screenHeight)))
  }, [form, open, profile, suggestedIndex])

  const pinnedKernel = kernels.find((kernel) => kernel.version === kernelVersion)
  const selectedEngine: EngineStatus | null = kernelVersion
    ? {
        executable: pinnedKernel?.executable ?? null,
        source: pinnedKernel ? 'profile' : 'missing',
        fingerprintKernel: true,
        label: pinnedKernel ? t("Fingerprint Chromium（环境固定）") : t("固定内核未安装"),
        version: kernelVersion
      }
    : engine
  const versionWarning = fingerprintVersionWarning(fp.brandVersion ?? '', selectedEngine)
  const selectedHardware = hardwareProfile(fp.hardwareProfileId)
  const hostMatched = selectedHardware?.hostMatched === true
  const gpu = effectiveGpuIdentity({ hardwareProfileId: fp.hardwareProfileId, seed: fp.seed, gpuBucket: fp.gpuBucket })
  const hostPlatform = defaultPlatform()
  const followIp = fp.networkIdentityMode === 'proxy'
  const networkIdentity = effectiveNetworkIdentity(fp, proxyResult?.ok ? proxyResult : libraryProxy?.check ?? profile?.proxyCheck)
  const cookiePreview = useMemo(() => countPastedCookies(cookieText), [cookieText])
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

  function spoofControl(surface: SpoofSurface) {
    const value = hostMatched || fp.disabledSpoofing.includes(surface) ? 'real' : 'random'
    return (
      <Select
        className="fb-fp-select"
        disabled={hostMatched}
        value={value}
        onChange={(next) => setSpoofing(surface, next === 'random')}
        options={[{ value: 'random', label: t("随机") }, { value: 'real', label: t("关闭") }]}
      />
    )
  }

  function chooseHardware(id: HardwareProfileId): void {
    // A new hardware set brings its own coherent values, so hand-set overrides start over.
    const next = applyHardwareProfile(form.getFieldValue('fingerprint'), id, { refreshSeededGpu: true })
    form.setFieldValue('fingerprint', { ...next, overrides: [] })
  }

  function setOverride(override: FingerprintOverride, enabled: boolean, patch: Partial<FingerprintConfig> = {}): void {
    const current = new Set<FingerprintOverride>(form.getFieldValue(['fingerprint', 'overrides']) ?? [])
    if (enabled) current.add(override)
    else current.delete(override)
    patchFingerprint({ ...patch, overrides: [...current] })
  }

  function chooseScreen(mode: string): void {
    if (mode === 'host') {
      patchFingerprint({ screenSource: 'host' })
      return
    }
    if (mode === 'template') {
      const template = hardwareProfile(form.getFieldValue(['fingerprint', 'hardwareProfileId']))
      setOverride('screen', false, { screenSource: 'profile', ...(template ? { screenWidth: template.screenWidth, screenHeight: template.screenHeight } : {}) })
      setScreenCustom(false)
      return
    }
    if (mode === 'custom') {
      setOverride('screen', true, { screenSource: 'profile' })
      setScreenCustom(true)
      return
    }
    const [width, height] = mode === 'random'
      ? COMMON_SCREENS[Math.floor(Math.random() * COMMON_SCREENS.length)]
      : mode.split('x').map(Number)
    setOverride('screen', true, { screenSource: 'profile', screenWidth: width, screenHeight: height })
    setScreenCustom(false)
  }

  function chooseCores(value: number | 'template'): void {
    if (value === 'template') {
      const template = hardwareProfile(form.getFieldValue(['fingerprint', 'hardwareProfileId']))
      setOverride('cores', false, template ? { hardwareConcurrency: template.hardwareConcurrency } : {})
    } else {
      setOverride('cores', true, { hardwareConcurrency: value })
    }
  }

  function choosePlatformVersion(value: string): void {
    const template = hardwareProfile(form.getFieldValue(['fingerprint', 'hardwareProfileId']))
    setOverride('platformVersion', value !== template?.platformVersion, { platformVersion: value })
  }

  function choosePlatform(platform: BrowserPlatform): void {
    if (platform === fp.platform) return
    chooseHardware(defaultHardwareProfileId(platform))
  }

  function applyPastedProxy(text: string): void {
    setPasteText(text)
    if (!text.trim()) { setPasteError(''); return }
    try {
      const parsed = parsePastedProxy(text)
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
    if (mode !== 'library') form.setFieldValue(['proxy', 'protocol'], mode)
  }

  async function testCurrentProxy(): Promise<void> {
    try {
      if (proxyMode === 'library') {
        await form.validateFields(['proxyId'])
        setTestingProxy(true)
        setProxyResult(null)
        // Saved on the library proxy, so every window using it sees the result.
        setProxyResult((await window.browserApi.proxy.check(form.getFieldValue('proxyId'))).check ?? null)
        return
      }
      if (proxyProtocol !== 'direct') await form.validateFields([['proxy', 'host'], ['proxy', 'port']])
      setTestingProxy(true)
      setProxyResult(null)
      setProxyResult(await window.browserApi.proxy.test(form.getFieldValue('proxy'), profile?.id))
    } catch (error) {
      if (!(error && typeof error === 'object' && 'errorFields' in error)) {
        setProxyResult({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) })
      } else {
        setTab('proxy')
      }
    } finally {
      setTestingProxy(false)
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
    const color = typeof values.color === 'string' ? values.color : values.color.toHexString()
    await onSave({
      name: values.name,
      note: values.note,
      group: values.group ?? '',
      tags: values.tags,
      color,
      startUrls: String(values.startUrlsText ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      kernelVersion: values.kernelVersion,
      window: values.window,
      // A picked library proxy goes by id; a typed one is saved into the library by the store.
      ...(proxyMode === 'library'
        ? { proxyId: values.proxyId, proxy: { protocol: 'direct' as const, host: '', username: '', password: '' } }
        : { proxy: values.proxy }),
      account: values.account,
      extensionIds: values.extensionIds,
      fingerprint: values.fingerprint
    }, { cookieText: values.cookieText ?? '' })
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
      <Row label={t("启动页面")} hint={t("每行一个网址；不填写协议时自动使用 HTTPS")}>
        <Form.Item name="startUrlsText" noStyle>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} placeholder="https://seller-us.tiktok.com" />
        </Form.Item>
      </Row>
      <Row
        label={t("Cookie")}
        hint={running
          ? t("窗口运行中，关闭后才能导入 Cookie")
          : cookiePreview.error
            ? <Typography.Text type="danger">{mt(cookiePreview.error)}</Typography.Text>
            : cookiePreview.count !== undefined
              ? t("识别到 {0} 条 Cookie，保存后导入此窗口", cookiePreview.count)
              : t("粘贴 JSON 格式 Cookie（支持常见插件导出的格式），保存后导入")}
      >
        <Form.Item name="cookieText" noStyle>
          <Input.TextArea disabled={running} autoSize={{ minRows: 3, maxRows: 8 }} placeholder={t("粘贴 JSON 格式 Cookie，或从文件导入")} />
        </Form.Item>
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
              <Row label={t("浏览器窗口")}>
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
        hint={proxyMode !== 'direct' && proxyMode !== 'library' ? t("填写的代理会自动存入代理库；代理库里已有相同的代理时直接使用那一条。") : undefined}
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
                onChange={() => setProxyResult(null)}
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
      {proxyMode !== 'library' && proxyProtocol !== 'direct' && (
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
      <Row
        label={t("快速粘贴")}
        hint={pasteError ? <Typography.Text type="danger">{pasteError}</Typography.Text> : t("支持 host:port:user:pass、user:pass@host:port 和 socks5://user:pass@host:port，粘贴后自动填入")}
      >
        <Input
          className="fb-paste"
          value={pasteText}
          placeholder="host:port:user:pass"
          onChange={(event) => applyPastedProxy(event.target.value)}
        />
      </Row>
      <Row label="">
        <div className="fb-proxy-test">
          <Button loading={testingProxy} onClick={() => void testCurrentProxy()}>{t("检测代理")}</Button>
          {proxyResult?.ok && (
            <span className={`fb-proxy-result ${proxyResult.geoConfidence === 'conflict' ? 'warn' : 'ok'}`}>
              {t("连接正常")} · {proxyResult.ip} · {[proxyResult.country, proxyResult.city].filter(Boolean).join(' ')} · {t("延迟 {0} ms", proxyResult.latencyMs)}
              {proxyResult.networkRisk && <Tag color="warning" className="fb-inline-tag">{riskLabels[proxyResult.networkRisk]}</Tag>}
            </span>
          )}
          {proxyResult && !proxyResult.ok && <span className="fb-proxy-result bad">{t("连接失败：{0}", mt(proxyResult.error))}</span>}
        </div>
      </Row>
      {proxyResult?.ok && proxyResult.geoConfidence === 'conflict' && (
        <Alert type="warning" showIcon className="fb-editor-alert" title={t("代理地理信息存在冲突")} description={t("{0}。继续使用可能影响指纹一致性；启动时会再次检测，并由用户确认是否继续。", mt(proxyResult.geoConflict))} />
      )}
      {proxyResult?.degraded && <Alert type="warning" showIcon className="fb-editor-alert" title={mt(proxyResult.warning)} />}
      <Row
        label={t("按 IP 匹配")}
        hint={followIp
          ? proxyProtocol === 'direct'
            ? t("直连环境继续使用指纹设置里的手动值；配置代理后自动联动。")
            : t("启动时按出口 IP 设置：{0} · {1}", networkIdentity.language, networkIdentity.timezone)
          : t("关闭后使用指纹设置里手动填写的时区和语言")}
      >
        <Switch
          checked={followIp}
          aria-label={t("按 IP 匹配")}
          onChange={(checked) => patchFingerprint({ networkIdentityMode: checked ? 'proxy' : 'manual' })}
        />
        <span className="fb-switch-label">{t("根据出口 IP 自动设置时区、语言和地理位置")}</span>
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

  const hardwareOptions = HARDWARE_PROFILES
    .filter((item) => item.platform === fp.platform)
    .map((item) => ({ value: item.id, label: mt(item.label), disabled: item.hostMatched && item.platform !== hostPlatform }))
  const kernelUnsupported = t("当前内核暂不支持，编译新内核后开放")
  const screenValue = fp.screenSource === 'host'
    ? 'host'
    : screenCustom
      ? 'custom'
      : fp.overrides?.includes('screen')
        ? COMMON_SCREENS.some(([width, height]) => width === fp.screenWidth && height === fp.screenHeight) ? `${fp.screenWidth}x${fp.screenHeight}` : 'custom'
        : 'template'
  const languageOptions = [
    ...LANGUAGES.map(([value, label]) => ({ value, label: `${label} · ${value}` })),
    ...(fp.language && !LANGUAGES.some(([value]) => value === fp.language) ? [{ value: fp.language, label: fp.language }] : [])
  ]

  const fingerprint = (
    <div className="fb-editor-section">
      <div className="fb-fp-intro">
        <span>{t("每个窗口独立指纹，重启后保持不变。不确定的选项保持默认即可。")}</span>
        <Button
          onClick={() => form.setFieldValue('fingerprint', refreshSeededGpuIdentity({ ...form.getFieldValue('fingerprint'), seed: randomSeed() }))}
        >{t("一键随机指纹")}</Button>
      </div>
      {hostMatched && (
        <Alert type="info" showIcon className="fb-editor-alert" title={t("使用当前设备的硬件信息")} description={t("本机硬件模板会让 Canvas、WebGL、Audio、字体和 ClientRects 都使用真实值。")} />
      )}

      <h3 className="fb-fp-group">{t("基础信息")}</h3>
      <Row label={t("浏览器内核")} hint={t("每个窗口可单独指定，在内核管理里导入更多版本")}>
        <Form.Item name="kernelVersion" noStyle>
          <Select
            className="fb-wide-select"
            options={[
              { value: '', label: engine?.version ? t("跟随默认内核（Chromium {0}）", engine.version) : t("跟随默认内核") },
              ...kernels.map((kernel) => ({ value: kernel.version, label: `Chromium ${kernel.version}${kernel.origin === 'local-build' ? ' · ' + t('本地构建') : ''}` })),
              ...(kernelVersion && !pinnedKernel ? [{ value: kernelVersion, label: t("{0} · 当前未安装", kernelVersion) }] : [])
            ]}
          />
        </Form.Item>
      </Row>
      {kernelVersion && !pinnedKernel && (
        <Alert type="error" showIcon className="fb-editor-alert" title={t("固定内核 {0} 当前不可用", kernelVersion)} description={t("安装该版本后才能启动此环境，或者改回自动跟随。")} />
      )}
      <Row label={t("浏览器品牌")}>
        <Select
          className="fb-fp-select"
          value={fp.brand}
          onChange={(brand) => patchFingerprint({ brand })}
          options={[{ value: 'Chrome', label: 'Chrome' }, { value: 'Edge', label: 'Edge' }]}
        />
      </Row>
      <Row label={t("操作系统")}>
        <Space wrap size={8}>
          <Select
            className="fb-fp-select-half"
            value={fp.platform}
            onChange={choosePlatform}
            options={[{ value: 'windows', label: 'Windows' }, { value: 'macos', label: 'macOS' }]}
            aria-label={t("操作系统")}
          />
          <Select
            disabled={hostMatched}
            className="fb-fp-select-half"
            value={fp.platformVersion}
            onChange={choosePlatformVersion}
            options={(fp.platform === 'windows' ? WINDOWS_VERSIONS : MACOS_VERSIONS)}
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

      <h3 className="fb-fp-group">{t("地区与网络")}</h3>
      <Row label={t("时区")} hint={followIp ? networkIdentity.timezone : t("时区和语言一起跟随 IP 或一起自定义")}>
        <Space wrap size={8}>
          <Select
            className="fb-fp-select-half"
            value={followIp ? 'ip' : 'custom'}
            onChange={(mode) => patchFingerprint({ networkIdentityMode: mode === 'ip' ? 'proxy' : 'manual' })}
            options={[{ value: 'ip', label: t("基于 IP 生成") }, { value: 'custom', label: t("自定义") }]}
            aria-label={t("时区")}
          />
          {!followIp && (
            <Form.Item name={['fingerprint', 'timezone']} noStyle>
              <Select
                showSearch
                className="fb-fp-select"
                placeholder="Asia/Shanghai"
                options={TIME_ZONES.map((zone) => ({ value: zone, label: zone }))}
                aria-label={t("时区")}
              />
            </Form.Item>
          )}
        </Space>
      </Row>
      <Row label={t("语言")} hint={followIp ? `${networkIdentity.language} · ${networkIdentity.acceptLanguages}` : fp.acceptLanguages}>
        <Space wrap size={8}>
          <Select
            className="fb-fp-select-half"
            value={followIp ? 'ip' : 'custom'}
            onChange={(mode) => patchFingerprint({ networkIdentityMode: mode === 'ip' ? 'proxy' : 'manual' })}
            options={[{ value: 'ip', label: t("基于 IP 生成") }, { value: 'custom', label: t("自定义") }]}
            aria-label={t("语言")}
          />
          {!followIp && (
            <Select
              showSearch
              optionFilterProp="label"
              className="fb-fp-select"
              value={fp.language}
              onChange={(language) => patchFingerprint({ language, acceptLanguages: acceptLanguagesFor(language) })}
              options={languageOptions}
              aria-label={t("语言")}
            />
          )}
        </Space>
      </Row>
      <Row label={t("界面语言")} hint={t("目前与语言保持一致")}>
        <Unsupported value={t("跟随语言")} reason={kernelUnsupported} />
      </Row>
      <Row label={t("地理位置")} hint={followIp ? t("基于 IP 生成经纬度") : undefined}>
        <Select
          className="fb-fp-select"
          value={fp.geolocationPermission ?? 'ask'}
          onChange={(geolocationPermission) => patchFingerprint({ geolocationPermission })}
          options={[{ value: 'ask', label: t("询问") }, { value: 'allow', label: t("允许") }, { value: 'block', label: t("禁止") }]}
        />
      </Row>
      <Row
        label="WebRTC"
        hint={fp.webrtcPolicy === 'proxy_only'
          ? t("替换为代理 IP，防止泄露本机 IP")
          : fp.webrtcPolicy === 'public_only'
            ? t("可能暴露真实公网 IP")
            : t("高风险：WebRTC 使用所有接口")}
      >
        <Select
          className="fb-fp-select"
          value={fp.webrtcPolicy}
          onChange={(webrtcPolicy) => patchFingerprint({ webrtcPolicy })}
          options={[{ value: 'proxy_only', label: t("替换") }, { value: 'public_only', label: t("仅公网") }, { value: 'default', label: t("真实") }]}
        />
      </Row>

      <h3 className="fb-fp-group">{t("显示")}</h3>
      <Row label={t("分辨率")} hint={fp.screenSource === 'host' ? t("启动时使用这台电脑的屏幕尺寸") : `${fp.screenWidth} × ${fp.screenHeight}`}>
        <Space wrap size={8}>
          <Select
            className="fb-fp-select"
            value={screenValue}
            onChange={chooseScreen}
            aria-label={t("分辨率")}
            options={[
              { value: 'template', label: t("跟随硬件配置（{0}）", selectedHardware ? `${selectedHardware.screenWidth} × ${selectedHardware.screenHeight}` : `${fp.screenWidth} × ${fp.screenHeight}`) },
              { value: 'random', label: t("随机") },
              { value: 'host', label: t("跟随电脑") },
              ...COMMON_SCREENS.map(([width, height]) => ({ value: `${width}x${height}`, label: `${width} × ${height}` })),
              { value: 'custom', label: t("自定义") }
            ]}
          />
          {screenValue === 'custom' && (
            <>
              <Form.Item name={['fingerprint', 'screenWidth']} noStyle><InputNumber min={800} max={7680} precision={0} prefix="W" aria-label={t("屏幕宽度")} /></Form.Item>
              <Form.Item name={['fingerprint', 'screenHeight']} noStyle><InputNumber min={600} max={4320} precision={0} prefix="H" aria-label={t("屏幕高度")} /></Form.Item>
            </>
          )}
        </Space>
      </Row>
      <Row label={t("字体")}>{spoofControl('font')}</Row>

      <h3 className="fb-fp-group">{t("硬件指纹")}</h3>
      <Row label={t("硬件配置")} hint={selectedHardware ? `${t("{0} 核", selectedHardware.hardwareConcurrency)} · ${selectedHardware.physicalMemoryGb} GB · ${mt(gpu?.model ?? selectedHardware.gpuModel)}` : t("旧版自定义配置（保持原指纹）")}>
        <Select
          className="fb-wide-select"
          value={fp.hardwareProfileId}
          onChange={chooseHardware}
          options={[
            ...hardwareOptions,
            ...(fp.hardwareProfileId === 'legacy-custom' ? [{ value: 'legacy-custom' as const, label: t("旧版自定义配置（保持原指纹）"), disabled: false }] : [])
          ]}
        />
      </Row>
      {selectedHardware?.renderIdentityMode === 'seeded-curated' && selectedHardware.gpuPool?.length && (
        <Row label={t("显卡型号")} hint={t("只列出内核里有完整渲染数据的真实型号；每个窗口可以不同")}>
          <Select
            className="fb-wide-select"
            showSearch={{ optionFilterProp: 'label' }}
            aria-label={t("显卡型号")}
            value={gpu?.bucket}
            onChange={(bucket: number) => patchFingerprint({ gpuBucket: bucket, renderIdentityVersion: 4 })}
            options={selectedHardware.gpuPool.map((identity) => ({
              value: identity.bucket,
              label: identity.deviceId ? `${identity.model} · ${identity.deviceId.replace(/^0x0*/, '')}` : identity.model
            }))}
          />
        </Row>
      )}
      <Row label="Canvas">{spoofControl('canvas')}</Row>
      <Row label={t("WebGL 图像")} hint={t("与 WebGL 元数据一起开关")}>
        <Unsupported value={hostMatched || fp.disabledSpoofing.includes('gpu') ? t("关闭") : t("随机")} reason={kernelUnsupported} />
      </Row>
      <Row label={t("WebGL 元数据")} hint={mt(gpu?.model ?? selectedHardware?.gpuModel ?? '')}>{spoofControl('gpu')}</Row>
      <Row label="WebGPU" hint={t("与 WebGL 元数据一起开关")}>
        <Unsupported value={hostMatched || fp.disabledSpoofing.includes('gpu') ? t("关闭") : t("随机")} reason={kernelUnsupported} />
      </Row>
      <Row label="AudioContext">{spoofControl('audio')}</Row>
      <Row label="ClientRects">{spoofControl('clientrects')}</Row>
      <Row label="SpeechVoices" hint={t("自动与系统和语言保持一致")}>
        <Unsupported value={t("随机")} reason={kernelUnsupported} />
      </Row>
      <Row label={t("媒体设备")}>
        <Unsupported value={t("随机")} reason={kernelUnsupported} />
      </Row>
      <Row label={t("硬件并发数")}>
        <Select
          disabled={hostMatched}
          className="fb-fp-select"
          value={fp.overrides?.includes('cores') ? fp.hardwareConcurrency : 'template'}
          onChange={chooseCores}
          aria-label={t("硬件并发数")}
          options={[
            { value: 'template', label: t("跟随硬件配置（{0} 核）", selectedHardware?.hardwareConcurrency ?? fp.hardwareConcurrency) },
            ...CORE_OPTIONS.map((value) => ({ value, label: t("{0} 核", value) }))
          ]}
        />
      </Row>
      <Row label={t("设备内存")} hint={t("浏览器最多报告 8 GB；需要自编译内核（补丁 045）才生效")}>
        <Select
          className="fb-fp-select"
          value={fp.deviceMemory ?? 8}
          onChange={(value: 2 | 4 | 8) => patchFingerprint({ deviceMemory: value })}
          options={[2, 4, 8].map((value) => ({ value, label: `${value} GB` }))}
        />
      </Row>
      <Row label={t("设备名称")}>
        <Unsupported value={t("随机")} reason={kernelUnsupported} />
      </Row>
      <Row label={t("MAC 地址")}>
        <Unsupported value={t("随机")} reason={kernelUnsupported} />
      </Row>

      <h3 className="fb-fp-group">{t("其他")}</h3>
      <Row label="Do Not Track">
        <Select
          className="fb-fp-select"
          value={fp.doNotTrack ?? 'default'}
          onChange={(doNotTrack) => patchFingerprint({ doNotTrack })}
          options={[{ value: 'default', label: t("默认") }, { value: 'on', label: t("开启") }, { value: 'off', label: t("关闭") }]}
        />
      </Row>
      <Row label={t("端口扫描保护")}>
        <Unsupported value={t("开启")} reason={kernelUnsupported} />
      </Row>
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
