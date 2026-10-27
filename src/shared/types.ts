import type { UiLocale } from './i18n'
import type { FontPackProgress, FontPackStatus } from './windows-font-packs'
export type BrowserPlatform = 'windows' | 'macos'
export type BrowserBrand = 'Chrome' | 'Edge'
export type HardwareProfileId =
  | 'legacy-custom'
  | 'macos-host'
  | 'macos-seeded-apple'
  | 'macos-m1'
  | 'macos-m3-pro'
  | 'macos-m4-pro'
  | 'windows-host'
  | 'windows-seeded-nvidia'
  | 'windows-10-rtx3060'
  | 'windows-11-rtx4060'
  | 'windows-11-rtx4070'
export type ProxyProtocol = 'direct' | 'http' | 'https' | 'socks5'
/**
 * 替换 (proxy_only): WebRTC through the proxy (UDP relay on prism7+ when the proxy relays UDP,
 * otherwise the proxy's address is reported without sending UDP); 隐私 (privacy): WebRTC on but no
 * address at all; 允许 (default): Chrome as is; 禁止 (disabled): no RTCPeerConnection (prism7+).
 */
export type WebRtcPolicy = 'proxy_only' | 'privacy' | 'default' | 'disabled'
export type NetworkIdentityMode = 'manual' | 'proxy'
export type ProxyExitPolicy = 'warn' | 'block'
export type ProfileStatus = 'closed' | 'starting' | 'running' | 'stopping' | 'orphaned' | 'error'
export interface ProfileLaunchOptions {
  allowGeoConflict?: boolean
}
export type EnginePreference = 'auto' | 'bundled' | 'system'
export interface ProfileWindowConfig {
  mode: 'auto' | 'custom'
  x: number
  y: number
  width: number
  height: number
}

export interface ProxyConfig {
  protocol: ProxyProtocol
  host: string
  port?: number
  username: string
  password: string
  passwordStored?: boolean
}

/** Login the window is used for. The password is encrypted at rest and never sent to the UI. */
export interface PlatformAccount {
  platform: string
  username: string
  password: string
  passwordStored?: boolean
}

export interface FingerprintConfig {
  seed: number
  hardwareProfileId: HardwareProfileId
  /** Picked GPU (key from gpu-catalog: model|deviceId). Unset = the kernel picks one by seed. */
  gpu?: string
  /**
   * Desktop CPU model (key from cpu-catalog). Pages cannot read it; when set, hardwareConcurrency
   * is its thread count.
   */
  cpu?: string
  /** Shown in the editor only (web pages cannot read it); unset = derived from the seed. */
  deviceName?: string
  /** Shown in the editor only (web pages cannot read it), e.g. 7A:C5:6F:F2:C2:84; unset = derived from the seed. */
  macAddress?: string
  /** Old saves only: position in the 139–144 GPU list. Turned into `gpu` when read. */
  gpuBucket?: number
  /**
   * navigator.deviceMemory in GB. Unset = 8. 16 and 32 only exist from Chromium 147; older
   * kernels are given at most 8 (see maxDeviceMemoryGb).
   */
  deviceMemory?: DeviceMemoryGb
  /** Version of the render identity allocation contract. */
  renderIdentityVersion?: 1 | 2 | 3 | 4
  platform: BrowserPlatform
  platformVersion: string
  brand: BrowserBrand
  brandVersion: string
  hardwareConcurrency: number
  language: string
  acceptLanguages: string
  timezone: string
  /** Country (ISO 3166) the language and time zone were picked for, by hand. Unset on older profiles. */
  region?: string
  webrtcPolicy: WebRtcPolicy
  networkIdentityMode: NetworkIdentityMode
  proxyExitPolicy: ProxyExitPolicy
  screenWidth: number
  screenHeight: number
  disabledSpoofing: Array<'font' | 'audio' | 'canvas' | 'clientrects' | 'gpu'>
  /**
   * Values the user set by hand that the hardware template must not overwrite.
   * Missing on older profiles, which keep following their template exactly.
   */
  overrides?: FingerprintOverride[]
  /** 'host' reports this computer's real CPU core count at launch. Default: the stored count. */
  coresSource?: 'profile' | 'host'
  /** 'host' reports the real primary display size at launch. Default: the stored size. */
  screenSource?: 'profile' | 'host'
  /** Default geolocation permission for sites. Default: ask. */
  geolocationPermission?: 'ask' | 'allow' | 'block'
  /** Do Not Track request header. Default: leave Chromium's own setting. */
  doNotTrack?: 'default' | 'on' | 'off'
  /** Chrome's Local Network Access checks (pages need permission to reach this computer and the LAN). Default: on. */
  portScanProtection?: boolean
  /** Windows voices of another locale (e.g. "zh-hk"). Unset = the window's language. */
  voicesLocale?: string
  /** "auto" (unset, from the seed), "real", or "microphones,speakers,cameras". */
  mediaDevices?: string
  /** Language of the media device names (e.g. "de-de"). Unset = the window's language. */
  mediaLocale?: string
  /** Chrome interface language (a CHROME_UI_LOCALES entry). Unset = the one Chrome picks for the language. */
  uiLocale?: string
}

