import { Alert, Button, Input, Modal, Progress, Space, Switch, Table, Tag, type TableColumnsType } from 'antd'
import { useEffect, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import type { EngineStatus, KernelInstallProgress, KernelRelease } from '../../../../shared/types'
import { formatBytes, humanError } from '../../components/format'
import { kernelChromiumVersion, kernelName, kernelVendor } from '../../../../shared/kernel-id'
import { isOfficialKernelSource, normalizeKernelSource } from '../../../../shared/kernel-sources'

interface Props {
  open: boolean
  onClose: () => void
  /** Called with the new default kernel once one is installed. */
  onInstalled: (status: EngineStatus, version: string) => void
}

/** Builds of one version share its id; the release tag tells them apart. */
const rowKey = (release: KernelRelease) => `${release.version}|${release.tag ?? ''}|${release.history ? 'h' : ''}`

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/**
 * Lists kernel releases from the added GitHub projects; one click downloads, checks and installs.
 * An installed kernel with a newer build of its version shows "update", which replaces it in place;
 * "历史版本" also lists the older builds, to roll a kernel back the same way.
 */
export function DownloadKernelModal({ open, onClose, onInstalled }: Props) {
  const [releases, setReleases] = useState<KernelRelease[]>()
  const [error, setError] = useState<string>()
  const [installing, setInstalling] = useState<string | null>(null)
  const [progress, setProgress] = useState<KernelInstallProgress>()
  const [sources, setSources] = useState<string[]>([])
  const [sourceInput, setSourceInput] = useState('')
  const [sourceError, setSourceError] = useState<string>()
  const [reload, setReload] = useState(0)
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    if (!open) return
    void window.browserApi.engine.sources().then(setSources).catch(() => undefined)
  }, [open])

  useEffect(() => {
    if (!open) return
    setError(undefined)
    setReleases(undefined)
    window.browserApi.engine.releases()
      .then((items) => setReleases(items
        .filter((item) => item.remoteAvailable)
        .sort((a, b) => compareVersions(kernelChromiumVersion(b.version), kernelChromiumVersion(a.version)) || b.publishedAt.localeCompare(a.publishedAt))))
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
    if (!release.source || isOfficialKernelSource(release.source)) {
      void install(release)
      return
    }
    Modal.confirm({
      title: t("从第三方项目下载内核？"),
      content: t("内核来自 {0}，下载后会在这台电脑上运行。请确认这个项目可信；第三方内核可能不支持全部指纹参数。", release.source),
      okText: t("下载"),
      cancelText: t("取消"),
      onOk: () => void install(release)
    })
  }

  useEffect(() => window.browserApi.engine.onProgress(setProgress), [])

  async function install(release: KernelRelease): Promise<void> {
    const { version } = release
    setInstalling(rowKey(release))
    setProgress(undefined)
    setError(undefined)
    try {
      const status = await window.browserApi.engine.install(version, release.history ? release.tag : undefined)
      onInstalled(status, version)
      onClose()
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setInstalling(null)
    }
  }

  const main = releases?.filter((release) => kernelVendor(release.version) === 'prism' && !release.history)
  const historyCount = releases?.filter((release) => release.history).length ?? 0
  const shown = releases?.filter((release) => showHistory || !release.history)
  // The highest Chromium version; rows are already sorted by it.
  const latest = main?.[0]?.version
  /** Newest release without a known kernel bug: the one the dialog highlights. */
  const recommended = latest
  const columns: TableColumnsType<KernelRelease> = [
    {
      title: t("版本"),
      dataIndex: 'version',
      render: (version: string, release) => (
        <span>
          {kernelName(version)}
          {release.history && release.tag && <span className="fb-muted"> · {release.tag}</span>}
          {!release.history && version === latest && <Tag color="blue" className="fb-inline-tag">{t("最新")}</Tag>}
          {release.update && <Tag color="orange" className="fb-inline-tag">{t("有更新")}</Tag>}
          {!release.history && version === recommended && version !== latest && <Tag color="green" className="fb-inline-tag">{t("推荐")}</Tag>}
        </span>
      )
    },
    { title: t("来源"), dataIndex: 'source', render: (source?: string) => <span className="fb-muted">{source}</span> },
    { title: t("发布时间"), dataIndex: 'publishedAt', render: (value: string) => value.slice(0, 10) },
    { title: t("大小"), dataIndex: 'size', render: (size: number) => formatBytes(size) },
    {
      title: t("操作"),
      align: 'right',
      render: (_, release) => release.history
        ? release.installed
          ? <span className="fb-muted">{t("当前版本")}</span>
          : (
            <Button size="small" disabled={Boolean(installing)} loading={installing === rowKey(release)} onClick={() => confirmInstall(release)}>
              {release.executable ? t("回退到此版本") : t("下载")}
            </Button>
          )
        : release.installed && release.update
        ? (
          <Button size="small" type="primary" disabled={Boolean(installing)} loading={installing === rowKey(release)} onClick={() => confirmInstall(release)}>
            {t("更新")}
          </Button>
        )
        : release.installed
        ? <span className="fb-muted">{t("已安装")}</span>
        : (
          <Button size="small" type={release.version === recommended ? 'primary' : 'default'} disabled={Boolean(installing)} loading={installing === rowKey(release)} onClick={() => confirmInstall(release)}>
            {t("下载")}
          </Button>
        )
    }
  ]

  const installingVersion = installing?.split('|')[0]
  const active = installingVersion && progress?.version === installingVersion ? progress : undefined
  return (
    <Modal
      open={open}
      title={t("在线下载内核")}
      width={760}
      maskClosable={!installing}
      closable={!installing}
      onCancel={onClose}
      footer={installing
        ? <Button onClick={() => void window.browserApi.engine.cancelInstall(installingVersion ?? installing)}>{t("取消下载")}</Button>
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
      {historyCount > 0 && (
        <Space size={8} className="fb-block-gap">
          <Switch size="small" checked={showHistory} onChange={setShowHistory} />
          <span>{t("历史版本")}</span>
          <span className="fb-muted">{t("较早的构建，可以把已安装的内核回退过去；只增不删，随时能换回来")}</span>
        </Space>
      )}
      <Table<KernelRelease>
        rowKey={rowKey}
        size="small"
        columns={columns}
        dataSource={shown ?? []}
        loading={!releases && !error}
        pagination={false}
        locale={{ emptyText: t("没有适用于当前系统的内核版本") }}
      />
    </Modal>
  )
}
