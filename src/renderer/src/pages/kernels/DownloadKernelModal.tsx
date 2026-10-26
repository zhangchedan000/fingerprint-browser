import { Alert, Button, Modal, Progress, Table, Tag, Tooltip, type TableColumnsType } from 'antd'
import { useEffect, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import type { EngineStatus, KernelInstallProgress, KernelRelease } from '../../../../shared/types'
import { formatBytes, humanError } from '../../components/format'
import { kernelName, kernelVendor } from '../../../../shared/kernel-id'

interface Props {
  open: boolean
  onClose: () => void
  /** Called with the new default kernel once one is installed. */
  onInstalled: (status: EngineStatus, version: string) => void
}

/** Lists Prism kernel releases for this system; one click downloads, checks, installs and makes it the default. */
export function DownloadKernelModal({ open, onClose, onInstalled }: Props) {
  const [releases, setReleases] = useState<KernelRelease[]>()
  const [error, setError] = useState<string>()
  const [installing, setInstalling] = useState<string | null>(null)
  const [progress, setProgress] = useState<KernelInstallProgress>()

  useEffect(() => {
    if (!open) return
    setError(undefined)
    setReleases(undefined)
    window.browserApi.engine.releases()
      .then((items) => setReleases(items.filter((item) => item.remoteAvailable)))
      .catch((reason: unknown) => setError(humanError(reason)))
  }, [open])

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
    { title: t("发布时间"), dataIndex: 'publishedAt', render: (value: string) => value.slice(0, 10) },
    { title: t("大小"), dataIndex: 'size', render: (size: number) => formatBytes(size) },
    {
      title: t("操作"),
      align: 'right',
      render: (_, release) => release.installed
        ? <span className="fb-muted">{t("已安装")}</span>
        : (
          <Button size="small" type={release.version === recommended ? 'primary' : 'default'} disabled={Boolean(installing)} loading={installing === release.version} onClick={() => void install(release.version)}>
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
      width={640}
      maskClosable={!installing}
      closable={!installing}
      onCancel={onClose}
      footer={installing
        ? <Button onClick={() => void window.browserApi.engine.cancelInstall(installing)}>{t("取消下载")}</Button>
        : <Button onClick={onClose}>{t("关闭")}</Button>}
    >
      <p className="fb-muted">{t("我们自己编译的 Prism 内核，下载后会校验文件完整性再安装，并设为默认内核。")}</p>
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
