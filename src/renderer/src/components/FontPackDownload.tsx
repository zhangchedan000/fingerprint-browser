import { Alert, Button, Progress, Space } from 'antd'
import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import { windowsFontPack, type FontPackProgress, type FontPackStatus } from '../../../shared/windows-font-packs'
import { humanError } from './format'

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)

/**
 * Downloads language font packages from Microsoft and installs them for this user, with the
 * progress of the package being downloaded. Used where a missing package shows: a window's font
 * row and Settings.
 */
export function FontPackDownload({ scripts, onInstalled }: { scripts: string[]; onInstalled: (status: FontPackStatus) => void }) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<FontPackProgress>()
  const [error, setError] = useState<string>()
  const key = scripts.join(',')
  const totalBytes = scripts.reduce((sum, script) => sum + (windowsFontPack(script)?.size ?? 0), 0)

  useEffect(() => window.browserApi.app.onFontPackProgress((next) => {
    if (scripts.includes(next.script)) setProgress(next)
  }), [key])

  async function download(): Promise<void> {
    setBusy(true)
    setError(undefined)
    setProgress(undefined)
    try {
      onInstalled(await window.browserApi.app.installFontPacks(scripts))
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setBusy(false)
    }
  }

  if (!scripts.length) return null
  // Packages download one after another; count the finished ones and the current one's bytes.
  const current = progress ? scripts.indexOf(progress.script) : -1
  const doneBytes = scripts.slice(0, Math.max(current, 0)).reduce((sum, script) => sum + (windowsFontPack(script)?.size ?? 0), 0)
  const receivedBytes = doneBytes + (progress?.receivedBytes ?? 0)
  return (
    <div className="fb-font-pack-download">
      {busy ? (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Progress size="small" percent={totalBytes ? Math.floor(receivedBytes / totalBytes * 100) : 0} status="active" />
          <span className="fb-muted">
            {progress?.stage === 'installing'
              ? t("正在安装字体…")
              : t("正在从微软下载 {0} / {1} MB", megabytes(receivedBytes), megabytes(totalBytes))}
          </span>
        </Space>
      ) : (
        <Button size="small" type="primary" onClick={() => void download()}>
          {t("下载字体包（{0} MB）", megabytes(totalBytes))}
        </Button>
      )}
      {error && <Alert type="error" showIcon message={error} />}
    </div>
  )
}