export type FingerprintOverride = 'screen' | 'cores' | 'platformVersion'

/**
 * A proxy in the proxy library. It is stored once; windows refer to it by id,
 * so editing it here changes every window that uses it.
 */
export interface ProxyRecord {
  id: string
  protocol: Exclude<ProxyProtocol, 'direct'>
  host: string
  port: number
  username: string
  /** Encrypted at rest and never sent to the UI. */
  password: string
  note: string
  createdAt: string
  updatedAt: string
  /** Latest check of this proxy, shared by every window that uses it. */
  check?: ProxyCheckSummary
}

export type ProxyRecordView = Omit<ProxyRecord, 'password'> & {
  password: ''
  passwordStored: boolean
  /** Windows that use this proxy, derived from the windows' proxyId. */
  profileIds: string[]
}

export interface ProxyDraft {
  protocol: Exclude<ProxyProtocol, 'direct'>
  host: string
  port?: number
  username: string
  password: string
  /** Keep the saved password when password is empty. */
  passwordStored?: boolean
  note?: string
}

/** A window group. Windows refer to it by id, so renaming it renames it everywhere. */
export interface GroupRecord {
  id: string
  name: string
  /** Marker colour of the group (user data). */
  color: string
  note: string
  createdAt: string
}

export interface GroupDraft {
  name: string
  color?: string
  note?: string
}

export type GroupRecordView = GroupRecord & { profileCount: number }

export interface BrowserProfile {
  id: string
  /** Permanent, user-facing environment number. Never reused after deletion. */
  serialNumber: number
  name: string
  note: string
  /** Reference into the group library; '' means ungrouped. */
  groupId: string
  /** Name of the referenced group, filled in when the window is read; never stored on the window. */
  group: string
  tags: string[]
  extensionIds: string[]
  color: string
  startUrls: string[]
  /** Older profiles default to opening their configured URLs. */
  startupMode?: 'urls' | 'restore'
  /** Empty means follow the globally selected/default engine. */
  kernelVersion: string
  window: ProfileWindowConfig
  favorite: boolean
  /** Reference into the proxy library; '' means direct connection. */
  proxyId: string
  /** The referenced proxy, filled in when the window is read; never stored on the window. */
  proxy: ProxyConfig
  /** True when proxyId points at a proxy that no longer exists. Such a window must not launch. */
  proxyMissing?: boolean
  account: PlatformAccount
  fingerprint: FingerprintConfig
  createdAt: string
  updatedAt: string
  lastOpenedAt?: string
  /** Latest check of the window's network: the library proxy's check, or the direct connection's own. */
  proxyCheck?: ProxyCheckSummary
  status: ProfileStatus
  lastError?: string
}

export interface PublicProxyConfig extends Omit<ProxyConfig, 'password' | 'passwordStored'> {
  password: ''
  passwordStored: boolean
}

