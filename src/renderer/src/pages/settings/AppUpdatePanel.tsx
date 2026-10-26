import { Alert, Button, Progress, Space } from 'antd'
import { useEffect, useState } from 'react'
import { t } from '../../../../shared/i18n'
import type { AppUpdateInfo, AppUpdateProgress } from '../../../../shared/types'
import { formatBytes, humanError } from '../../components/format'

/** Checks this app's newest GitHub release; one click downloads, verifies and installs it. */
export function AppUpdatePanel() {
  const [info, setInfo] = useState<AppUpdateInfo>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const [progress, setProgress] = useState<AppUpdateProgress>()

  useEffect(() => window.browserApi.app.onUpdateProgress(setProgress), [])
  useEffect(() => { void check() }, [])

  async function run(kind: 'check' | 'download' | 'install', action: () => Promise<AppUpdateInfo | void>): Promise<void> {
    setBusy(kind)
    setError(undefined)
    try {
      const result = await action()
      if (result) setInfo(result)
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setBusy(null)
    }
  }
  const check = () => run('check', () => window.browserApi.app.checkUpdate())
  const download = () => run('download', () => window.browserApi.app.downloadUpdate())
  const install = () => run('install', () => window.browserApi.app.installUpdate())

  const percent = progress && progress.totalBytes ? Math.round((progress.receivedBytes / progress.totalBytes) * 100) : 0
  return (
    <div className="fb-update-panel">
      <Space wrap>
        {info?.available
          ? <strong>{t("发现新版本 v{0}", info.latest ?? '')}</strong>
          : <span className="fb-muted">{info ? t("已是最新版本") : t("正在检查更新…")}</span>}
        <Button size="small" loading={busy === 'check'} disabled={Boolean(busy)} onClick={() => void check()}>{t("检查更新")}</Button>
        {info?.available && !info.downloaded && info.canInstall && (
          <Button size="small" type="primary" loading={busy === 'download'} disabled={Boolean(busy)} onClick={() => void download()}>
            {t("下载更新")}{info.size ? ` · ${formatBytes(info.size)}` : ''}
          </Button>
        )}
        {info?.available && info.downloaded && (
          <Button size="small" type="primary" loading={busy === 'install'} disabled={Boolean(busy)} onClick={() => void install()}>{t("立即重启并更新")}</Button>
        )}
        {info?.available && !info.canInstall && (
          <Button size="small" type="link" onClick={() => void window.browserApi.app.openUpdatePage()}>{t("打开下载页")}</Button>
        )}
      </Space>
      {busy === 'download' && <Progress percent={percent} size="small" />}
      {error && <Alert type="error" showIcon title={error} />}
      {info?.available && info.notes && (
        <div className="fb-update-notes">
          <div className="fb-muted">{t("更新内容")}{info.publishedAt ? ` · ${info.publishedAt.slice(0, 10)}` : ''}</div>
          <pre>{info.notes}</pre>
        </div>
      )}
    </div>
  )
}
