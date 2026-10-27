import { message } from 'antd'
import type { MessageInstance } from 'antd/es/message/interface'
import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { getLocale, subscribeLocale } from '../../../shared/i18n'
import { applyThemePreference } from '../theme'
import type {
  AppPreferences,
  AppRecoveryStatus, BrowserExtension, BrowserProfileView, EngineStatus, GroupRecordView, KernelRelease, ProfileStoreHealth, ProxyRecordView
} from '../../../shared/types'
import { humanError } from '../components/format'

/**
 * Everything the pages share, loaded once: windows, the proxy and group libraries, kernels
 * and extensions. Pages read it with useWorkspace() instead of calling the main process for
 * the same data, so a change made on one page shows on every page.
 */
export interface Workspace {
  locale: string
  loading: boolean
  profiles: BrowserProfileView[]
  /** Proxy library; profileIds is worked out from the windows, never stored twice. */
  proxies: ProxyRecordView[]
  /** Group library; profileCount is worked out from the windows. */
  groups: GroupRecordView[]
  engine: EngineStatus | null
  /** Installed kernels, plus the bundled one. */
  kernels: KernelRelease[]
  extensions: BrowserExtension[]
  storageHealth: ProfileStoreHealth | null
  recovery: AppRecoveryStatus | null
  /** Settings-page choices (theme, batch open gap). */
  preferences: AppPreferences
  setPreferences: (patch: Partial<AppPreferences>) => Promise<void>
  notify: MessageInstance
  upsertProfiles: (profiles: BrowserProfileView[]) => void
  dropProfiles: (ids: string[]) => void
  reloadProfiles: () => Promise<void>
  reloadLibraries: () => Promise<void>
  setEngine: (engine: EngineStatus) => void
  reloadKernels: () => Promise<void>
  setExtensions: (extensions: BrowserExtension[]) => void
  /** Whether the window's kernel is available to launch it. */
  canLaunch: (profile: BrowserProfileView) => boolean
  /** Shows a main-process error as a message. */
  fail: (error: unknown, seconds?: number) => void
}

