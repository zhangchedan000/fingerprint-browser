import { Alert, Button, Space } from 'antd'
import { useEffect, useState } from 'react'
import { formatList, getLocale, t } from '../../../../shared/i18n'
import { fontPackLabel, type FontPackStatus } from '../../../../shared/windows-font-packs'
import { humanError } from '../../components/format'

/**
 * Windows language font packages. A window shows the fonts of its interface language only when
 * that language's package is on this computer; one click installs the missing ones from Microsoft.
 */
export function FontPacksPanel() {
  const [status, setStatus] = useState<FontPackStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => { void window.browserApi.app.fontPacks().then(setStatus).catch(() => undefined) }, [])

  async function install(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      setStatus(await window.browserApi.app.installFontPacks())
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <span className="fb-muted">{t("正在检查…")}</span>
  if (!status.supported) return <span className="fb-muted">{t("仅 Windows 需要")}</span>
  const names = (scripts: string[]) => formatList(scripts.map((script) => fontPackLabel(script, getLocale())))
  return (
    <div className="fb-update-panel">
      <Space wrap>
        {status.missing.length === 0
          ? <span className="fb-muted">{t("已安装全部语言字体")}</span>
          : <span>{t("缺少：{0}", names(status.missing))}</span>}
        {status.missing.length > 0 && (
          <Button size="small" type="primary" loading={busy} onClick={() => void install()}>{t("从微软安装")}</Button>
        )}
      </Space>
      <div className="fb-muted">
        {busy
          ? t("正在从 Windows 更新下载，可能需要几分钟，请勿关闭。")
          : t("窗口按系统语言显示该语言 Windows 自带的字体，需要先在本机安装对应的语言字体包。安装只需确认一次管理员权限。")}
      </div>
      {error && <Alert type="error" showIcon message={error} />}
    </div>
  )
}
