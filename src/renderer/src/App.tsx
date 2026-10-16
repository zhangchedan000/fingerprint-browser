import { LanguageSelector } from './LanguageSelector'
import { Sidebar, type SidebarTarget } from './Sidebar'
import { KernelSwitchModal } from './KernelSwitchModal'
import { t, getLocale, subscribeLocale, translateMessage as mt } from '../../shared/i18n'
import {
  ApiOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DownOutlined,
  EditOutlined,
  GlobalOutlined,
  MoreOutlined,
  PlusOutlined,
  PoweroffOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
  UploadOutlined,
  WarningFilled
} from '@ant-design/icons'
import {
  Alert,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Layout,
  message,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  type MenuProps,
  type TableColumnsType
} from 'antd'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AppRecoveryStatus, BrowserCrashRecord, BrowserExtension, BrowserProfileView, EngineStatus, KernelRelease, LaunchDiagnosticReport, ProfileDraft, ProfileStoreHealth, StorageOverview } from '../../shared/types'
import { ProfileEditor, type ProfileEditorExtras } from './ProfileEditor'
import { KernelManagerModal } from './KernelManagerModal'
import { ProfileDataModal } from './ProfileDataModal'
import { RecycleBinModal } from './RecycleBinModal'
import { ExtensionManagerModal } from './ExtensionManagerModal'
import { LaunchDiagnosticsModal } from './LaunchDiagnosticsModal'
import { CrashHistoryModal } from './CrashHistoryModal'
import { BatchResultModal, type BatchOperationResult } from './BatchResultModal'
import { WorkspaceMigrationModal } from './WorkspaceMigrationModal'
import { effectiveNetworkIdentity, geoConflictConfirmationMessage } from '../../shared/network-identity'
import { orderBatchLaunchProfiles, waitForBatchLaunchGap } from './batch-launch-order'
import { profileTableSorters } from './profile-table-sort'

const { Content } = Layout

type ListTab = 'all' | 'running' | 'favorites' | 'ungrouped' | 'attention'
const ACTIVE_STATUSES = new Set(['starting', 'running', 'stopping', 'orphaned'])

function humanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return mt(raw)
}

function statusDot(profile: BrowserProfileView) {
  const map = {
    closed: t("未运行"),
    starting: t("启动中"),
    running: t("运行中"),
    stopping: t("关闭中"),
    orphaned: t("进程遗留"),
    error: t("异常")
  } as const
  const label = map[profile.status]
  return (
    <Tooltip title={profile.lastError ? `${label} · ${mt(profile.lastError)}` : label}>
      <span className={`fb-status-dot ${profile.status}`} role="img" aria-label={label} />
    </Tooltip>
  )
}

function proxyCell(profile: BrowserProfileView) {
  if (profile.proxy.protocol === 'direct') {
    return (
      <div className="fb-proxy-cell">
        <div><span className="fb-cc muted">—</span><span>{t("直连")}</span></div>
        <small>{t("本机网络")}</small>
      </div>
    )
  }
  const check = profile.proxyCheck
  const protocol = profile.proxy.protocol.toUpperCase()
  const location = check?.ok ? check.city || check.country || '' : ''
  return (
    <div className="fb-proxy-cell">
      <div>
        <span className={`fb-cc${check?.ok && check.countryCode ? '' : ' muted'}`}>{check?.ok && check.countryCode ? check.countryCode : '—'}</span>
        <span className="fb-mono">{check?.ok && check.ip ? check.ip : `${profile.proxy.host}:${profile.proxy.port}`}</span>
      </div>
      <small className="fb-ellipsis" title={check?.ok ? [check.country, check.region, check.city].filter(Boolean).join(' · ') : undefined}>{protocol}{location ? ` · ${location}` : ''}</small>
      {check && !check.ok && <Tooltip title={mt(check.error ?? t("连接失败"))}><small className="fb-proxy-bad">{t("检测失败")}</small></Tooltip>}
      {!check && <small className="fb-proxy-unknown">{t("未检测")}</small>}
      {check?.exitChanged && <Tooltip title={t("出口 IP 与上次不同")}><small className="fb-proxy-warn">{t("出口变化")}</small></Tooltip>}
    </div>
  )
}

function majorVersion(version: string): string {
  return version.split('.')[0] || version
}

