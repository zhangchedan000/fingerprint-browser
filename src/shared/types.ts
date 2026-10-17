import type { UiLocale } from './i18n'
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
export type WebRtcPolicy = 'proxy_only' | 'public_only' | 'default'
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
  /** Old saves only: position in the 139–144 GPU list. Turned into `gpu` when read. */
  gpuBucket?: number
  /** navigator.deviceMemory in GB (2, 4 or 8). Unset = 8. Needs a kernel with patch 045. */
  deviceMemory?: 2 | 4 | 8
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
  'name' | 'note' | 'group' | 'tags' | 'extensionIds' | 'color' | 'startUrls' | 'kernelVersion' | 'window' | 'proxy' | 'fingerprint'
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

export interface EngineStatus {
  executable: string | null
  source: 'configured' | 'profile' | 'bundled' | 'system' | 'missing'
  fingerprintKernel: boolean
  label: string
  version?: string
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
    importLocal: () => Promise<EngineStatus>
    useSystem: () => Promise<EngineStatus>
    installed: () => Promise<KernelRelease[]>
    activate: (version: string) => Promise<EngineStatus>
    rollbackAvailable: () => Promise<boolean>
    rollback: () => Promise<EngineStatus>
    remove: (version: string) => Promise<void>
    verify: (version: string) => Promise<KernelHealth>
    /** Kernels published by fingerprint-chromium for this system (plus installed ones). */
    releases: () => Promise<KernelRelease[]>
    /** Downloads, checks and installs a published kernel, then makes it the default. */
    install: (version: string) => Promise<EngineStatus>
    cancelInstall: (version: string) => Promise<void>
    onProgress: (listener: (progress: KernelInstallProgress) => void) => () => void
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
}