export interface PublicPlatformAccount extends Omit<PlatformAccount, 'password' | 'passwordStored'> {
  password: ''
  passwordStored: boolean
}

export type BrowserProfileView = Omit<BrowserProfile, 'proxy' | 'account'> & { proxy: PublicProxyConfig; account: PublicPlatformAccount }

/**
 * What a window is created or edited from.
 * group: a group name; it is looked up in (or added to) the group library.
 * proxyId: pick a proxy from the library. Without it, proxy is looked up in (or added to)
 * the library, so a proxy is never stored on the window itself.
 */
export type ProfileDraft = Pick<
  BrowserProfile,
  'name' | 'note' | 'group' | 'tags' | 'extensionIds' | 'color' | 'startUrls' | 'startupMode' | 'kernelVersion' | 'window' | 'proxy' | 'fingerprint'
> & {
  /** Optional on input for older callers and files; validation fills an empty account. */
  account?: PlatformAccount
  proxyId?: string
}

export interface ProfileBatchClassification {
  group?: string
  addTags?: string[]
}

export interface BrowserExtension {
  id: string
  name: string
  version: string
  description: string
  manifestVersion: 2 | 3
  installedAt: string
  path: string
  /** Loads this extension in every profile in addition to profile-specific selections. */
  globalEnabled: boolean
}

export interface AppSettings extends AppPreferences {
  browserExecutable: string
  fingerprintKernel: boolean
  enginePreference: EnginePreference
  recycleRetentionDays: 0 | 7 | 30 | 90
  /** GitHub projects ("owner/repo") that "在线下载内核" lists kernels from. */
  kernelSources: string[]
}

/** Interface choices from the settings page. */
export interface AppPreferences {
  /** 'system' follows the operating system's light / dark setting. */
  theme: 'light' | 'dark' | 'system'
  /** Pause between windows opened in one batch. */
  batchLaunchGapSeconds: number
}

export interface AppInfo {
  version: string
  vaultPath: string
  logsPath: string
}

/** The newest release of this app on GitHub, compared with the running version. */
export interface AppUpdateInfo {
  current: string
  latest?: string
  /** A newer version with a verifiable Windows exe exists. */
  available: boolean
  /** Release notes as written on the release page (Markdown). */
  notes?: string
  publishedAt?: string
  pageUrl?: string
  size?: number
  /** The newer exe is already downloaded and checked. */
  downloaded?: boolean
  /** One-click install works (the installed Windows app); otherwise download from the page. */
  canInstall: boolean
}

export interface AppUpdateProgress {
  version: string
  receivedBytes: number
  totalBytes: number
  done?: boolean
}

export interface EngineStatus {
  executable: string | null
  source: 'configured' | 'profile' | 'bundled' | 'system' | 'missing'
  fingerprintKernel: boolean
  label: string
  version?: string
  /** The kernel keeps its window inside a claimed screen, so the claim may be smaller than the real one. */
  windowScreen?: boolean
  /** The kernel can send WebRTC UDP through the launcher's relay and remove WebRTC (prism7+). */
  webrtcRelay?: boolean
}

export interface KernelImportResult {
  /** Id the build was installed under (with an import-time suffix when the version was already installed). */
  version: string
  /** The very same build was already installed; nothing was copied. */
  alreadyInstalled: boolean
  /** It became the default kernel because there was no usable default. */
  madeDefault: boolean
  engine: EngineStatus
}

export interface KernelRelease {
  version: string
  publishedAt: string
  assetName: string
  downloadUrl: string
  size: number
  sha256: string
  installed: boolean
  remoteAvailable: boolean
  origin?: 'release' | 'local-build' | 'bundled'
  executable?: string
  /** GitHub project ("owner/repo") a downloadable release comes from. */
  source?: string
  tag?: string
  /** A newer build of this installed kernel; installing it replaces the kernel in place. */
  update?: boolean
  /** See EngineStatus.windowScreen. */
  windowScreen?: boolean
  /** See EngineStatus.webrtcRelay. */
  webrtcRelay?: boolean
  /** An older build of its version, offered for rolling back; installing it replaces the kernel in place. */
  history?: boolean
}

