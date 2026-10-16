import { Alert, Button, Modal, Progress, Table, Tag, type TableColumnsType } from 'antd'
import { useEffect, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import type { EngineStatus, KernelInstallProgress, KernelRelease } from '../../../../shared/types'
import { formatBytes, humanError } from '../../components/format'

interface Props {
  open: boolean
  onClose: () => void
  /** Called with the new default kernel once one is installed. */
  onInstalled: (status: EngineStatus) => void
}

/** Lists fingerprint-chromium releases for this system; one click downloads, checks, installs and makes it the default. */
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
      onInstalled(status)
      onClose()
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setInstalling(null)
    }
  }

  const latest = releases?.[0]?.version
  const columns: TableColumnsType<KernelRelease> = [
    {
      title: t("版本"),
      dataIndex: 'version',
      render: (version: string) => (
        <span>Chromium {version} {version === latest && <Tag color="blue" className="fb-inline-tag">{t("最新")}</Tag>}</span>
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
          <Button size="small" type={release.version === latest ? 'primary' : 'default'} disabled={Boolean(installing)} loading={installing === release.version} onClick={() => void install(release.version)}>
            {t("下载并启用")}
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
      <p className="fb-muted">{t("来自 fingerprint-chromium 官方发布，下载后会校验文件完整性再安装，并设为默认内核。")}</p>
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
