import { Modal } from 'antd'
import { useEffect, useRef } from 'react'
import { formatList, getLocale, t } from '../../../shared/i18n'
import { effectiveNetworkIdentity } from '../../../shared/network-identity'
import { fontPackLabel, windowsFontScript, WINDOWS_FONT_PACKS } from '../../../shared/windows-font-packs'
import { useWorkspace } from '../data/workspace'

/**
 * Asks once whether to install the Windows language font packages that windows on prism6+
 * kernels need: a window shows the fonts of its interface language only when that language's
 * package is on this computer. Settings > General keeps the button afterwards.
 */
export function FontPackPrompt() {
  const ws = useWorkspace()
  const asked = useRef(false)

  useEffect(() => {
    if (asked.current || ws.loading || ws.preferences.fontPacksAsked) return
    // Scripts the windows on kernels with language fonts (prism6+) need.
    const needed = new Set<string>()
    for (const profile of ws.profiles) {
      const kernel = profile.kernelVersion ? ws.kernels.find((item) => item.version === profile.kernelVersion) : undefined
      const languageFonts = profile.kernelVersion ? kernel?.webrtcRelay : ws.engine?.webrtcRelay
      if (!languageFonts || profile.fingerprint.platform !== 'windows') continue
      const script = windowsFontScript(effectiveNetworkIdentity(profile.fingerprint, profile.proxyCheck, { allowGeoConflict: true }).uiLocale)
      if (script && WINDOWS_FONT_PACKS.some((pack) => pack.script === script)) needed.add(script)
    }
    if (!needed.size) return
    asked.current = true
    void window.browserApi.app.fontPacks().then((status) => {
      const missing = status.supported ? status.missing.filter((script) => needed.has(script)) : []
      if (!missing.length) return
      const names = formatList(missing.map((script) => fontPackLabel(script, getLocale())))
      const answered = () => ws.setPreferences({ fontPacksAsked: true })
      Modal.confirm({
        title: t("安装语言字体包？"),
        content: t("有窗口的界面语言是{0}，这台电脑还没有对应的 Windows 字体包，窗口里会缺少这些字体。可以从微软安装所有语言的字体包，需要确认一次管理员权限，下载可能要几分钟。以后也可以在 设置 → 常规 → 语言字体 安装。", names),
        okText: t("从微软安装"),
        cancelText: t("以后再说"),
        onOk: async () => {
          await answered()
          try {
            const after = await window.browserApi.app.installFontPacks()
            if (after.missing.length) ws.notify.warning(t("还有字体包没装上：{0}", formatList(after.missing.map((script) => fontPackLabel(script, getLocale())))))
            else ws.notify.success(t("已安装全部语言字体"))
          } catch (error) {
            ws.fail(error)
          }
        },
        onCancel: () => { void answered() }
      })
    }).catch(() => undefined)
  }, [ws.loading, ws.profiles, ws.kernels, ws.engine, ws.preferences.fontPacksAsked])

  return null
}