export type KernelInstallStage = 'downloading' | 'verifying' | 'installing' | 'ready' | 'cancelled' | 'error'

export interface KernelInstallProgress {
  version: string
  stage: KernelInstallStage
  receivedBytes: number
  totalBytes: number
  percent: number
  message: string
}

export interface KernelHealth {
  version: string
  status: 'healthy' | 'unverified' | 'corrupt'
  message: string
  checkedAt: string
}

export interface ProxyTestResult {
  ok: boolean
  ip?: string
  /** SOCKS5 only, from the editor's test: whether the proxy relays UDP (WebRTC 替换 on prism7+). */
  udp?: boolean
  latencyMs: number
  error?: string
  warning?: string
  degraded?: boolean
  country?: string
  countryCode?: string
  latitude?: number
  longitude?: number
  accuracyMeters?: number
  ipVersion?: 4 | 6
  region?: string
  city?: string
  timezone?: string
  asn?: number
  organization?: string
  isp?: string
  networkRisk?: 'tor' | 'vpn' | 'proxy' | 'hosting'
  geoConfidence?: 'consensus' | 'single-source' | 'conflict'
  geoSources?: string[]
  geoConflict?: string
  failureKind?: 'authentication' | 'timeout' | 'connection' | 'unknown'
  retried?: boolean
  exitChanged?: boolean
  previousIp?: string
}

export interface ProxyCheckSummary extends ProxyTestResult {
  checkedAt: string
}

/** Which editor row a fingerprint check result belongs to. */
export type FingerprintCheckRow =
  | 'system' | 'platformVersion' | 'timezone' | 'language' | 'webrtc' | 'screen' | 'font'
  | 'gpu' | 'cores' | 'memory' | 'canvas' | 'audio' | 'clientrects' | 'general'

/** One-click fixes the editor can apply for a result. */
export type FingerprintCheckFix = 'follow-ip' | 'webrtc-replace' | 'reseed' | 'shuffle-gpu' | 'use-real'

export interface FingerprintCheckItem {
  row: FingerprintCheckRow
  status: 'ok' | 'warn' | 'bad'
  /** Chinese source text, translated in the renderer. */
  message: string
  fix?: FingerprintCheckFix
}

/** What the page inside the checked browser actually saw. */
export interface FingerprintObserved {
  userAgent: string
  uaPlatform?: string
  uaPlatformVersion?: string
  cores: number
  memory?: number
  screen: [number, number]
  timezone: string
  language: string
  webdriver: boolean
  webglVendor?: string
  webglRenderer?: string
  webgpuVendor?: string
  /** Each surface is read twice: real hardware gives the same result both times. */
  canvas: [string, string]
  /** The audio sample sum detection sites show, e.g. 124.04347527516074. */
  audio: [string, string]
  clientrects: [string, string]
  font: [string, string]
  worker?: { userAgent: string; cores: number; language: string; timezone: string }
  webrtcIps: string[]
}

export interface FingerprintCheckReport {
  checkedAt: string
  kernelVersion?: string
  /** The fingerprint settings that were checked, to tell when the editor has changed since. */
  checkedSettings: string
  exitIp?: string
  observed: FingerprintObserved
  items: FingerprintCheckItem[]
}

export interface ProfileStorageInfo {
  path: string
  totalBytes: number
  cacheBytes: number
}

export interface StorageOverview {
  profilesBytes: number
  cacheBytes: number
  recycleBytes: number
  kernelsBytes: number
  downloadsBytes: number
  extensionsBytes: number
  totalBytes: number
}

export interface ProfileBackupResult {
  path: string
  totalBytes: number
  fileCount: number
}

export interface WorkspaceMigrationResult {
  path: string
  profileCount: number
  importedCount: number
  skippedCount: number
  renamedCount: number
  extensionCount: number
  totalBytes: number
  fileCount: number
}

