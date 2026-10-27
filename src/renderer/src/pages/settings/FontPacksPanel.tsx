import { Space } from 'antd'
import { useEffect, useState } from 'react'
import { formatList, getLocale, t } from '../../../../shared/i18n'
import { fontPackLabel, type FontPackStatus } from '../../../../shared/windows-font-packs'
import { FontPackDownload } from '../../components/FontPackDownload'

/**
 * Windows language font packages. A window shows the fonts of its interface language only when
 * that language's package is on this computer; one click downloads the missing ones from Microsoft.
 */
export function FontPacksPanel() {
  const [status, setStatus] = useState<FontPackStatus>()

  useEffect(() => { void window.browserApi.app.fontPacks().then(setStatus).catch(() => undefined) }, [])

  if (!status) return <span className="fb-muted">{t("正在检查…")}</span>
  if (!status.supported) return <span className="fb-muted">{t("仅 Windows 需要")}</span>
  const names = (scripts: string[]) => formatList(scripts.map((script) => fontPackLabel(script, getLocale())))
  return (
    <div className="fb-update-panel">
      <Space wrap>
        {status.missing.length === 0
          ? <span className="fb-muted">{t("已安装全部语言字体")}</span>
          : <span>{t("缺少：{0}", names(status.missing))}</span>}
      </Space>
      <FontPackDownload scripts={status.missing} onInstalled={setStatus} />
      <div className="fb-muted">
        {t("窗口按系统语言显示该语言 Windows 自带的字体，需要先在本机安装对应的语言字体包。从微软官方下载，只给当前用户安装，不需要管理员权限。")}
      </div>
    </div>
  )
}
