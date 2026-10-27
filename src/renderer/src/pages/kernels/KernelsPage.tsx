import { CloudDownloadOutlined, DeploymentUnitOutlined, DownOutlined, FolderOpenOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons'
import { Alert, Button, Dropdown, Modal, Select, Space, Table, Tag, Tooltip, type TableColumnsType } from 'antd'
import { useEffect, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import type { KernelHealth, KernelRelease } from '../../../../shared/types'
import kernelLock from '../../../../../tools/kernel-lock.json'
import { ACTIVE_STATUSES } from '../../components/format'
import { kernelUsers } from '../../data/kernels'
import { PickWindowsModal } from '../../components/PickWindowsModal'
import { useWorkspace } from '../../data/workspace'
import type { PageProps } from '../registry'
import { DownloadKernelModal } from './DownloadKernelModal'
import { kernelName, kernelVendor } from '../../../../shared/kernel-id'

const FOLLOW_DEFAULT = ''

function originLabel(origin: KernelRelease['origin']): string {
  if (origin === 'bundled') return t("随应用内置")
  if (origin === 'local-build') return t("本地编译")
  return t("官方发布包")
}

function healthTag(health?: KernelHealth) {
  if (!health) return <span className="fb-muted">{t("未检查")}</span>
  if (health.status === 'healthy') return <span className="fb-badge is-ok">{t("正常")}</span>
  if (health.status === 'unverified') return <Tooltip title={mt(health.message)}><span className="fb-badge is-unknown">{t("建议重新导入")}</span></Tooltip>
  return <Tooltip title={mt(health.message)}><span className="fb-badge is-bad">{t("文件异常")}</span></Tooltip>
}

/** Kernel management (design: Kernel.dc.html). Windows pin a kernel by version; '' follows the default. */
export function KernelsPage({ navigate }: PageProps) {
  const ws = useWorkspace()
  const { engine, kernels, profiles, groups, notify } = ws
  const [health, setHealth] = useState<Record<string, KernelHealth>>({})
  const [checking, setChecking] = useState<string | null>(null)
  const [rollbackAvailable, setRollbackAvailable] = useState(false)
  const [assignTo, setAssignTo] = useState<string | null>(null)
  const [scope, setScope] = useState<string>('__all__')
  const [target, setTarget] = useState<string>(FOLLOW_DEFAULT)
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    void window.browserApi.engine.rollbackAvailable().then(setRollbackAvailable).catch(() => setRollbackAvailable(false))
  }, [engine])

  const current = kernels.find((kernel) => kernel.executable && kernel.executable === engine?.executable)
  const defaultVersion = current?.version ?? engine?.version

  async function changeEngine(action: () => Promise<Awaited<ReturnType<typeof window.browserApi.engine.status>>>, success: (version?: string) => string): Promise<void> {
    try {
      const status = await action()
      ws.setEngine(status)
      await ws.reloadKernels()
      notify.success(success(status.version))
    } catch (error) {
      ws.fail(error)
    }
  }

  async function importKernel(): Promise<void> {
    try {
      const result = await window.browserApi.engine.importLocal()
      if (!result) return
      ws.setEngine(result.engine)
      await ws.reloadKernels()
      const name = kernelName(result.version)
      if (result.madeDefault) notify.success(t("{0} 已导入，并设为默认内核", name))
      else if (result.alreadyInstalled) notify.info(t("{0} 已经导入过，没有重复添加", name))
      else notify.success(t("{0} 已导入。已有窗口的内核不变，要用它请点“设为默认”或给窗口单独指定", name))
    } catch (error) {
      ws.fail(error)
    }
  }

  async function verify(version: string): Promise<void> {
    setChecking(version)
    try {
      const result = await window.browserApi.engine.verify(version)
      setHealth((items) => ({ ...items, [version]: result }))
      if (result.status === 'healthy') notify.success(t("内核 {0} 检查通过", version))
      else notify.warning(mt(result.message))
    } catch (error) {
      ws.fail(error)
    } finally {
      setChecking(null)
    }
  }

  function confirmRemove(version: string): void {
    Modal.confirm({
      title: t("移除内核 {0}？", version),
      content: t("文件会移动到本机回收目录。"),
      okText: t("移除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          await window.browserApi.engine.remove(version)
          await ws.reloadKernels()
          ws.setEngine(await window.browserApi.engine.status())
          notify.success(t("内核 {0} 已移入回收目录", version))
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  /** The same batch kernel switch the windows list uses. */
  async function pin(ids: string[], version: string): Promise<void> {
    if (!ids.length) return
    setBusy(true)
    try {
      ws.upsertProfiles(await window.browserApi.profiles.setKernelMany(ids, version))
      setAssignTo(null)
      notify.success(version
        ? t("已将 {0} 个窗口切换到 {1}", ids.length, kernelName(version))
        : t("{0} 个窗口已改为跟随默认内核", ids.length))
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  const scoped = scope === '__all__' ? profiles : profiles.filter((profile) => profile.groupId === (scope === '__ungrouped__' ? '' : scope))
  const scopedRunning = scoped.filter((profile) => ACTIVE_STATUSES.has(profile.status)).length
  const ready = kernels.filter((kernel) => kernel.installed && kernel.executable)

  const columns: TableColumnsType<KernelRelease> = [
    {
      title: t("版本"),
      dataIndex: 'version',
      render: (version: string, kernel) => (
        <span>
          <span className="fb-mono">{kernelName(version)}</span>
          {kernel.webrtcRelay && (
            <Tooltip title={t("WebRTC 可经代理 UDP 转发，可完全关闭 WebRTC；字体按系统语言显示 Windows 自带字体")}>
              <Tag color="blue" className="fb-inline-tag">{t("WebRTC 代理 · 语言字体")}</Tag>
            </Tooltip>
          )}
          {kernelVendor(version) !== 'prism' && <Tooltip title={t("旧的第三方内核，已不再支持，可以删除")}><Tag color="default" className="fb-inline-tag">{t("已退役")}</Tag></Tooltip>}
        </span>
      )
    },
    { title: t("来源"), dataIndex: 'origin', width: 150, render: (origin: KernelRelease['origin']) => originLabel(origin) },
    { title: t("文件状态"), key: 'health', width: 140, render: (_value, kernel) => healthTag(health[kernel.version]) },
    {
      title: t("使用的窗口"),
      key: 'users',
      width: 120,
      render: (_value, kernel) => {
        const count = kernelUsers(profiles, kernel.version, defaultVersion).length
        return count
          ? <Button type="link" size="small" className="fb-link-cell" onClick={() => navigate('windows', { kernelVersion: kernel.version })}>{t("{0} 个窗口", count)}</Button>
          : <span className="fb-muted">{t("{0} 个窗口", 0)}</span>
      }
    },
    {
      title: t("安装时间"),
      dataIndex: 'publishedAt',
      width: 120,
      render: (value: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleDateString(ws.locale) : <span className="fb-muted">—</span>
    },
    {
      title: t("操作"),
      key: 'actions',
      width: 260,
      align: 'right',
      render: (_value, kernel) => {
        const isDefault = kernel.version === defaultVersion
        const pinned = profiles.filter((profile) => profile.kernelVersion === kernel.version).length
        return (
          <Space size={2}>
            <Button size="small" type="link" autoInsertSpace={false} onClick={() => setAssignTo(kernel.version)}>{t("分配给窗口")}</Button>
            <Button size="small" type="link" autoInsertSpace={false} loading={checking === kernel.version} onClick={() => void verify(kernel.version)}>{t("检查")}</Button>
            {isDefault
              ? <Tag color="blue" className="fb-inline-tag">{t("默认")}</Tag>
              : (
                  <>
                    <Button size="small" type="link" autoInsertSpace={false} onClick={() => void changeEngine(() => window.browserApi.engine.activate(kernel.version), () => t("已切换到内核 {0}", kernelName(kernel.version)))}>{t("设为默认")}</Button>
                    <Tooltip title={pinned ? t("还有 {0} 个窗口指定了这个内核，先给它们换内核", pinned) : kernel.origin === 'bundled' ? t("随应用内置的内核不能移除") : undefined}>
                      <Button size="small" type="link" danger autoInsertSpace={false} disabled={pinned > 0 || kernel.origin === 'bundled'} onClick={() => confirmRemove(kernel.version)}>{t("移除")}</Button>
                    </Tooltip>
                  </>
                )}
          </Space>
        )
      }
    }
  ]

  const targetOptions = [
    ...ready.map((kernel) => ({ value: kernel.version, label: `${kernelName(kernel.version)}${kernel.version === defaultVersion ? ` · ${t("默认")}` : ''}` })),
    { value: FOLLOW_DEFAULT, label: t("跟随默认内核") }
  ]
  const users = defaultVersion ? kernelUsers(profiles, defaultVersion, defaultVersion).length : profiles.filter((profile) => !profile.kernelVersion).length

  return (
    <div className="fb-stack">
      {engine && !engine.fingerprintKernel && (
        <Alert
          type={engine.executable ? 'warning' : 'error'}
          showIcon
          title={engine.executable ? t("当前运行在兼容模式") : t("尚未配置浏览器内核")}
          description={engine.executable ? t("当前内核不支持指纹配置，请在使用前切换到指纹内核。") : t("请先选择或导入浏览器内核。")}
          action={<Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => setDownloading(true)}>{t("在线下载内核")}</Button>}
        />
      )}
      <section className="fb-card fb-kernel-current">
        <DeploymentUnitOutlined className="fb-kernel-icon" />
        <div className="fb-kernel-summary">
          <div className="fb-kernel-title">
            <strong>{engine?.version ? kernelName(engine.version) : mt(engine?.label ?? t("未配置"))}</strong>
            <Tag color="blue">{t("默认内核")}</Tag>
            {current && <Tag>{originLabel(current.origin)}</Tag>}
          </div>
          <span className="fb-muted">
            {[
              engine?.fingerprintKernel ? t("Prism 内核 + {0} 个指纹补丁", kernelLock.patches.length) : t("兼容模式"),
              defaultVersion && health[defaultVersion]?.status === 'healthy' ? t("文件校验正常") : '',
              t("新建窗口默认使用"),
              t("{0} 个窗口在用", users)
            ].filter(Boolean).join(' · ')}
          </span>
          {engine?.executable && <span className="fb-mono fb-muted fb-ellipsis" title={engine.executable}>{engine.executable}</span>}
        </div>
        <Space wrap className="fb-kernel-actions">
          <Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => setDownloading(true)}>{t("在线下载内核")}</Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => void importKernel()}>{t("导入本地内核")}</Button>
          <Button icon={<ReloadOutlined />} disabled={!defaultVersion} loading={checking === defaultVersion} onClick={() => defaultVersion && void verify(defaultVersion)}>{t("重新校验")}</Button>
          {rollbackAvailable && (
            <Button
              icon={<RollbackOutlined />}
              onClick={() => Modal.confirm({
                title: t("回滚到上一个健康内核？"),
                content: t("请先关闭全部浏览器环境。"),
                okText: t("回滚上一版"),
                cancelText: t("取消"),
                onOk: () => changeEngine(() => window.browserApi.engine.rollback(), (version) => t("已回滚到 {0}", version ?? ''))
              })}
            >{t("回滚上一版")}</Button>
          )}
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'select', label: t("选择外部路径的内核") },
                { key: 'system', label: t("系统浏览器兼容模式") }
              ],
              onClick: ({ key }) => {
                if (key === 'select') void changeEngine(() => window.browserApi.engine.select(), () => t("自定义指纹内核已启用"))
                if (key === 'system') void changeEngine(() => window.browserApi.engine.useSystem(), () => t("已切换到系统浏览器兼容模式"))
              }
            }}
          >
            <Button>{t("更多")} <DownOutlined /></Button>
          </Dropdown>
        </Space>
      </section>

      <section className="fb-card">
        <div className="fb-card-title">{t("已安装的内核")}</div>
        <Table<KernelRelease>
          rowKey="version"
          size="middle"
          columns={columns}
          dataSource={kernels}
          pagination={false}
          locale={{ emptyText: t("没有找到本机已安装的内核") }}
        />
      </section>

      <section className="fb-card">
        <div className="fb-card-title">{t("给窗口指定内核")}</div>
        <div className="fb-form-grid">
          <span>{t("选择窗口")}</span>
          <div className="fb-inline-fields fb-no-margin">
            <Select
              value={scope}
              onChange={setScope}
              className="fb-wide-select"
              options={[
                { value: '__all__', label: t("全部窗口（{0} 个）", profiles.length) },
                ...groups.map((group) => ({ value: group.id, label: t("按分组：{0}（{1} 个）", group.name, group.profileCount) })),
                { value: '__ungrouped__', label: t("按分组：{0}（{1} 个）", t("未分组"), profiles.filter((profile) => !profile.groupId).length) }
              ]}
            />
            <span className="fb-muted">{t("也可以在窗口列表勾选后点“切换内核”")}</span>
          </div>
          <span>{t("目标内核")}</span>
          <Select value={target} onChange={setTarget} className="fb-wide-select" options={targetOptions} />
          <span />
          <div className="fb-inline-fields fb-no-margin">
            <Button type="primary" disabled={!scoped.length} loading={busy} onClick={() => void pin(scoped.map((profile) => profile.id), target)}>
              {t("应用到 {0} 个窗口", scoped.length)}
            </Button>
            <span className="fb-muted">
              {scopedRunning
                ? t("其中 {0} 个正在运行，要关闭后重新打开才生效；Cookie 和登录状态不受影响", scopedRunning)
                : t("运行中的窗口要关闭后重新打开才生效；Cookie 和登录状态不受影响")}
            </span>
          </div>
        </div>
      </section>

      <section className="fb-card">
        <div className="fb-card-title">{t("自己编译内核")}</div>
        <p className="fb-muted fb-no-margin">{t("编译脚本和补丁都在项目里，版本已锁定。建议 32 GB 内存、300 GB 固态硬盘，首次编译约 4–8 小时。编译完成后点“导入本地内核”，选择输出目录里的 chrome.exe。")}</p>
        <div className="fb-form-grid fb-compact">
          <span>{t("锁定版本")}</span>
          <span className="fb-mono">{kernelLock.chromiumVersion} · ungoogled-chromium-windows {kernelLock.platforms['windows-x64'].tag}</span>
          <span>{t("补丁")}</span>
          <span>{t("{0} 个（tools/kernel-patches）", kernelLock.patches.length)}</span>
          <span>{t("编译脚本")}</span>
          <span className="fb-mono">tools/windows-kernel</span>
        </div>
      </section>

      <PickWindowsModal
        open={assignTo !== null}
        title={assignTo ? t("把窗口切换到 {0}", kernelName(assignTo)) : ''}
        windows={profiles.filter((profile) => profile.kernelVersion !== assignTo)}
        detailTitle={t("当前内核")}
        detail={(window) => <span className="fb-mono fb-muted">{window.kernelVersion ? kernelName(window.kernelVersion) : t("跟随默认内核")}</span>}
        okText={t("切换")}
        busy={busy}
        onSubmit={(ids) => { if (assignTo) return pin(ids, assignTo) }}
        onClose={() => setAssignTo(null)}
      />
      <DownloadKernelModal
        open={downloading}
        onClose={() => setDownloading(false)}
        onInstalled={(status, version) => {
          ws.setEngine(status)
          void ws.reloadKernels()
          notify.success(t("内核 {0} 已安装", kernelName(version)))
        }}
      />
    </div>
  )
}