export interface DeletedProfileSummary {
  trashId: string
  profileId: string
  serialNumber?: number
  name: string
  /** Group the window was in when it was deleted. */
  group?: string
  deletedAt: string
  sizeBytes: number
}

export interface CookieTransferResult {
  count: number
  filePath: string
}

export interface ProfileStoreHealth {
  recoveredFromBackup: boolean
  recoveryMessage?: string
  corruptFilePath?: string
  backupHealthy: boolean
  backupError?: string
}

export type LaunchDiagnosticStatus = 'pass' | 'warning' | 'error'

export interface LaunchDiagnosticCheck {
  key: string
  label: string
  status: LaunchDiagnosticStatus
  message: string
}

export interface LaunchDiagnosticReport {
  profileId: string
  checkedAt: string
  ready: boolean
  checks: LaunchDiagnosticCheck[]
}

export interface AppRecoveryStatus {
  previousUnclean: boolean
  previousStartedAt?: string
  markerCorrupt: boolean
  uncleanSessionCount: number
}

export interface BrowserCrashRecord {
  occurredAt: string
  pid?: number
  code: number | null
  signal: NodeJS.Signals | null
  phase: 'starting' | 'running'
  /** Kernel version the window ran on. */
  kernelVersion?: string
  /** Launch log of this run (Chromium's --log-file). */
  logFile?: string
  /** The log line that names why the kernel stopped (Check failed, FATAL, ...). */
  reason?: string
  /** Last lines of the log before the exit. */
  logTail?: string[]
  /** Crashpad dumps written during this run. */
  dumps?: string[]
  /** The kernel's command line for this run. */
  args?: string[]
}

export interface BrowserLaunchLog {
  text: string
  truncated: boolean
  files: string[]
}

export interface BatchImportRowView {
  line: number
  name: string
  group: string
  /** Proxy with the password masked; '' means direct. */
  proxy: string
  account: string
  cookie: boolean
  /** Source-language messages; empty when the row will be imported. */
  errors: string[]
}

export interface BatchImportPreview {
  token: string
  fileName: string
  valid: number
  invalid: number
  rows: BatchImportRowView[]
}

export interface BatchImportOptions {
  /** Group for rows that leave the group column empty; '' keeps them ungrouped. */
  defaultGroup: string
}

export interface BatchImportResult {
  created: BrowserProfileView[]
  skipped: number
  cookiesImported: number
  cookieErrors: Array<{ name: string; message: string }>
}