const WorkspaceContext = createContext<Workspace | null>(null)

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return workspace
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale)
  const [notify, contextHolder] = message.useMessage()
  const [loading, setLoading] = useState(true)
  const [profiles, setProfiles] = useState<BrowserProfileView[]>([])
  const [proxyRecords, setProxyRecords] = useState<ProxyRecordView[]>([])
  const [groupRecords, setGroupRecords] = useState<GroupRecordView[]>([])
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [bundledEngine, setBundledEngine] = useState<EngineStatus | null>(null)
  const [installedKernels, setInstalledKernels] = useState<KernelRelease[]>([])
  const [extensions, setExtensions] = useState<BrowserExtension[]>([])
  const [storageHealth, setStorageHealth] = useState<ProfileStoreHealth | null>(null)
  const [recovery, setRecovery] = useState<AppRecoveryStatus | null>(null)
  const [preferences, setPreferenceState] = useState<AppPreferences>({ theme: 'light', batchLaunchGapSeconds: 1.5 })

  const fail = useCallback((error: unknown, seconds?: number) => { notify.error(humanError(error), seconds) }, [notify])

  const reloadLibraries = useCallback(async () => {
    const [proxies, groups] = await Promise.all([window.browserApi.proxy.list(), window.browserApi.groups.list()])
    setProxyRecords(proxies)
    setGroupRecords(groups)
  }, [])

  const reloadProfiles = useCallback(async () => {
    setProfiles(await window.browserApi.profiles.list())
  }, [])

  const reloadKernels = useCallback(async () => {
    setInstalledKernels(await window.browserApi.engine.installed())
  }, [])

  useEffect(() => {
    void Promise.all([
      window.browserApi.profiles.list(),
      window.browserApi.engine.status(),
      window.browserApi.extensions.list(),
      window.browserApi.profiles.storageHealth(),
      window.browserApi.engine.installed(),
      window.browserApi.engine.bundled(),
      window.browserApi.diagnostics.sessionHealth(),
      window.browserApi.app.preferences(),
      reloadLibraries()
    ])
      .then(([items, engineStatus, extensionItems, health, installed, bundled, recoveryStatus, savedPreferences]) => {
        setPreferenceState(savedPreferences)
        setProfiles(items)
        setEngine(engineStatus)
        setExtensions(extensionItems)
        setStorageHealth(health)
        setInstalledKernels(installed)
        setBundledEngine(bundled)
        setRecovery(recoveryStatus)
      })
      .catch(fail)
      .finally(() => setLoading(false))
    return window.browserApi.profiles.onChanged((changed) => {
      // A window can also arrive this way: pulled down from the cloud.
      setProfiles((current) => current.some((profile) => profile.id === changed.id)
        ? current.map((profile) => profile.id === changed.id ? changed : profile)
        : [changed, ...current])
    })
  }, [fail, reloadLibraries])

  const upsertProfiles = useCallback((changed: BrowserProfileView[]) => {
    setProfiles((current) => {
      const byId = new Map(changed.map((profile) => [profile.id, profile]))
      const updated = current.map((profile) => byId.get(profile.id) ?? profile)
      const added = changed.filter((profile) => !current.some((item) => item.id === profile.id))
      return [...added, ...updated]
    })
  }, [])

  const dropProfiles = useCallback((ids: string[]) => {
    const removed = new Set(ids)
    setProfiles((current) => current.filter((profile) => !removed.has(profile.id)))
  }, [])

  // A saved window may have added a typed proxy or a new group to a library.
  useEffect(() => {
    const proxyIds = new Set(proxyRecords.map((proxy) => proxy.id))
    const groupIds = new Set(groupRecords.map((group) => group.id))
    if (profiles.some((profile) => (profile.proxyId && !profile.proxyMissing && !proxyIds.has(profile.proxyId))
      || (profile.groupId && !groupIds.has(profile.groupId)))) {
      void reloadLibraries().catch(fail)
    }
  }, [profiles, proxyRecords, groupRecords, reloadLibraries, fail])

  const proxies = useMemo(() => proxyRecords.map((proxy) => ({
    ...proxy,
    profileIds: profiles.filter((profile) => profile.proxyId === proxy.id).map((profile) => profile.id)
  })), [proxyRecords, profiles])

  const groups = useMemo(() => groupRecords.map((group) => ({
    ...group,
    profileCount: profiles.filter((profile) => profile.groupId === group.id).length
  })), [groupRecords, profiles])

  const kernels = useMemo(() => {
    if (!bundledEngine?.version || !bundledEngine.executable || installedKernels.some((kernel) => kernel.version === bundledEngine.version)) {
      return installedKernels
    }
    return [{
      version: bundledEngine.version,
      publishedAt: '',
      assetName: 'bundled-with-prism',
      downloadUrl: '',
      size: 0,
      sha256: '',
      installed: true,
      remoteAvailable: false,
      origin: 'bundled' as const,
      executable: bundledEngine.executable
    }, ...installedKernels]
  }, [bundledEngine, installedKernels])

  const canLaunch = useCallback((profile: BrowserProfileView) => {
    if (profile.proxyMissing) return false
    if (!profile.kernelVersion) return Boolean(engine?.executable)
    return kernels.some((kernel) => kernel.version === profile.kernelVersion && kernel.executable)
  }, [engine, kernels])

  const setPreferences = useCallback(async (patch: Partial<AppPreferences>) => {
    const saved = await window.browserApi.app.setPreferences(patch)
    setPreferenceState(saved)
    if (patch.theme) applyThemePreference(saved.theme)
  }, [])

  const value: Workspace = {
    locale, loading, profiles, proxies, groups, engine, kernels, extensions, storageHealth, recovery, preferences, setPreferences, notify,
    upsertProfiles, dropProfiles, reloadProfiles, reloadLibraries, setEngine, reloadKernels, setExtensions, canLaunch, fail
  }
  return (
    <WorkspaceContext.Provider value={value}>
      {contextHolder}
      {children}
    </WorkspaceContext.Provider>
  )
}