function relativeTime(iso: string | undefined, locale: string): string {
  if (!iso) return t("从未打开")
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return t("从未打开")
  const minutes = Math.floor((Date.now() - time) / 60_000)
  if (minutes < 1) return t("刚刚")
  if (minutes < 60) return t("{0} 分钟前", minutes)
  const date = new Date(time)
  const clock = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (time >= startOfToday) return t("今天 {0}", clock)
  if (time >= startOfToday - 86_400_000) return t("昨天 {0}", clock)
  return date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function App() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale)
  const [profiles, setProfiles] = useState<BrowserProfileView[]>([])
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [bundledEngine, setBundledEngine] = useState<EngineStatus | null>(null)
  const [kernels, setKernels] = useState<KernelRelease[]>([])
  const [loading, setLoading] = useState(true)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<BrowserProfileView | undefined>()
  const [editorOpen, setEditorOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [kernelManagerOpen, setKernelManagerOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectedGroup, setSelectedGroup] = useState('__all__')
  const [listTab, setListTab] = useState<ListTab>('all')
  const [kernelSwitchOpen, setKernelSwitchOpen] = useState(false)
  const [pageSize, setPageSize] = useState(20)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchResult, setBatchResult] = useState<BatchOperationResult>()
  const [dataProfile, setDataProfile] = useState<BrowserProfileView | undefined>()
  const [recycleBinOpen, setRecycleBinOpen] = useState(false)
  const [extensions, setExtensions] = useState<BrowserExtension[]>([])
  const [extensionManagerOpen, setExtensionManagerOpen] = useState(false)
  const [profileStorageHealth, setProfileStorageHealth] = useState<ProfileStoreHealth | null>(null)
  const [appRecoveryStatus, setAppRecoveryStatus] = useState<AppRecoveryStatus | null>(null)
  const [diagnosticProfile, setDiagnosticProfile] = useState<BrowserProfileView>()
  const [diagnosticReport, setDiagnosticReport] = useState<LaunchDiagnosticReport>()
  const [crashProfile, setCrashProfile] = useState<BrowserProfileView>()
  const [crashRecords, setCrashRecords] = useState<BrowserCrashRecord[]>([])
  const [crashHistoryLoading, setCrashHistoryLoading] = useState(false)
  const [batchClassificationOpen, setBatchClassificationOpen] = useState(false)
  const [batchGroupEnabled, setBatchGroupEnabled] = useState(false)
  const [batchGroup, setBatchGroup] = useState('')
  const [batchTags, setBatchTags] = useState('')
  const [storage, setStorage] = useState<StorageOverview>()
  const [migrationMode, setMigrationMode] = useState<'export' | 'import' | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  useEffect(() => {
    void Promise.all([
      window.browserApi.profiles.list(),
      window.browserApi.engine.status(),
      window.browserApi.extensions.list(),
      window.browserApi.profiles.storageHealth(),
      window.browserApi.engine.installed(),
      window.browserApi.engine.bundled(),
      window.browserApi.diagnostics.sessionHealth()
    ])
      .then(([items, engineStatus, extensionItems, storageHealth, installedKernels, bundled, recoveryStatus]) => {
        setProfiles(items)
        setEngine(engineStatus)
        setExtensions(extensionItems)
        setProfileStorageHealth(storageHealth)
        setKernels(installedKernels)
        setBundledEngine(bundled)
        setAppRecoveryStatus(recoveryStatus)
      })
      .catch((error) => messageApi.error(humanError(error)))
      .finally(() => setLoading(false))

    void refreshStorageOverview()

    const removeProfileListener = window.browserApi.profiles.onChanged((changed) => {
      setProfiles((current) => current.map((profile) => profile.id === changed.id ? changed : profile))
    })
    return () => {
      removeProfileListener()
    }
  }, [messageApi])

  const visibleProfiles = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const filtered = profiles.filter((profile) => {
      if (selectedGroup !== '__all__' && profile.group !== selectedGroup) return false
      if (listTab === 'favorites' && !profile.favorite) return false
      if (listTab === 'running' && !ACTIVE_STATUSES.has(profile.status)) return false
      if (listTab === 'ungrouped' && profile.group.trim()) return false
      if (listTab === 'attention' && !['orphaned', 'error'].includes(profile.status)) return false
      if (!normalized) return true
      return [String(profile.serialNumber), profile.name, profile.note, profile.group, ...profile.tags, profile.proxy.host, profile.fingerprint.timezone]
        .some((value) => value.toLowerCase().includes(normalized))
    })
    // Newest serial first, like the design; favourites stay on top. Column sorters override this.
    return [...filtered].sort((first, second) => {
      if (first.favorite !== second.favorite) return first.favorite ? -1 : 1
      return second.serialNumber - first.serialNumber
    })
  }, [profiles, query, selectedGroup, listTab])

  const tabCounts = useMemo(() => ({
    all: profiles.length,
    running: profiles.filter((profile) => ACTIVE_STATUSES.has(profile.status)).length,
    favorites: profiles.filter((profile) => profile.favorite).length,
    ungrouped: profiles.filter((profile) => !profile.group.trim()).length,
    attention: profiles.filter((profile) => profile.status === 'orphaned' || profile.status === 'error').length
  }), [profiles])

  const groupOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const profile of profiles) counts.set(profile.group, (counts.get(profile.group) ?? 0) + 1)
    return [
      { value: '__all__', label: t("全部分组 ({0})", profiles.length) },
      ...[...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b, locale))
        .map(([group, count]) => ({ value: group, label: `${group || t("未分组")} (${count})` }))
    ]
  }, [profiles, locale])
  const editableGroups = useMemo(() => [...new Set(profiles
    .map((profile) => profile.group.trim())
    .filter(Boolean))].sort((first, second) => first.localeCompare(second, locale)), [profiles, locale])

  function upsert(profile: BrowserProfileView): void {
    setProfiles((current) => {
      const exists = current.some((item) => item.id === profile.id)
      return exists ? current.map((item) => item.id === profile.id ? profile : item) : [profile, ...current]
    })
  }

  function canLaunchProfile(profile: BrowserProfileView): boolean {
    if (!profile.kernelVersion) return Boolean(engine?.executable)
    return selectableKernels.some((kernel) => kernel.version === profile.kernelVersion && kernel.executable)
  }

  const selectableKernels = useMemo(() => {
    if (!bundledEngine?.version || !bundledEngine.executable || kernels.some((kernel) => kernel.version === bundledEngine.version)) {
      return kernels
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
    }, ...kernels]
  }, [bundledEngine, kernels])

  async function refreshStorageOverview(): Promise<void> {
    try {
      setStorage(await window.browserApi.profiles.storageOverview())
    } catch (error) {
      messageApi.error(humanError(error))
    }
  }

  async function toggleFavorite(profile: BrowserProfileView): Promise<void> {
    try {
      upsert(await window.browserApi.profiles.setFavorite(profile.id, !profile.favorite))
    } catch (error) {
      messageApi.error(humanError(error))
    }
  }

  async function withBusy(id: string, action: () => Promise<unknown>): Promise<void> {
    setBusyIds((current) => new Set(current).add(id))
    try {
      await action()
    } catch (error) {
      messageApi.error(humanError(error))
    } finally {
      setBusyIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  function confirmGeoConflictLaunch(profile: BrowserProfileView, warning: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (value: boolean): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      Modal.confirm({
        title: t("#{0} {1} 的代理地区存在冲突", profile.serialNumber, profile.name),
        content: mt(warning),
        okText: t("了解风险，继续打开"),
        cancelText: t("取消"),
        okButtonProps: { danger: true },
        onOk: () => settle(true),
        onCancel: () => settle(false),
        afterClose: () => settle(false)
      })
    })
  }

  async function launchWithGeoConflictConfirmation(profile: BrowserProfileView): Promise<BrowserProfileView | undefined> {
    try {
      return await window.browserApi.profiles.launch(profile.id)
    } catch (error) {
      const warning = geoConflictConfirmationMessage(humanError(error))
      if (!warning) throw error
      if (!await confirmGeoConflictLaunch(profile, warning)) return undefined
      return window.browserApi.profiles.launch(profile.id, { allowGeoConflict: true })
    }
  }

  async function saveProfile(draft: ProfileDraft, extras: ProfileEditorExtras): Promise<void> {
    setSaving(true)
    try {
      const saved = editing
        ? await window.browserApi.profiles.update(editing.id, draft)
        : await window.browserApi.profiles.create(draft)
      upsert(saved)
      setEditorOpen(false)
      setEditing(undefined)
      messageApi.success(editing ? t("环境已更新") : t("环境已创建"))
      if (extras.cookieText.trim()) {
        try {
          const { count } = await window.browserApi.profiles.importCookiesText(saved.id, extras.cookieText)
          messageApi.success(t("已导入 {0} 条 Cookie", count))
        } catch (error) {
          messageApi.warning(t("窗口已保存，但 Cookie 导入失败：{0}", humanError(error)))
        }
      }
    } catch (error) {
      messageApi.error(humanError(error))
    } finally {
      setSaving(false)
    }
  }

  function openEditor(profile?: BrowserProfileView): void {
    setEditing(profile)
    setEditorOpen(true)
  }

  async function importProfile(): Promise<void> {
    setImporting(true)
    try {
      const imported = await window.browserApi.profiles.importConfig()
      if (!imported) return
      upsert(imported)
      messageApi.success(t("环境配置已导入；出于安全考虑，代理密码需要重新填写"))
    } catch (error) {
      messageApi.error(humanError(error))
    } finally {
      setImporting(false)
    }
  }

  async function importProfileBackup(): Promise<void> {
    setImporting(true)
    try {
      const imported = await window.browserApi.profiles.importBackup()
      if (!imported) return
      upsert(imported.profile)
      messageApi.success(t("完整数据已导入为新环境，共 {0} 个文件；请重新填写代理密码", imported.result.fileCount))
    } catch (error) {
      messageApi.error(humanError(error), 6)
    } finally {
      setImporting(false)
    }
  }

  function confirmProfileBackupImport(): void {
    Modal.confirm({
      title: t("导入完整环境数据备份"),
      content: t("备份会导入为新的独立环境，不覆盖现有数据。代理密码和扩展不会迁移；跨系统导入后部分网站可能需要重新登录。"),
      okText: t("选择备份目录"),
      cancelText: t("取消"),
      onOk: importProfileBackup
    })
  }

  async function runWorkspaceMigration(password: string, conflictPolicy: 'rename' | 'skip'): Promise<void> {
    if (!migrationMode) return
    setMigrationBusy(true)
    try {
      const result = migrationMode === 'export'
        ? await window.browserApi.profiles.exportWorkspace(password)
        : await window.browserApi.profiles.importWorkspace(password, conflictPolicy)
      if (!result) return
      if (migrationMode === 'export') {
        messageApi.success(t("已加密导出 {0} 个环境、{1}", result.profileCount, formatBytes(result.totalBytes)))
      } else {
        const [items, extensionItems] = await Promise.all([window.browserApi.profiles.list(), window.browserApi.extensions.list()])
        setProfiles(items)
        setExtensions(extensionItems)
        void refreshStorageOverview()
        messageApi.success(result.renamedCount
          ? result.skippedCount
            ? t("已导入 {0} 个环境，自动改名 {1} 个，跳过 {2} 个", result.importedCount, result.renamedCount, result.skippedCount)
            : t("已导入 {0} 个环境，自动改名 {1} 个", result.importedCount, result.renamedCount)
          : result.skippedCount
            ? t("已导入 {0} 个环境，跳过 {1} 个", result.importedCount, result.skippedCount)
            : t("已导入 {0} 个环境", result.importedCount))
      }
      setMigrationMode(null)
    } catch (error) {
      messageApi.error(humanError(error), 8)
    } finally {
      setMigrationBusy(false)
    }
  }

  async function importBatchCsv(): Promise<void> {
    setImporting(true)
    try {
      const imported = await window.browserApi.profiles.importBatchCsv()
      if (!imported) return
      for (const profile of imported) upsert(profile)
      messageApi.success(t("已批量创建 {0} 个独立环境", imported.length))
    } catch (error) {
      messageApi.error(humanError(error), 6)
    } finally {
      setImporting(false)
    }
  }

  function confirmBatchImport(): void {
    Modal.confirm({
      title: t("批量导入 CSV 环境"),
      content: t("应用会先校验全部数据，任意一行错误都不会创建环境。CSV 中的代理密码是明文，请只使用可信文件，并在导入后妥善删除。"),
      okText: t("选择 CSV"),
      cancelText: t("取消"),
      onOk: importBatchCsv
    })
  }

  async function exportBatchTemplate(): Promise<void> {
    try {
      const path = await window.browserApi.profiles.exportBatchTemplate()
      if (path) messageApi.success(t("CSV 批量导入模板已保存"))
    } catch (error) {
      messageApi.error(humanError(error))
    }
  }

  async function runBatch(mode: 'launch' | 'close'): Promise<void> {
    const eligible = profiles.filter((profile) => selectedIds.includes(profile.id)).filter((profile) =>
      mode === 'launch'
        ? profile.status === 'closed' || profile.status === 'error'
        : profile.status !== 'closed' && profile.status !== 'error'
    )
    const candidates = mode === 'launch' ? orderBatchLaunchProfiles(eligible) : eligible
    if (!candidates.length) {
      messageApi.info(mode === 'launch' ? t("所选环境中没有可启动项") : t("所选环境中没有运行项"))
      return
    }
    setBatchBusy(true)
    setBusyIds((current) => new Set([...current, ...candidates.map((profile) => profile.id)]))
    const errors: string[] = []
    try {
      if (mode === 'launch') {
        for (let index = 0; index < candidates.length; index++) {
          const profile = candidates[index]
          try {
            const next = await launchWithGeoConflictConfirmation(profile)
            if (next) upsert(next)
            else errors.push(t("{0}：用户取消了 GeoIP 冲突风险确认", profile.name))
          } catch (error) {
            errors.push(`${profile.name}：${humanError(error)}`)
          }
          if (index < candidates.length - 1) await waitForBatchLaunchGap()
        }
      } else {
        for (let index = 0; index < candidates.length; index += 3) {
          await Promise.all(candidates.slice(index, index + 3).map(async (profile) => {
            try {
              upsert(await window.browserApi.profiles.close(profile.id))
            } catch (error) {
              errors.push(`${profile.name}：${humanError(error)}`)
            }
          }))
        }
      }
      if (errors.length) {
        setBatchResult({
          operation: mode === 'launch' ? '启动' : '关闭',
          total: candidates.length,
          succeeded: candidates.length - errors.length,
          errors
        })
        messageApi.warning(t("完成 {0} 个，失败 {1} 个", candidates.length - errors.length, errors.length))
      } else {
        messageApi.success(mode === 'launch' ? t("已启动 {0} 个环境", candidates.length) : t("已关闭 {0} 个环境", candidates.length))
      }
      setSelectedIds([])
    } finally {
      const ids = new Set(candidates.map((profile) => profile.id))
      setBusyIds((current) => new Set([...current].filter((id) => !ids.has(id))))
      setBatchBusy(false)
    }
  }

  async function runProxyChecks(ids: string[]): Promise<void> {
    const candidates = profiles.filter((profile) => ids.includes(profile.id))
    if (!candidates.length) return
    if (candidates.length > 100) {
      messageApi.warning(t("单次最多批量检测 100 个环境"))
      return
    }
    setBatchBusy(true)
    setBusyIds((current) => new Set([...current, ...candidates.map((profile) => profile.id)]))
    let available = 0
    let failed = 0
    const invocationErrors: string[] = []
    try {
      for (let index = 0; index < candidates.length; index += 5) {
        await Promise.all(candidates.slice(index, index + 5).map(async (profile) => {
          try {
            const next = await window.browserApi.profiles.testProxy(profile.id)
            upsert(next)
            if (next.proxyCheck?.ok) available += 1
            else failed += 1
          } catch (error) {
            invocationErrors.push(`${profile.name}：${humanError(error)}`)
          }
        }))
      }
      if (invocationErrors.length) messageApi.warning(t("检测完成：可用 {0}，失败 {1}，未保存 {2}", available, failed, invocationErrors.length))
      else messageApi.success(t("检测完成：可用 {0}，失败 {1}", available, failed))
    } finally {
      const checkedIds = new Set(candidates.map((profile) => profile.id))
      setBusyIds((current) => new Set([...current].filter((id) => !checkedIds.has(id))))
      setBatchBusy(false)
    }
  }

  async function runDiagnostics(profile: BrowserProfileView): Promise<void> {
    await withBusy(profile.id, async () => {
      const report = await window.browserApi.profiles.diagnose(profile.id)
      setDiagnosticProfile(profile)
      setDiagnosticReport(report)
    })
  }

  async function openCrashHistory(profile: BrowserProfileView): Promise<void> {
    setCrashProfile(profile)
    setCrashRecords([])
    setCrashHistoryLoading(true)
    try {
      setCrashRecords(await window.browserApi.profiles.crashHistory(profile.id))
    } catch (error) {
      messageApi.error(humanError(error))
    } finally {
      setCrashHistoryLoading(false)
    }
  }

  async function recoverCrashProfile(): Promise<void> {
    if (!crashProfile) return
    await withBusy(crashProfile.id, async () => {
      const next = crashProfile.status === 'orphaned'
        ? await window.browserApi.profiles.close(crashProfile.id)
        : await launchWithGeoConflictConfirmation(crashProfile)
      if (next) {
        upsert(next)
        setCrashProfile(next)
      }
    })
  }

  async function saveBatchClassification(): Promise<void> {
    const group = batchGroup.trim()
    const addTags = [...new Set(batchTags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))]
    if (!batchGroupEnabled && !addTags.length) {
      messageApi.warning(t("请填写目标分组或要追加的标签"))
      return
    }
    setBatchBusy(true)
    try {
      const changed = await window.browserApi.profiles.classifyMany(selectedIds, {
        group: batchGroupEnabled ? group : undefined,
        addTags
      })
      for (const profile of changed) upsert(profile)
      setBatchClassificationOpen(false)
      setBatchGroupEnabled(false)
      setBatchGroup('')
      setBatchTags('')
      setSelectedIds([])
      messageApi.success(t("已更新 {0} 个环境", changed.length))
    } catch (error) {
      messageApi.error(humanError(error))
    } finally {
      setBatchBusy(false)
    }
  }

  function confirmBatchRemove(): void {
    const ids = [...selectedIds]
    Modal.confirm({
      title: t("将 {0} 个环境移入回收站？", ids.length),
      content: t("运行中的环境不会被删除。环境配置与独立浏览器数据会一起移入本机回收站，可逐个恢复。"),
      okText: t("移入回收站"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        setBatchBusy(true)
        try {
          await window.browserApi.profiles.removeMany(ids)
          const removed = new Set(ids)
          setProfiles((current) => current.filter((profile) => !removed.has(profile.id)))
          setSelectedIds([])
          messageApi.success(t("已将 {0} 个环境移入回收站", ids.length))
        } catch (error) {
          messageApi.error(humanError(error))
          throw error
        } finally {
          setBatchBusy(false)
        }
      }
    })
  }

  async function applyKernelSwitch(kernelVersion: string): Promise<void> {
    const ids = [...selectedIds]
    setBatchBusy(true)
    try {
      const updated = await window.browserApi.profiles.setKernelMany(ids, kernelVersion)
      for (const profile of updated) upsert(profile)
      setKernelSwitchOpen(false)
      messageApi.success(kernelVersion
        ? t("已将 {0} 个窗口切换到 Chromium {1}", ids.length, kernelVersion)
        : t("{0} 个窗口已改为跟随默认内核", ids.length))
    } catch (error) {
      messageApi.error(humanError(error))
    } finally {
      setBatchBusy(false)
    }
  }

  function navigate(target: SidebarTarget): void {
    if (target === 'extensions') setExtensionManagerOpen(true)
    if (target === 'kernels') setKernelManagerOpen(true)
    if (target === 'recycle') setRecycleBinOpen(true)
  }

  function profileMenu(profile: BrowserProfileView): MenuProps {
    const editable = profile.status === 'closed' || profile.status === 'error'
    return {
      items: [
        { key: 'edit', icon: <EditOutlined />, label: t("编辑"), disabled: !editable },
        { key: 'data', icon: <DatabaseOutlined />, label: t("环境数据") },
        { key: 'diagnose', icon: <SafetyCertificateOutlined />, label: t("启动诊断") },
        { key: 'crashes', icon: <WarningFilled />, label: t("异常与恢复") },
        { key: 'proxy-check', icon: <ApiOutlined />, label: t("检测代理") },
        { key: 'duplicate', icon: <CopyOutlined />, label: t("复制环境") },
        { key: 'export', icon: <DownloadOutlined />, label: t("导出配置"), disabled: !editable },
        { type: 'divider' },
        { key: 'delete', icon: <DeleteOutlined />, label: t("删除"), danger: true, disabled: !editable }
      ],
      onClick: ({ key }) => {
        if (key === 'edit') openEditor(profile)
        if (key === 'data') setDataProfile(profile)
        if (key === 'diagnose') void runDiagnostics(profile)
        if (key === 'crashes') void openCrashHistory(profile)
        if (key === 'proxy-check') void runProxyChecks([profile.id])
        if (key === 'duplicate') {
          void withBusy(profile.id, async () => {
            const copy = await window.browserApi.profiles.duplicate(profile.id)
            upsert(copy)
            messageApi.success(t("已复制为新的独立环境"))
          })
        }
        if (key === 'export') {
          void withBusy(profile.id, async () => {
            const path = await window.browserApi.profiles.exportConfig(profile.id)
            if (path) messageApi.success(t("环境配置已导出（不包含代理密码和浏览数据）"))
          })
        }
        if (key === 'delete') {
          Modal.confirm({
            title: t("删除“{0}”？", profile.name),
            content: t("环境会从列表移除，浏览器数据将移动到本机回收目录，避免误删后无法恢复。"),
            okText: t("删除"),
            okButtonProps: { danger: true },
            cancelText: t("取消"),
            onOk: async () => {
              await window.browserApi.profiles.remove(profile.id)
              setProfiles((current) => current.filter((item) => item.id !== profile.id))
              setSelectedIds((current) => current.filter((id) => id !== profile.id))
            }
          })
        }
      }
    }
  }

  const columns: TableColumnsType<BrowserProfileView> = [
    {
      title: t("序号"),
      dataIndex: 'serialNumber',
      width: 64,
      sorter: (first, second) => first.serialNumber - second.serialNumber,
      render: (serial: number) => <span className="fb-muted">{serial}</span>
    },
    {
      title: t("窗口名称"),
      dataIndex: 'name',
      width: 200,
      sorter: profileTableSorters.environment,
      render: (_value, profile) => (
        <div className="fb-name-cell">
          {statusDot(profile)}
          <span className="fb-color-mark" style={{ background: profile.color }} aria-hidden="true" />
          <div>
            <strong title={profile.name}>{profile.name}</strong>
            {profile.tags.length > 0 && (
              <span className="fb-tags">
                {profile.tags.slice(0, 2).map((tag) => <Tag key={tag}>{tag}</Tag>)}
                {profile.tags.length > 2 && <Tooltip title={profile.tags.slice(2).join(', ')}><Tag>+{profile.tags.length - 2}</Tag></Tooltip>}
              </span>
            )}
          </div>
          <Button
            type="text"
            size="small"
            className={`favorite-button${profile.favorite ? ' active' : ''}`}
            aria-label={profile.favorite ? t("取消收藏") : t("收藏环境")}
            icon={profile.favorite ? <StarFilled /> : <StarOutlined />}
            onClick={() => void toggleFavorite(profile)}
          />
        </div>
      )
    },
    {
      title: t("分组"),
      dataIndex: 'group',
      width: 120,
      sorter: profileTableSorters.classification,
      render: (group: string) => <span className={`fb-group${group ? '' : ' empty'}`}>{group || t("未分组")}</span>
    },
    {
      title: t("代理 IP"),
      dataIndex: 'proxy',
      width: 180,
      sorter: profileTableSorters.proxy,
      render: (_value, profile) => proxyCell(profile)
    },
    {
      title: t("系统 / 内核"),
      key: 'kernel',
      width: 150,
      sorter: (first, second) => (first.kernelVersion || '').localeCompare(second.kernelVersion || '', undefined, { numeric: true }),
      render: (_value, profile) => (
        <div className="fb-kernel-cell">
          <span>{profile.fingerprint.platform === 'windows' ? 'Windows' : 'macOS'} · {profile.fingerprint.brand}</span>
          {profile.kernelVersion
            ? <Tooltip title={`Chromium ${profile.kernelVersion}`}><small className="pinned">{t("Chromium {0} · 指定", majorVersion(profile.kernelVersion))}</small></Tooltip>
            : <Tooltip title={engine?.version ? `Chromium ${engine.version}` : undefined}><small>{engine?.version ? t("Chromium {0} · 默认", majorVersion(engine.version)) : t("默认内核")}</small></Tooltip>}
        </div>
      )
    },
    {
      title: t("备注"),
      dataIndex: 'note',
      width: 120,
      ellipsis: { showTitle: true },
      render: (note: string) => note ? note : <span className="fb-muted">—</span>
    },
    {
      title: t("最后打开"),
      dataIndex: 'lastOpenedAt',
      width: 110,
      sorter: (first, second) => (first.lastOpenedAt ?? '').localeCompare(second.lastOpenedAt ?? ''),
      render: (value: string | undefined) => <span className="fb-muted">{relativeTime(value, locale)}</span>
    },
    {
      title: t("操作"),
      key: 'actions',
      width: 168,
      fixed: 'right',
      align: 'right',
      render: (_value, profile) => {
        const running = ACTIVE_STATUSES.has(profile.status)
        const editable = profile.status === 'closed' || profile.status === 'error'
        return (
          <Space size={4}>
            <Button
              size="small"
              type={running ? 'default' : 'primary'}
              danger={running}
              className="fb-open-button"
              autoInsertSpace={false}
              loading={busyIds.has(profile.id) || profile.status === 'starting' || profile.status === 'stopping'}
              disabled={!running && !canLaunchProfile(profile)}
              onClick={() => void withBusy(profile.id, async () => {
                const next = running
                  ? await window.browserApi.profiles.close(profile.id)
                  : await launchWithGeoConflictConfirmation(profile)
                if (next) upsert(next)
              })}
            >
              {profile.status === 'orphaned' ? t("结束遗留") : running ? t("关闭") : t("打开")}
            </Button>
            <Tooltip title={editable ? undefined : t("请先关闭窗口再编辑")}>
              <Button size="small" type="link" autoInsertSpace={false} disabled={!editable} onClick={() => openEditor(profile)}>{t("编辑")}</Button>
            </Tooltip>
            <Dropdown menu={profileMenu(profile)} trigger={['click']}>
              <Button size="small" type="text" icon={<MoreOutlined />} aria-label={t("更多操作")} />
            </Dropdown>
          </Space>
        )
      }
    }
  ]

  const runningCount = profiles.filter((profile) => profile.status === 'running' || profile.status === 'orphaned').length

  return (
    <Layout className="app-shell" hasSider>
      {contextHolder}
      <Sidebar
        active="windows"
        windowCount={profiles.length}
        extensionCount={extensions.length}
        engine={engine}
        onNavigate={navigate}
      />

      <Layout>
        <header className="fb-topbar">
          <h1>{t("窗口管理")}</h1>
          <span className="fb-muted">{t("共 {0} 个窗口 · 运行中 {1}", profiles.length, runningCount)}</span>
          <Space className="fb-topbar-actions">
            <LanguageSelector />
            {runningCount > 0 && (
              <Button danger icon={<PoweroffOutlined />} onClick={() => void window.browserApi.profiles.closeAll()}>{t("全部关闭")}</Button>
            )}
          </Space>
        </header>
        <Content className="fb-content">
          {engine && !engine.fingerprintKernel && (
            <Alert
              className="engine-alert"
              type={engine.executable ? 'warning' : 'error'}
              showIcon
              icon={engine.executable ? <WarningFilled /> : undefined}
              title={engine.executable ? t("当前运行在兼容模式") : t("尚未配置浏览器内核")}
              description={engine.executable
                ? t("当前内核不支持指纹配置，请在使用前切换到指纹内核。")
                : t("请先选择或导入浏览器内核。")}
              action={<Button onClick={() => setKernelManagerOpen(true)}>{t("管理内核")}</Button>}
            />
          )}

          {profileStorageHealth?.recoveredFromBackup && (
            <Alert className="engine-alert" type="warning" showIcon title={t("环境配置已从备份自动恢复")} description={t("环境数据已恢复，可以继续使用。")} />
          )}

          {appRecoveryStatus?.previousUnclean && (
            <Alert
              className="engine-alert"
              type="warning"
              showIcon
              closable
              title={t("检测到上次应用未正常退出")}
              description={appRecoveryStatus.markerCorrupt
                ? t("环境数据未受影响。")
                : t("已自动检查可能遗留的浏览器进程，环境数据未受影响。")}
            />
          )}

          {profileStorageHealth && !profileStorageHealth.backupHealthy && (
            <Alert className="engine-alert" type="error" showIcon title={t("环境配置备份失败")} description={t("当前数据仍可使用，请检查磁盘空间和目录权限。")} />
          )}

          <div className="fb-toolbar">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>{t("新建窗口")}</Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'batch', label: t("批量导入 CSV") },
                  { key: 'single', label: t("导入单个 JSON 环境") },
                  { key: 'backup', label: t("导入完整数据备份") },
                  { key: 'workspace', label: t("导入全部环境迁移包") },
                  { type: 'divider' },
                  { key: 'csv-sample', label: t("保存 CSV 示例文件") }
                ],
                onClick: ({ key }) => {
                  if (key === 'single') void importProfile()
                  if (key === 'batch') confirmBatchImport()
                  if (key === 'backup') confirmProfileBackupImport()
                  if (key === 'workspace') setMigrationMode('import')
                  if (key === 'csv-sample') void exportBatchTemplate()
                }
              }}
              trigger={['click']}
            >
              <Button icon={<UploadOutlined />} loading={importing}>{t("批量导入")}</Button>
            </Dropdown>
            <Tooltip title={selectedIds.length ? undefined : t("先勾选要打开的窗口")}>
              <Button
                icon={<GlobalOutlined />}
                loading={batchBusy}
                disabled={!profiles.filter((profile) => selectedIds.includes(profile.id)).some((profile) => canLaunchProfile(profile))}
                onClick={() => void runBatch('launch')}
              >{t("批量打开")}</Button>
            </Tooltip>
            <Dropdown
              menu={{
                items: [
                  { key: 'export-workspace', icon: <DownloadOutlined />, label: t("迁移全部环境") },
                  { key: 'storage', icon: <DatabaseOutlined />, label: storage ? t("本地数据 {0}", formatBytes(storage.totalBytes)) : t("统计本地数据") }
                ],
                onClick: ({ key }) => {
                  if (key === 'export-workspace') setMigrationMode('export')
                  if (key === 'storage') void refreshStorageOverview()
                }
              }}
              trigger={['click']}
            >
              <Button>{t("更多操作")} <DownOutlined /></Button>
            </Dropdown>
            <div className="fb-toolbar-filters">
              <Select value={selectedGroup} options={groupOptions} onChange={setSelectedGroup} className="group-filter" aria-label={t("按分组筛选")} />
              <Input
                allowClear
                prefix={<SearchOutlined />}
                placeholder={t("搜索名称 / 备注 / 代理 IP")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="search-input"
              />
            </div>
          </div>

          <Tabs
            className="fb-tabs"
            activeKey={listTab}
            onChange={(key) => setListTab(key as ListTab)}
            items={[
              { key: 'all', label: <>{t("全部")} <span className="fb-muted">{tabCounts.all}</span></> },
              { key: 'running', label: <>{t("运行中")} <span className="fb-muted">{tabCounts.running}</span></> },
              { key: 'favorites', label: <>{t("收藏")} <span className="fb-muted">{tabCounts.favorites}</span></> },
              { key: 'ungrouped', label: <>{t("未分组")} <span className="fb-muted">{tabCounts.ungrouped}</span></> },
              ...(tabCounts.attention || listTab === 'attention'
                ? [{ key: 'attention', label: <span className="fb-attention">{t("需要处理")} {tabCounts.attention}</span> }]
                : [])
            ]}
          />

          {selectedIds.length > 0 && (
            <div className="fb-batch-bar" role="toolbar" aria-label={t("批量操作")}>
              <span>{t("已选 {0} 个窗口", selectedIds.length)}</span>
              <Button size="small" type="link" loading={batchBusy} disabled={!profiles.filter((profile) => selectedIds.includes(profile.id)).some((profile) => canLaunchProfile(profile))} onClick={() => void runBatch('launch')}>{t("打开")}</Button>
              <Button size="small" type="link" loading={batchBusy} onClick={() => void runBatch('close')}>{t("关闭")}</Button>
              <Button size="small" type="link" disabled={batchBusy} onClick={() => setBatchClassificationOpen(true)}>{t("移动分组")}</Button>
              <Button size="small" type="link" disabled={batchBusy} icon={<ApiOutlined />} onClick={() => void runProxyChecks(selectedIds)}>{t("检测代理")}</Button>
              <Button size="small" type="link" disabled={batchBusy} onClick={() => setKernelSwitchOpen(true)}>{t("切换内核")}</Button>
              <Button size="small" type="link" danger disabled={batchBusy} icon={<DeleteOutlined />} onClick={confirmBatchRemove}>{t("删除")}</Button>
              <Button size="small" type="link" className="fb-batch-clear" onClick={() => setSelectedIds([])}>{t("取消选择")}</Button>
            </div>
          )}

          <section className="fb-table-panel">
            <Spin spinning={loading}>
              <Table
                rowKey="id"
                size="middle"
                columns={columns}
                dataSource={visibleProfiles}
                rowClassName={(profile) => selectedIds.includes(profile.id) ? 'fb-row-selected' : ''}
                rowSelection={{
                  selectedRowKeys: selectedIds,
                  preserveSelectedRowKeys: true,
                  onChange: (keys) => setSelectedIds(keys.map(String))
                }}
                pagination={{
                  pageSize,
                  showSizeChanger: true,
                  pageSizeOptions: [10, 20, 50, 100],
                  onShowSizeChange: (_current, size) => setPageSize(size),
                  showTotal: (total) => t("共 {0} 条", total),
                  hideOnSinglePage: false
                }}
                scroll={{ x: 1160 }}
                locale={{
                  emptyText: (
                    <Empty description={profiles.length ? t("没有符合条件的窗口") : t("还没有浏览器窗口")}>
                      {!profiles.length && <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>{t("新建第一个窗口")}</Button>}
                    </Empty>
                  )
                }}
              />
            </Spin>
          </section>
        </Content>
      </Layout>
      <WorkspaceMigrationModal
        mode={migrationMode}
        busy={migrationBusy}
        profileCount={profiles.length}
        onSubmit={runWorkspaceMigration}
        onClose={() => { if (!migrationBusy) setMigrationMode(null) }}
      />

      <ProfileEditor
        open={editorOpen}
        profile={editing}
        suggestedIndex={profiles.length + 1}
        saving={saving}
        extensions={extensions}
        engine={engine}
        kernels={selectableKernels}
        groups={editableGroups}
        onCancel={() => { setEditorOpen(false); setEditing(undefined) }}
        onSave={saveProfile}
      />
      <KernelManagerModal
        open={kernelManagerOpen}
        engine={engine}
        onClose={() => setKernelManagerOpen(false)}
        onEngineChanged={(nextEngine) => {
          setEngine(nextEngine)
          void window.browserApi.engine.installed().then(setKernels).catch((error) => messageApi.error(humanError(error)))
        }}
      />
      <ProfileDataModal
        open={Boolean(dataProfile)}
        profile={dataProfile}
        onClose={() => setDataProfile(undefined)}
      />
      <RecycleBinModal
        open={recycleBinOpen}
        onClose={() => setRecycleBinOpen(false)}
        onRestored={upsert}
      />
      <ExtensionManagerModal
        open={extensionManagerOpen}
        extensions={extensions}
        onClose={() => setExtensionManagerOpen(false)}
        onChanged={setExtensions}
      />
      <LaunchDiagnosticsModal
        open={Boolean(diagnosticProfile && diagnosticReport)}
        profile={diagnosticProfile}
        report={diagnosticReport}
        onClose={() => { setDiagnosticProfile(undefined); setDiagnosticReport(undefined) }}
      />
      <CrashHistoryModal
        open={Boolean(crashProfile)}
        profile={crashProfile}
        records={crashRecords}
        loading={crashHistoryLoading}
        recovering={Boolean(crashProfile && busyIds.has(crashProfile.id))}
        onClose={() => { setCrashProfile(undefined); setCrashRecords([]) }}
        onRecover={() => void recoverCrashProfile()}
        onDiagnose={() => {
          if (!crashProfile) return
          const profile = crashProfile
          setCrashProfile(undefined)
          void runDiagnostics(profile)
        }}
      />
      <BatchResultModal result={batchResult} onClose={() => setBatchResult(undefined)} />
      <KernelSwitchModal
        open={kernelSwitchOpen}
        count={selectedIds.length}
        runningCount={profiles.filter((profile) => selectedIds.includes(profile.id) && ACTIVE_STATUSES.has(profile.status)).length}
        kernels={selectableKernels}
        engine={engine}
        busy={batchBusy}
        onSubmit={(version) => void applyKernelSwitch(version)}
        onClose={() => setKernelSwitchOpen(false)}
      />
      <Modal
        open={batchClassificationOpen}
        title={t("为 {0} 个窗口修改分组", selectedIds.length)}
        okText={t("应用修改")}
        cancelText={t("取消")}
        confirmLoading={batchBusy}
        onOk={() => void saveBatchClassification()}
        onCancel={() => { setBatchClassificationOpen(false); setBatchGroupEnabled(false); setBatchGroup(''); setBatchTags('') }}
      >
        <Typography.Paragraph type="secondary">{t("可选择设置或清空分组；标签会追加并自动去重。")}</Typography.Paragraph>
        <Space direction="vertical" className="batch-classification-fields">
          <Checkbox checked={batchGroupEnabled} onChange={(event) => setBatchGroupEnabled(event.target.checked)}>{t("修改分组（留空即清除分组）")}</Checkbox>
          <Input disabled={!batchGroupEnabled} value={batchGroup} maxLength={40} placeholder={t("目标分组")} onChange={(event) => setBatchGroup(event.target.value)} />
          <Input value={batchTags} placeholder={t("追加标签，使用逗号分隔（可选）")} onChange={(event) => setBatchTags(event.target.value)} />
        </Space>
      </Modal>
    </Layout>
  )
}