export interface BrowserApi {
  uiLanguage: {
    get(): Promise<UiLocale>
    set(locale: UiLocale): Promise<UiLocale>
  }
  app: {
    preferences: () => Promise<AppPreferences>
    setPreferences: (patch: Partial<AppPreferences>) => Promise<AppPreferences>
    info: () => Promise<AppInfo>
    openFolder: (folder: 'vault' | 'logs') => Promise<void>
    openProjectPage: () => Promise<void>
    vaultLocation: () => Promise<VaultLocationInfo>
    /** Opens a folder picker, copies the data there and restarts; null when cancelled. */
    relocateVault: () => Promise<string | null>
    deletePreviousVault: () => Promise<VaultLocationInfo>
    revertVault: () => Promise<void>
    onRelocateProgress: (listener: (progress: RelocateProgress) => void) => () => void
    checkUpdate: () => Promise<AppUpdateInfo>
    downloadUpdate: () => Promise<AppUpdateInfo>
    /** Quits, replaces the exe with the downloaded one and starts it again. */
    installUpdate: () => Promise<void>
    openUpdatePage: () => Promise<void>
    onUpdateProgress: (listener: (progress: AppUpdateProgress) => void) => () => void
    /** Windows language font packages on this computer. */
    fontPacks: () => Promise<FontPackStatus>
    /** Downloads packages from Microsoft and installs them for this user (all missing ones by default). */
    installFontPacks: (scripts?: string[]) => Promise<FontPackStatus>
    onFontPackProgress: (listener: (progress: FontPackProgress) => void) => () => void
  }
  profiles: {
    list: () => Promise<BrowserProfileView[]>
    create: (draft: ProfileDraft) => Promise<BrowserProfileView>
    update: (id: string, draft: ProfileDraft) => Promise<BrowserProfileView>
    duplicate: (id: string) => Promise<BrowserProfileView>
    exportConfig: (id: string) => Promise<string | null>
    importConfig: () => Promise<BrowserProfileView | null>
    /** Reads a spreadsheet (picked in a dialog when no path is given) and checks each row. */
    previewBatchImport: (path?: string) => Promise<BatchImportPreview | null>
    commitBatchImport: (token: string, options: BatchImportOptions) => Promise<BatchImportResult>
    saveBatchImportErrors: (token: string) => Promise<string | null>
    exportBatchTemplate: (format: 'xlsx' | 'csv') => Promise<string | null>
    /** Local path of a file dropped onto the window. */
    pathForFile: (file: File) => string
    storageHealth: () => Promise<ProfileStoreHealth>
    storageInfo: (id: string) => Promise<ProfileStorageInfo>
    storageOverview: () => Promise<StorageOverview>
    openDataFolder: (id: string) => Promise<void>
    clearCache: (id: string) => Promise<ProfileStorageInfo>
    /** Starts the draft's exact browser setup in a throwaway profile and reports what a site sees. */
    checkFingerprint: (draft: ProfileDraft, profileId?: string, settingsKey?: string) => Promise<FingerprintCheckReport>
    /** Opens public detection sites in a throwaway browser with these settings; results stream in by site. */
    deepCheck: (draft: ProfileDraft, profileId?: string) => Promise<import('./deep-check').DeepSiteResult[]>
    onDeepCheckProgress: (listener: (result: import('./deep-check').DeepSiteResult) => void) => () => void
    /** Last saved check of a window, or null. */
    lastFingerprintCheck: (id: string) => Promise<FingerprintCheckReport | null>
    exportBackup: (id: string) => Promise<ProfileBackupResult | null>
    importBackup: () => Promise<{ profile: BrowserProfileView; result: ProfileBackupResult } | null>
    exportWorkspace: (password: string) => Promise<WorkspaceMigrationResult | null>
    importWorkspace: (password: string, conflictPolicy: 'rename' | 'skip') => Promise<WorkspaceMigrationResult | null>
    trash: () => Promise<DeletedProfileSummary[]>
    restore: (trashId: string) => Promise<BrowserProfileView>
    purgeTrash: (trashId: string) => Promise<void>
    emptyTrash: () => Promise<number>
    recycleRetention: () => Promise<AppSettings['recycleRetentionDays']>
    setRecycleRetention: (days: AppSettings['recycleRetentionDays']) => Promise<AppSettings['recycleRetentionDays']>
    exportCookies: (id: string) => Promise<CookieTransferResult | null>
    importCookies: (id: string) => Promise<CookieTransferResult | null>
    remove: (id: string) => Promise<void>
    launch: (id: string, options?: ProfileLaunchOptions) => Promise<BrowserProfileView>
    close: (id: string) => Promise<BrowserProfileView>
    closeAll: () => Promise<void>
    testProxy: (id: string) => Promise<BrowserProfileView>
    diagnose: (id: string) => Promise<LaunchDiagnosticReport>
    crashHistory: (id: string) => Promise<BrowserCrashRecord[]>
    /** Text of a launch log listed in the crash history. */
    readLaunchLog: (id: string, logFile: string) => Promise<BrowserLaunchLog>
    /** Shows the window's launch log folder (or one file in it) in the file manager. */
    openLaunchLogFolder: (id: string, logFile?: string) => Promise<void>
    setFavorite: (id: string, favorite: boolean) => Promise<BrowserProfileView>
    classifyMany: (ids: string[], patch: ProfileBatchClassification) => Promise<BrowserProfileView[]>
    /** Point windows at a library proxy or group ('' = direct / ungrouped). The one way to assign. */
    assignMany: (ids: string[], patch: { proxyId?: string; groupId?: string; followProxyIdentity?: boolean; extensionId?: string; removeExtension?: boolean }) => Promise<BrowserProfileView[]>
    /** Pin windows to an installed kernel version, or '' to follow the default kernel. */
    setKernelMany: (ids: string[], kernelVersion: string) => Promise<BrowserProfileView[]>
    /** Import pasted cookie JSON (same formats as the cookie file import); the window must be closed. */
    importCookiesText: (id: string, text: string) => Promise<{ count: number }>
    removeMany: (ids: string[]) => Promise<void>
    onChanged: (listener: (profile: BrowserProfileView) => void) => () => void
  }
  engine: {
    status: () => Promise<EngineStatus>
    bundled: () => Promise<EngineStatus | null>
    activateBundled: () => Promise<EngineStatus>
    select: () => Promise<EngineStatus>
    importLocal: () => Promise<KernelImportResult | null>
    useSystem: () => Promise<EngineStatus>
    installed: () => Promise<KernelRelease[]>
    activate: (version: string) => Promise<EngineStatus>
    rollbackAvailable: () => Promise<boolean>
    rollback: () => Promise<EngineStatus>
    remove: (version: string) => Promise<void>
    verify: (version: string) => Promise<KernelHealth>
    /** Kernels published by fingerprint-chromium for this system (plus installed ones). */
    releases: () => Promise<KernelRelease[]>
    sources: () => Promise<string[]>
    setSources: (sources: string[]) => Promise<string[]>
    /** Downloads, checks and installs a published kernel, then makes it the default. */
    install: (version: string, tag?: string) => Promise<EngineStatus>
    cancelInstall: (version: string) => Promise<void>
    onProgress: (listener: (progress: KernelInstallProgress) => void) => () => void
  }
  tunnel: {
    status: () => Promise<TunnelStatus>
    setEnabled: (enabled: boolean) => Promise<TunnelStatus>
    addSource: (input: { name: string; kind: 'links' | 'subscription'; content: string }) => Promise<TunnelStatus>
    source: (id: string) => Promise<TunnelSourceSummary & { content: string }>
    updateSource: (id: string, input: { name: string; kind: 'links' | 'subscription'; content: string }) => Promise<TunnelStatus>
    removeSource: (id: string) => Promise<TunnelStatus>
    select: (name: string) => Promise<TunnelStatus>
    autoSelect: () => Promise<TunnelStatus>
    test: () => Promise<TunnelStatus>
    refresh: () => Promise<TunnelStatus>
    onChanged: (listener: (status: TunnelStatus) => void) => () => void
  }
  /** The proxy library. Windows refer to these proxies by id. */
  proxy: {
    /** Tests typed-in settings; an empty password with passwordStored uses the saved one of the window or library proxy. */
    test: (config: ProxyConfig, profileId?: string, proxyId?: string) => Promise<ProxyTestResult>
    list: () => Promise<ProxyRecordView[]>
    create: (draft: ProxyDraft) => Promise<ProxyRecordView>
    /** Adds many at once; proxies already in the library are counted as duplicates. */
    createMany: (drafts: ProxyDraft[]) => Promise<{ created: ProxyRecordView[]; duplicates: number; errors: Array<{ index: number; message: string }> }>
    update: (id: string, draft: ProxyDraft) => Promise<ProxyRecordView>
    /** replaceWith: what the windows using it switch to (another proxy id, or '' for direct). */
    remove: (id: string, replaceWith?: string) => Promise<void>
    /** Tests a library proxy and saves the result on it. */
    check: (id: string) => Promise<ProxyRecordView>
  }
  /** The group library. Windows refer to these groups by id. */
  groups: {
    list: () => Promise<GroupRecordView[]>
    create: (draft: GroupDraft) => Promise<GroupRecordView>
    /** Rename, recolour or change the note; every window in it shows the change. */
    update: (id: string, draft: GroupDraft) => Promise<GroupRecordView>
    /** Its windows become ungrouped. */
    remove: (id: string) => Promise<void>
  }
  diagnostics: {
    sessionHealth: () => Promise<AppRecoveryStatus>
    e2eQuit: () => Promise<void>
  }
  extensions: {
    list: () => Promise<BrowserExtension[]>
    importDirectory: () => Promise<BrowserExtension | null>
    openSourceFolder: (id: string) => Promise<string>
    setGlobalEnabled: (id: string, enabled: boolean) => Promise<BrowserExtension>
    remove: (id: string) => Promise<void>
  }
  /** Team accounts (main/team): windows shared through the team server. */
  team: {
    status: () => Promise<import('./team').TeamStatus>
    /** Checks the saved sign-in with the server again (after it was unreachable). */
    retry: () => Promise<import('./team').TeamStatus>
    /** Checks the address; ready = the server already has an owner account. */
    probe: (server: string) => Promise<{ server: string; ready: boolean }>
    /** Creates the owner account with the server's setup code, then signs in. */
    setup: (server: string, code: string, username: string, name: string, password: string) => Promise<import('./team').TeamStatus>
    login: (server: string, username: string, password: string) => Promise<import('./team').TeamStatus>
    logout: () => Promise<import('./team').TeamStatus>
    members: () => Promise<import('./team').TeamUser[]>
    createMember: (draft: import('./team').TeamMemberDraft) => Promise<import('./team').TeamUser>
    updateMember: (id: string, draft: import('./team').TeamMemberDraft) => Promise<import('./team').TeamUser>
    removeMember: (id: string) => Promise<void>
    profiles: () => Promise<import('./team').TeamProfileView[]>
    links: () => Promise<import('./team').TeamLinkView[]>
    /** Owner: shares local windows with these members (already shared ones get the new members). */
    share: (ids: string[], assignees: string[]) => Promise<import('./team').TeamProfileView[]>
    updateProfile: (id: string, patch: import('./team').TeamProfilePatch) => Promise<void>
    unshare: (id: string) => Promise<void>
    forceUnlock: (id: string) => Promise<void>
    /** Puts a cloud window on this computer (also one deleted here before); returns its local id. */
    addToComputer: (id: string) => Promise<string>
    /** Pulls cloud windows missing here and puts this computer's new windows into the cloud. */
    sync: () => Promise<{ added: number; uploaded: number }>
    logs: (query: import('./team').TeamLogQuery) => Promise<import('./team').TeamLogPage>
    /** Server page (owner only). */
    serverInfo: () => Promise<import('./team').TeamServerInfo>
    backups: () => Promise<import('./team').TeamBackup[]>
    createBackup: () => Promise<{ key: string }>
    removeBackup: (key: string) => Promise<void>
    /** Asks where to save it; null when cancelled, otherwise the saved path. */
    downloadBackup: (key: string) => Promise<string | null>
    onSync: (listener: (event: import('./team').TeamSyncEvent) => void) => () => void
  }
}

