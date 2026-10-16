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
  SafetyCertificateOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
  UploadOutlined,
  WarningFilled
} from '@ant-design/icons'
import { Alert, Button, Dropdown, Input, Modal, Select, Space, Tag, Tooltip, type MenuProps, type TableColumnsType } from 'antd'
import { useMemo, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import type { BrowserCrashRecord, BrowserProfileView, LaunchDiagnosticReport, ProfileDraft, StorageOverview } from '../../../../shared/types'
import { AssignModal } from '../../components/AssignModal'
import { ACTIVE_STATUSES, formatBytes, humanError, isEditable, majorVersion, relativeTime } from '../../components/format'
import { ListPage, type ListTab } from '../../components/ListPage'
import { ProxyCell, proxyLabel } from '../../components/proxy'
import { StatusDot } from '../../components/StatusDot'
import { useWindowLauncher } from '../../data/window-actions'
import { useWorkspace } from '../../data/workspace'
import { BatchImportModal } from './BatchImportModal'
import { BatchResultModal, type BatchOperationResult } from './BatchResultModal'
import { CrashHistoryModal } from './CrashHistoryModal'
import { KernelSwitchModal } from './KernelSwitchModal'
import { LaunchDiagnosticsModal } from './LaunchDiagnosticsModal'
import { ProfileDataModal } from './ProfileDataModal'
import { ProfileEditor, type ProfileEditorExtras } from './ProfileEditor'
import { profileTableSorters } from './profile-table-sort'
import { WorkspaceMigrationModal } from './WorkspaceMigrationModal'

type ListTabKey = 'all' | 'running' | 'favorites' | 'ungrouped' | 'attention'
const ALL_GROUPS = '__all__'

export function windowsSubtitle(profiles: BrowserProfileView[]): string {
  const running = profiles.filter((profile) => profile.status === 'running' || profile.status === 'orphaned').length
  return t("共 {0} 个窗口 · 运行中 {1}", profiles.length, running)
}

/** Window management (design: Main.dc.html). */
export function WindowsPage({ openKernels, groupId }: { openKernels: () => void; groupId?: string }) {
  const ws = useWorkspace()
  const { launch, openMany } = useWindowLauncher()
  const { profiles, proxies, groups, engine, kernels, extensions, notify, locale } = ws
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState(groupId ?? ALL_GROUPS)
  const [listTab, setListTab] = useState<ListTabKey>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [editing, setEditing] = useState<BrowserProfileView | undefined>()
  const [editorOpen, setEditorOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [assigning, setAssigning] = useState<'group' | 'proxy' | null>(null)
  const [batchTags, setBatchTags] = useState('')
  const [kernelSwitchOpen, setKernelSwitchOpen] = useState(false)
  const [batchImportOpen, setBatchImportOpen] = useState(false)
  const [batchResult, setBatchResult] = useState<BatchOperationResult>()
  const [dataProfile, setDataProfile] = useState<BrowserProfileView | undefined>()
  const [diagnosticProfile, setDiagnosticProfile] = useState<BrowserProfileView>()
  const [diagnosticReport, setDiagnosticReport] = useState<LaunchDiagnosticReport>()
  const [crashProfile, setCrashProfile] = useState<BrowserProfileView>()
  const [crashRecords, setCrashRecords] = useState<BrowserCrashRecord[]>([])
  const [crashHistoryLoading, setCrashHistoryLoading] = useState(false)
  const [storage, setStorage] = useState<StorageOverview>()
  const [migrationMode, setMigrationMode] = useState<'export' | 'import' | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)

  const selected = profiles.filter((profile) => selectedIds.includes(profile.id))
  const upsert = (profile: BrowserProfileView): void => ws.upsertProfiles([profile])

  const visibleProfiles = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const filtered = profiles.filter((profile) => {
      if (groupFilter !== ALL_GROUPS && profile.groupId !== groupFilter) return false
      if (listTab === 'favorites' && !profile.favorite) return false
      if (listTab === 'running' && !ACTIVE_STATUSES.has(profile.status)) return false
      if (listTab === 'ungrouped' && profile.groupId) return false
      if (listTab === 'attention' && !['orphaned', 'error'].includes(profile.status) && !profile.proxyMissing) return false
      if (!normalized) return true
      return [String(profile.serialNumber), profile.name, profile.note, profile.group, ...profile.tags, profile.proxy.host, profile.proxyCheck?.ip ?? '', profile.fingerprint.timezone]
        .some((value) => value.toLowerCase().includes(normalized))
    })
    // Newest serial first, like the design; favourites stay on top. Column sorters override this.
    return [...filtered].sort((first, second) => {
      if (first.favorite !== second.favorite) return first.favorite ? -1 : 1
      return second.serialNumber - first.serialNumber
    })
  }, [profiles, query, groupFilter, listTab])

  const attentionCount = profiles.filter((profile) => profile.status === 'orphaned' || profile.status === 'error' || profile.proxyMissing).length
  const tabs: ListTab[] = [
    { key: 'all', label: t("全部"), count: profiles.length },
    { key: 'running', label: t("运行中"), count: profiles.filter((profile) => ACTIVE_STATUSES.has(profile.status)).length },
    { key: 'favorites', label: t("收藏"), count: profiles.filter((profile) => profile.favorite).length },
    { key: 'ungrouped', label: t("未分组"), count: profiles.filter((profile) => !profile.groupId).length },
    ...(attentionCount || listTab === 'attention' ? [{ key: 'attention', label: t("需要处理"), count: attentionCount, tone: 'danger' as const }] : [])
  ]

  const groupOptions = [
    { value: ALL_GROUPS, label: t("全部分组 ({0})", profiles.length) },
    ...groups.map((group) => ({ value: group.id, label: `${group.name} (${group.profileCount})` })),
    { value: '', label: `${t("未分组")} (${profiles.filter((profile) => !profile.groupId).length})` }
  ]

  async function withBusy(id: string, action: () => Promise<unknown>): Promise<void> {
    setBusyIds((current) => new Set(current).add(id))
    try {
      await action()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusyIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
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
      notify.success(editing ? t("环境已更新") : t("环境已创建"))
      if (extras.cookieText.trim()) {
        try {
          const { count } = await window.browserApi.profiles.importCookiesText(saved.id, extras.cookieText)
          notify.success(t("已导入 {0} 条 Cookie", count))
        } catch (error) {
          notify.warning(t("窗口已保存，但 Cookie 导入失败：{0}", humanError(error)))
        }
      }
    } catch (error) {
      ws.fail(error)
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
      notify.success(t("环境配置已导入；出于安全考虑，代理密码需要重新填写"))
    } catch (error) {
      ws.fail(error)
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
      onOk: async () => {
        setImporting(true)
        try {
          const imported = await window.browserApi.profiles.importBackup()
          if (!imported) return
          upsert(imported.profile)
          notify.success(t("完整数据已导入为新环境，共 {0} 个文件；请重新填写代理密码", imported.result.fileCount))
        } catch (error) {
          ws.fail(error, 6)
        } finally {
          setImporting(false)
        }
      }
    })
  }

  async function refreshStorageOverview(): Promise<void> {
    try {
      setStorage(await window.browserApi.profiles.storageOverview())
    } catch (error) {
      ws.fail(error)
    }
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
        notify.success(t("已加密导出 {0} 个环境、{1}", result.profileCount, formatBytes(result.totalBytes)))
      } else {
        await Promise.all([ws.reloadProfiles(), ws.reloadLibraries(), window.browserApi.extensions.list().then(ws.setExtensions)])
        notify.success(result.renamedCount
          ? result.skippedCount
            ? t("已导入 {0} 个环境，自动改名 {1} 个，跳过 {2} 个", result.importedCount, result.renamedCount, result.skippedCount)
            : t("已导入 {0} 个环境，自动改名 {1} 个", result.importedCount, result.renamedCount)
          : result.skippedCount
            ? t("已导入 {0} 个环境，跳过 {1} 个", result.importedCount, result.skippedCount)
            : t("已导入 {0} 个环境", result.importedCount))
      }
      setMigrationMode(null)
    } catch (error) {
      ws.fail(error, 8)
    } finally {
      setMigrationBusy(false)
    }
  }

  async function runBatch(mode: 'launch' | 'close'): Promise<void> {
    const eligible = selected.filter((profile) => mode === 'launch' ? isEditable(profile) : !isEditable(profile))
    const candidates = eligible
    if (!candidates.length) {
      notify.info(mode === 'launch' ? t("所选环境中没有可启动项") : t("所选环境中没有运行项"))
      return
    }
    setBatchBusy(true)
    setBusyIds((current) => new Set([...current, ...candidates.map((profile) => profile.id)]))
    const errors: string[] = []
    try {
      if (mode === 'launch') {
        errors.push(...(await openMany(candidates)).errors)
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
        setBatchResult({ operation: mode === 'launch' ? '启动' : '关闭', total: candidates.length, succeeded: candidates.length - errors.length, errors })
        notify.warning(t("完成 {0} 个，失败 {1} 个", candidates.length - errors.length, errors.length))
      } else {
        notify.success(mode === 'launch' ? t("已启动 {0} 个环境", candidates.length) : t("已关闭 {0} 个环境", candidates.length))
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
      notify.warning(t("单次最多批量检测 100 个环境"))
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
      if (invocationErrors.length) notify.warning(t("检测完成：可用 {0}，失败 {1}，未保存 {2}", available, failed, invocationErrors.length))
      else notify.success(t("检测完成：可用 {0}，失败 {1}", available, failed))
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
      ws.fail(error)
    } finally {
      setCrashHistoryLoading(false)
    }
  }

  async function recoverCrashProfile(): Promise<void> {
    if (!crashProfile) return
    await withBusy(crashProfile.id, async () => {
      const next = crashProfile.status === 'orphaned'
        ? await window.browserApi.profiles.close(crashProfile.id)
        : await launch(crashProfile)
      if (next) {
        upsert(next)
        setCrashProfile(next)
      }
    })
  }

  /** Both batch assignments (group and proxy) go through the one assignMany call. */
  async function applyAssignment(value: string): Promise<void> {
    const ids = [...selectedIds]
    setBatchBusy(true)
    try {
      let changed = await window.browserApi.profiles.assignMany(ids, assigning === 'group' ? { groupId: value } : { proxyId: value })
      const addTags = [...new Set(batchTags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))]
      if (assigning === 'group' && addTags.length) changed = await window.browserApi.profiles.classifyMany(ids, { addTags })
      ws.upsertProfiles(changed)
      setAssigning(null)
      setBatchTags('')
      setSelectedIds([])
      notify.success(t("已更新 {0} 个环境", changed.length))
    } catch (error) {
      ws.fail(error)
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
          ws.dropProfiles(ids)
          setSelectedIds([])
          notify.success(t("已将 {0} 个环境移入回收站", ids.length))
        } catch (error) {
          ws.fail(error)
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
      ws.upsertProfiles(await window.browserApi.profiles.setKernelMany(ids, kernelVersion))
      setKernelSwitchOpen(false)
      notify.success(kernelVersion
        ? t("已将 {0} 个窗口切换到 Chromium {1}", ids.length, kernelVersion)
        : t("{0} 个窗口已改为跟随默认内核", ids.length))
    } catch (error) {
      ws.fail(error)
    } finally {
      setBatchBusy(false)
    }
  }

  function profileMenu(profile: BrowserProfileView): MenuProps {
    const editable = isEditable(profile)
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
            upsert(await window.browserApi.profiles.duplicate(profile.id))
            notify.success(t("已复制为新的独立环境"))
          })
        }
        if (key === 'export') {
          void withBusy(profile.id, async () => {
            const path = await window.browserApi.profiles.exportConfig(profile.id)
            if (path) notify.success(t("环境配置已导出（不包含代理密码和浏览数据）"))
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
              ws.dropProfiles([profile.id])
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
          <StatusDot status={profile.status} error={profile.lastError} />
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
            onClick={() => void window.browserApi.profiles.setFavorite(profile.id, !profile.favorite).then(upsert).catch(ws.fail)}
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
      render: (_value, profile) => <ProxyCell proxy={profile.proxy} check={profile.proxyCheck} missing={profile.proxyMissing} />
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
        const editable = isEditable(profile)
        return (
          <Space size={4}>
            <Button
              size="small"
              type={running ? 'default' : 'primary'}
              danger={running}
              className="fb-open-button"
              autoInsertSpace={false}
              loading={busyIds.has(profile.id) || profile.status === 'starting' || profile.status === 'stopping'}
              disabled={!running && !ws.canLaunch(profile)}
              onClick={() => void withBusy(profile.id, async () => {
                const next = running ? await window.browserApi.profiles.close(profile.id) : await launch(profile)
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

  const canLaunchSelection = selected.some((profile) => ws.canLaunch(profile))
  const sharedOthers = (proxyId: string) => proxyId ? profiles.filter((profile) => profile.proxyId === proxyId && !selectedIds.includes(profile.id)).length : 0

  return (
    <>
      {engine && !engine.fingerprintKernel && (
        <Alert
          className="engine-alert"
          type={engine.executable ? 'warning' : 'error'}
          showIcon
          icon={engine.executable ? <WarningFilled /> : undefined}
          title={engine.executable ? t("当前运行在兼容模式") : t("尚未配置浏览器内核")}
          description={engine.executable ? t("当前内核不支持指纹配置，请在使用前切换到指纹内核。") : t("请先选择或导入浏览器内核。")}
          action={<Button onClick={openKernels}>{t("管理内核")}</Button>}
        />
      )}
      {ws.storageHealth?.recoveredFromBackup && (
        <Alert className="engine-alert" type="warning" showIcon title={t("环境配置已从备份自动恢复")} description={t("环境数据已恢复，可以继续使用。")} />
      )}
      {ws.recovery?.previousUnclean && (
        <Alert
          className="engine-alert"
          type="warning"
          showIcon
          closable
          title={t("检测到上次应用未正常退出")}
          description={ws.recovery.markerCorrupt ? t("环境数据未受影响。") : t("已自动检查可能遗留的浏览器进程，环境数据未受影响。")}
        />
      )}
      {ws.storageHealth && !ws.storageHealth.backupHealthy && (
        <Alert className="engine-alert" type="error" showIcon title={t("环境配置备份失败")} description={t("当前数据仍可使用，请检查磁盘空间和目录权限。")} />
      )}

      <ListPage<BrowserProfileView>
        toolbar={(
          <>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>{t("新建窗口")}</Button>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'batch', label: t("批量导入窗口") },
                  { key: 'single', label: t("导入单个 JSON 环境") },
                  { key: 'backup', label: t("导入完整数据备份") },
                  { key: 'workspace', label: t("导入全部环境迁移包") }
                ],
                onClick: ({ key }) => {
                  if (key === 'single') void importProfile()
                  if (key === 'batch') setBatchImportOpen(true)
                  if (key === 'backup') confirmProfileBackupImport()
                  if (key === 'workspace') setMigrationMode('import')
                }
              }}
            >
              <Button icon={<UploadOutlined />} loading={importing}>{t("批量导入")}</Button>
            </Dropdown>
            <Tooltip title={selectedIds.length ? undefined : t("先勾选要打开的窗口")}>
              <Button icon={<GlobalOutlined />} loading={batchBusy} disabled={!canLaunchSelection} onClick={() => void runBatch('launch')}>{t("批量打开")}</Button>
            </Tooltip>
            <Dropdown
              trigger={['click']}
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
            >
              <Button>{t("更多操作")} <DownOutlined /></Button>
            </Dropdown>
          </>
        )}
        filters={(
          <>
            <Select value={groupFilter} options={groupOptions} onChange={setGroupFilter} className="group-filter" aria-label={t("按分组筛选")} />
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder={t("搜索名称 / 备注 / 代理 IP")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="search-input"
            />
          </>
        )}
        tabs={tabs}
        activeTab={listTab}
        onTabChange={(key) => setListTab(key as ListTabKey)}
        selection={{
          ids: selectedIds,
          onChange: setSelectedIds,
          label: (count) => t("已选 {0} 个窗口", count),
          actions: (
            <>
              <Button size="small" type="link" loading={batchBusy} disabled={!canLaunchSelection} onClick={() => void runBatch('launch')}>{t("打开")}</Button>
              <Button size="small" type="link" loading={batchBusy} onClick={() => void runBatch('close')}>{t("关闭")}</Button>
              <Button size="small" type="link" disabled={batchBusy} onClick={() => setAssigning('group')}>{t("移动分组")}</Button>
              <Button size="small" type="link" disabled={batchBusy} onClick={() => setAssigning('proxy')}>{t("批量设置代理")}</Button>
              <Button size="small" type="link" disabled={batchBusy} icon={<ApiOutlined />} onClick={() => void runProxyChecks(selectedIds)}>{t("检测代理")}</Button>
              <Button size="small" type="link" disabled={batchBusy} onClick={() => setKernelSwitchOpen(true)}>{t("切换内核")}</Button>
              <Button size="small" type="link" danger disabled={batchBusy} icon={<DeleteOutlined />} onClick={confirmBatchRemove}>{t("删除")}</Button>
            </>
          )
        }}
        columns={columns}
        rows={visibleProfiles}
        loading={ws.loading}
        scrollX={1160}
        emptyText={profiles.length ? t("没有符合条件的窗口") : t("还没有浏览器窗口")}
        emptyAction={!profiles.length && <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>{t("新建第一个窗口")}</Button>}
      />

      <ProfileEditor
        open={editorOpen}
        profile={editing}
        suggestedIndex={profiles.length + 1}
        saving={saving}
        extensions={extensions}
        engine={engine}
        kernels={kernels}
        groups={groups.map((group) => group.name)}
        proxies={proxies}
        onCancel={() => { setEditorOpen(false); setEditing(undefined) }}
        onSave={saveProfile}
      />
      <AssignModal
        open={assigning === 'group'}
        title={t("为 {0} 个窗口修改分组", selectedIds.length)}
        options={groups.map((group) => ({ value: group.id, label: `${group.name} (${group.profileCount})`, search: group.name }))}
        noneLabel={t("未分组")}
        placeholder={t("选择分组，或输入新分组名称")}
        onCreate={async (name) => {
          const group = await window.browserApi.groups.create({ name })
          await ws.reloadLibraries()
          return group.id
        }}
        createLabel={(name) => t("新建分组“{0}”", name)}
        busy={batchBusy}
        onSubmit={applyAssignment}
        onClose={() => { setAssigning(null); setBatchTags('') }}
      >
        <Input className="fb-assign-extra" value={batchTags} placeholder={t("追加标签，使用逗号分隔（可选）")} onChange={(event) => setBatchTags(event.target.value)} />
      </AssignModal>
      <AssignModal
        open={assigning === 'proxy'}
        title={t("为 {0} 个窗口设置代理", selectedIds.length)}
        description={t("从代理库中选择；运行中的窗口需要先关闭。")}
        options={proxies.map((proxy) => ({ value: proxy.id, label: proxyLabel(proxy), search: `${proxy.host}:${proxy.port}\n${proxy.note} ${proxy.check?.ip ?? ''}` }))}
        noneLabel={t("直连（不使用代理）")}
        placeholder={t("搜索地址或备注")}
        notice={(value) => {
          const together = (value ? selectedIds.length : 0) + sharedOthers(value)
          return together > 1
            ? <Alert type="warning" showIcon className="fb-assign-extra" title={t("{0} 个窗口将共用这个代理", together)} description={t("多个窗口共用同一个出口 IP，可能被平台判定为关联账号。")} />
            : null
        }}
        busy={batchBusy}
        onSubmit={applyAssignment}
        onClose={() => setAssigning(null)}
      />
      <KernelSwitchModal
        open={kernelSwitchOpen}
        count={selectedIds.length}
        runningCount={selected.filter((profile) => ACTIVE_STATUSES.has(profile.status)).length}
        kernels={kernels}
        engine={engine}
        busy={batchBusy}
        onSubmit={(version) => void applyKernelSwitch(version)}
        onClose={() => setKernelSwitchOpen(false)}
      />
      <BatchImportModal
        open={batchImportOpen}
        groups={groups.map((group) => group.name)}
        onImported={(created) => ws.upsertProfiles(created)}
        onClose={() => setBatchImportOpen(false)}
        onError={(error) => ws.fail(error, 6)}
        onNotice={(text) => notify.success(text)}
      />
      <WorkspaceMigrationModal
        mode={migrationMode}
        busy={migrationBusy}
        profileCount={profiles.length}
        onSubmit={runWorkspaceMigration}
        onClose={() => { if (!migrationBusy) setMigrationMode(null) }}
      />
      <ProfileDataModal open={Boolean(dataProfile)} profile={dataProfile} onClose={() => setDataProfile(undefined)} />
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
    </>
  )
}
