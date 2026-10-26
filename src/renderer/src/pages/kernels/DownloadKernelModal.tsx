import { Alert, Button, Input, Modal, Progress, Space, Table, Tag, type TableColumnsType } from 'antd'
import { useEffect, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import type { EngineStatus, KernelInstallProgress, KernelRelease } from '../../../../shared/types'
import { formatBytes, humanError } from '../../components/format'
import { kernelName, kernelVendor } from '../../../../shared/kernel-id'
import { normalizeKernelSource, OFFICIAL_KERNEL_SOURCE } from '../../../../shared/kernel-sources'

interface Props {
  open: boolean
  onClose: () => void
  /** Called with the new default kernel once one is installed. */
  onInstalled: (status: EngineStatus, version: string) => void
}

/** Lists kernel releases from the added GitHub projects; one click downloads, checks and installs. */
export function DownloadKernelModal({ open, onClose, onInstalled }: Props) {
  const [releases, setReleases] = useState<KernelRelease[]>()
  const [error, setError] = useState<string>()
  const [installing, setInstalling] = useState<string | null>(null)
  const [progress, setProgress] = useState<KernelInstallProgress>()
  const [sources, setSources] = useState<string[]>([])
  const [sourceInput, setSourceInput] = useState('')
  const [sourceError, setSourceError] = useState<string>()
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    void window.browserApi.engine.sources().then(setSources).catch(() => undefined)
  }, [open])

  useEffect(() => {
    if (!open) return
    setError(undefined)
    setReleases(undefined)
    window.browserApi.engine.releases()
      .then((items) => setReleases(items.filter((item) => item.remoteAvailable)))
      .catch((reason: unknown) => setError(humanError(reason)))
  }, [open, reload])

  async function saveSources(next: string[]): Promise<void> {
    try {
      setSources(await window.browserApi.engine.setSources(next))
      setReload((value) => value + 1)
    } catch (reason) {
      setSourceError(humanError(reason))
    }
  }

  function addSource(): void {
    const source = normalizeKernelSource(sourceInput)
    if (!source) {
      setSourceError(t("请粘贴 GitHub 项目地址，例如 https://github.com/owner/repo"))
      return
    }
    setSourceError(undefined)
    setSourceInput('')
    if (!sources.some((item) => item.toLowerCase() === source.toLowerCase())) void saveSources([...sources, source])
  }

  function confirmInstall(release: KernelRelease): void {
    if (!release.source || release.source === OFFICIAL_KERNEL_SOURCE) {
      void install(release.version)
      return
    }
    Modal.confirm({
      title: t("从第三方项目下载内核？"),
      content: t("内核来自 {0}，下载后会在这台电脑上运行。请确认这个项目可信；第三方内核可能不支持全部指纹参数。", release.source),
      okText: t("下载"),
      cancelText: t("取消"),
      onOk: () => void install(release.version)
    })
  }

  useEffect(() => window.browserApi.engine.onProgress(setProgress), [])

  async function install(version: string): Promise<void> {
    setInstalling(version)
    setProgress(undefined)
    setError(undefined)
    try {
      const status = await window.browserApi.engine.install(version)
      onInstalled(status, version)
      onClose()
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setInstalling(null)
    }
  }

  const main = releases?.filter((release) => kernelVendor(release.version) === 'prism')
  const latest = main?.[0]?.version
  /** Newest release without a known kernel bug: the one the dialog highlights. */
  const recommended = latest
  const columns: TableColumnsType<KernelRelease> = [
    {
      title: t("版本"),
      dataIndex: 'version',
      render: (version: string) => (
        <span>
          {kernelName(version)}
          {version === latest && <Tag color="blue" className="fb-inline-tag">{t("最新")}</Tag>}
          {version === recommended && version !== latest && <Tag color="green" className="fb-inline-tag">{t("推荐")}</Tag>}
        </span>
      )
    },
    { title: t("来源"), dataIndex: 'source', render: (source?: string) => <span className="fb-muted">{source}</span> },
    { title: t("发布时间"), dataIndex: 'publishedAt', render: (value: string) => value.slice(0, 10) },
    { title: t("大小"), dataIndex: 'size', render: (size: number) => formatBytes(size) },
    {
      title: t("操作"),
      align: 'right',
      render: (_, release) => release.installed
        ? <span className="fb-muted">{t("已安装")}</span>
        : (
          <Button size="small" type={release.version === recommended ? 'primary' : 'default'} disabled={Boolean(installing)} loading={installing === release.version} onClick={() => confirmInstall(release)}>
            {t("下载")}
          </Button>
        )
    }
  ]

  const active = installing && progress?.version === installing ? progress : undefined
  return (
    <Modal
      open={open}
      title={t("在线下载内核")}
      width={760}
      maskClosable={!installing}
      closable={!installing}
      onCancel={onClose}
      footer={installing
        ? <Button onClick={() => void window.browserApi.engine.cancelInstall(installing)}>{t("取消下载")}</Button>
        : <Button onClick={onClose}>{t("关闭")}</Button>}
    >
      <p className="fb-muted">{t("从下面的 GitHub 项目列出 Windows 内核，下载后会校验 SHA-256 再安装。")}</p>
      <div className="fb-block-gap">
        <Space wrap size={[6, 6]}>
          {sources.map((source) => (
            <Tag key={source} closable={!installing} onClose={(event) => { event.preventDefault(); void saveSources(sources.filter((item) => item !== source)) }}>
              {source}
            </Tag>
          ))}
          {!sources.length && <span className="fb-muted">{t("还没有内核来源，先添加一个 GitHub 项目")}</span>}
        </Space>
        <Space.Compact style={{ width: '100%', marginTop: 8 }}>
          <Input
            value={sourceInput}
            placeholder={t("粘贴 GitHub 项目地址，例如 https://github.com/owner/repo")}
            onChange={(event) => { setSourceInput(event.target.value); setSourceError(undefined) }}
            onPressEnter={addSource}
            disabled={Boolean(installing)}
          />
          <Button onClick={addSource} disabled={Boolean(installing) || !sourceInput.trim()}>{t("添加来源")}</Button>
        </Space.Compact>
        {sourceError && <Alert type="error" showIcon title={sourceError} style={{ marginTop: 8 }} />}
      </div>
      {error && <Alert type="error" showIcon title={error} className="fb-block-gap" />}
      {active && (
        <div className="fb-block-gap">
          <Progress percent={Math.round(active.percent)} status={active.stage === 'error' ? 'exception' : 'active'} />
          <span className="fb-muted">
            {mt(active.message)}
            {active.stage === 'downloading' && active.totalBytes > 0 && ` · ${formatBytes(active.receivedBytes)} / ${formatBytes(active.totalBytes)}`}
          </span>
        </div>
      )}
      <Table<KernelRelease>
        rowKey="version"
        size="small"
        columns={columns}
        dataSource={releases ?? []}
        loading={!releases && !error}
        pagination={false}
        locale={{ emptyText: t("没有适用于当前系统的内核版本") }}
      />
    </Modal>
  )
}