/** Built-in tunnel (main/tunnel-manager.ts): how foreign window proxies are reached from China. */
export interface TunnelNodeInfo {
  name: string
  type: string
  sourceId?: string
  /** Last measured delay in ms; 0 = timed out; undefined = not measured. */
  delay?: number
}

export interface TunnelSourceSummary {
  id: string
  name: string
  kind: 'links' | 'subscription'
  updatedAt: string
}

export interface TunnelStatus {
  /** The tunnel core ships with the app; false in builds without it. */
  available: boolean
  enabled: boolean
  state: 'off' | 'starting' | 'running' | 'error'
  error?: string
  sources: TunnelSourceSummary[]
  nodes: TunnelNodeInfo[]
  selected?: string
  selectionMode: 'auto' | 'manual'
}

export interface VaultLocationInfo {
  path: string
  defaultPath: string
  /** The folder the data was moved from, kept until deleted. */
  previous?: string
}

export interface RelocateProgress {
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
}

/** Values desktop Chrome itself reports for navigator.deviceMemory (147+: 2/4/8/16/32). */
export type DeviceMemoryGb = 2 | 4 | 8 | 16 | 32
export const DEVICE_MEMORY_CHOICES: readonly DeviceMemoryGb[] = [2, 4, 8, 16, 32]
