import { Button, InputNumber, Modal, Progress, Radio, Select, Switch, Tooltip } from 'antd'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { t } from '../../../../shared/i18n'
import type { AppInfo, RelocateProgress, StorageOverview, VaultLocationInfo } from '../../../../shared/types'
import { formatBytes, isEditable } from '../../components/format'
import { LanguageSelector } from '../../components/LanguageSelector'
import { useWorkspaceMigration } from '../../data/migration'
import { useWorkspace } from '../../data/workspace'
import { kernelName } from '../../../../shared/kernel-id'
import { TunnelSettings } from './TunnelSettings'
import { AppUpdatePanel } from './AppUpdatePanel'
import type { PageProps } from '../registry'

type SettingsTab = 'general' | 'launch' | 'network' | 'data' | 'about'

/** One label + control row. */
function Item({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <span className="fb-settings-label">{label}</span>
      <div className="fb-settings-control">{children}</div>
    </>
  )
}

/** A setting the app cannot do yet: shown with its intended value, not clickable. */
function NotYet({ children }: { children: ReactNode }) {
  return <Tooltip title={t("该功能正在开发中")}><span className="fb-unsupported">{children}</span></Tooltip>
}

/** Settings (design: Settings.dc.html). */
export function SettingsPage({ params }: Partial<PageProps> = {}) {
  const ws = useWorkspace()
  const { preferences, notify, engine, profiles } = ws
  const migration = useWorkspaceMigration()
  const [tab, setTab] = useState<SettingsTab>(params?.settingsTab ?? 'general')
  useEffect(() => { if (params?.settingsTab) setTab(params.settingsTab) }, [params?.settingsTab])
  const [info, setInfo] = useState<AppInfo>()
  const [storage, setStorage] = useState<StorageOverview>()
  // Chrome's own download folder, shown while Settings → 下载位置 is unset.
  const [systemDownloads, setSystemDownloads] = useState<string>()
  useEffect(() => { void window.browserApi.app.defaultDownloadFolder().then(setSystemDownloads).catch(() => undefined) }, [])

  async function chooseDownloadFolder(): Promise<void> {
    const folder = await window.browserApi.app.chooseDownloadFolder()
    if (folder) await ws.setPreferences({ downloadFolder: folder })
  }
  const [clearing, setClearing] = useState(false)
  const [gap, setGap] = useState(preferences.batchLaunchGapSeconds)

  const [location, setLocation] = useState<VaultLocationInfo>()
  const [moving, setMoving] = useState<RelocateProgress | 'picking'>()

  useEffect(() => { setGap(preferences.batchLaunchGapSeconds) }, [preferences.batchLaunchGapSeconds])
  useEffect(() => {
    void window.browserApi.app.vaultLocation().then(setLocation).catch(() => undefined)
    return window.browserApi.app.onRelocateProgress(setMoving)
  }, [])

  function relocate(): void {
    Modal.confirm({
      title: t("更改数据目录位置"),
      content: t("会把全部窗口、Cookie、代理、扩展和内核复制到你选的空文件夹，校验无误后自动重启并改用新位置。旧位置的数据会保留，确认没问题后可以删除。需要先关闭全部窗口。"),
      okText: t("选择文件夹"),
      cancelText: t("取消"),
      onOk: async () => {
        setMoving('picking')
        try {
          const target = await window.browserApi.app.relocateVault()
          if (target) notify.success(t("迁移完成，正在重启…"))
          else setMoving(undefined)
        } catch (error) {
          setMoving(undefined)
          ws.fail(error)
        }
      }
    })
  }

  function deletePrevious(): void {
    Modal.confirm({
      title: t("删除旧位置的数据？"),
      content: location?.previous,
      okText: t("删除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          setLocation(await window.browserApi.app.deletePreviousVault())
          notify.success(t("旧位置的数据已删除"))
        } catch (error) {
          ws.fail(error)
        }
      }
    })
  }

  function revert(): void {
    Modal.confirm({
      title: t("改回旧位置？"),
      content: t("旧位置保存的是迁移那一刻的数据；之后在新位置做的修改不会带回去。软件会自动重启。"),
      okText: t("改回"),
      cancelText: t("取消"),
      onOk: () => window.browserApi.app.revertVault().catch(ws.fail)
    })
  }
  useEffect(() => {
    void window.browserApi.app.info().then(setInfo).catch(ws.fail)
    void window.browserApi.profiles.storageOverview().then(setStorage).catch(() => undefined)
  }, [ws.fail])

  async function save(patch: Parameters<typeof ws.setPreferences>[0]): Promise<void> {
    try {
      await ws.setPreferences(patch)
    } catch (error) {
      ws.fail(error)
    }
  }

  function clearCaches(): void {
    const closed = profiles.filter(isEditable)
    Modal.confirm({
      title: t("清理 {0} 个窗口的缓存？", closed.length),
      content: t("只清理已关闭窗口的缓存文件；Cookie、登录状态和扩展数据不受影响。运行中的窗口会跳过。"),
      okText: t("清理"),
      cancelText: t("取消"),
      onOk: async () => {
        setClearing(true)
        try {
          for (const profile of closed) await window.browserApi.profiles.clearCache(profile.id)
          setStorage(await window.browserApi.profiles.storageOverview())
          notify.success(t("已清理 {0} 个窗口的缓存", closed.length))
        } catch (error) {
          ws.fail(error)
        } finally {
          setClearing(false)
        }
      }
    })
  }

  const tabs: Array<[SettingsTab, string]> = [['general', t("常规")], ['launch', t("窗口启动")], ['network', t("网络加速")], ['data', t("数据与备份")], ['about', t("关于")]]
  return (
    <div className="fb-settings">
      <nav className="fb-settings-tabs" role="tablist" aria-orientation="vertical">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
      <section className="fb-card fb-settings-panel">
        {tab === 'general' && (
          <>
            <h2>{t("常规")}</h2>
            <div className="fb-settings-grid">
              <Item label={t("启动器语言")}><LanguageSelector /></Item>
              <Item label={t("主题")}>
                <Radio.Group
                  optionType="button"
                  value={preferences.theme}
                  onChange={(event) => void save({ theme: event.target.value })}
                  options={[{ value: 'light', label: t("浅色") }, { value: 'dark', label: t("深色") }, { value: 'system', label: t("跟随系统") }]}
                />
              </Item>
              <Item label={t("关闭主界面时")}>
                <NotYet><Select disabled value="quit" className="fb-wide-select" options={[{ value: 'quit', label: t("退出并关闭所有窗口") }]} /></NotYet>
              </Item>
            </div>
          </>
        )}
        {tab === 'launch' && (
          <>
            <h2>{t("窗口启动")}</h2>
            <div className="fb-settings-grid">
              <Item label={t("最多同时运行")}>
                <NotYet><InputNumber disabled placeholder={t("不限")} /></NotYet>
                <span className="fb-muted">{t("个窗口")}</span>
              </Item>
              <Item label={t("批量打开间隔")}>
                <InputNumber
                  min={0.5}
                  max={30}
                  step={0.5}
                  value={gap}
                  onChange={(value) => setGap(Number(value ?? preferences.batchLaunchGapSeconds))}
                  onBlur={() => { if (gap !== preferences.batchLaunchGapSeconds) void save({ batchLaunchGapSeconds: gap }) }}
                />
                <span className="fb-muted">{t("秒，避免同时打开过多")}</span>
              </Item>
              <Item label={t("打开前检测代理")}>
                <Tooltip title={t("为了不用本机 IP 登录，这一项始终开启")}><Switch checked disabled /></Tooltip>
                <span className="fb-muted">{t("代理不通时不打开窗口，防止用本机 IP 登录")}</span>
              </Item>
              <Item label={t("IP 与时区不一致时")}>
                <span className="fb-muted">{t("由每个窗口的“按 IP 匹配”决定；GeoIP 数据源冲突时打开前会提醒确认")}</span>
              </Item>
            </div>
          </>
        )}
        {tab === 'network' && <TunnelSettings />}
        {tab === 'data' && (
          <>
            <h2>{t("数据与备份")}</h2>
            <div className="fb-settings-grid">
              <Item label={t("数据目录")}>
                <span className="fb-mono fb-ellipsis" title={info?.vaultPath}>{info?.vaultPath ?? '—'}</span>
                <Button size="small" type="link" autoInsertSpace={false} onClick={() => void window.browserApi.app.openFolder('vault').catch(ws.fail)}>{t("打开")}</Button>
                <Button size="small" type="link" autoInsertSpace={false} loading={Boolean(moving)} onClick={relocate}>{t("更改位置")}</Button>
              </Item>
              <Item label={t("下载位置")}>
                <span className="fb-mono fb-ellipsis" title={ws.preferences.downloadFolder ?? systemDownloads}>
                  {ws.preferences.downloadFolder ?? t("系统默认 · {0}", systemDownloads ?? '—')}
                </span>
                <Button size="small" type="link" autoInsertSpace={false} onClick={() => void window.browserApi.app.openDownloadFolder().catch(ws.fail)}>{t("打开")}</Button>
                <Button size="small" type="link" autoInsertSpace={false} onClick={() => void chooseDownloadFolder().catch(ws.fail)}>{t("更改位置")}</Button>
                {ws.preferences.downloadFolder && (
                  <Button size="small" type="link" autoInsertSpace={false} onClick={() => void ws.setPreferences({ downloadFolder: undefined }).catch(ws.fail)}>{t("恢复默认")}</Button>
                )}
              </Item>
              {ws.preferences.downloadFolder && (
                <Item label={t("按窗口分开")}>
                  <Switch
                    size="small"
                    checked={ws.preferences.downloadPerWindow === true}
                    onChange={(downloadPerWindow) => void ws.setPreferences({ downloadPerWindow }).catch(ws.fail)}
                  />
                  <span className="fb-muted">{t("每个窗口下载到自己的子文件夹，比如「18 环境 1」")}</span>
                </Item>
              )}
              <span />
              <span className="fb-muted">{t("窗口里下载的文件存到这里，下次打开窗口生效；窗口里在 Chrome 设置中单独改过的会被这里覆盖。")}</span>
              {location?.previous && (
                <Item label={t("旧位置")}>
                  <span className="fb-mono fb-ellipsis" title={location.previous}>{location.previous}</span>
                  <Button size="small" type="link" danger autoInsertSpace={false} onClick={deletePrevious}>{t("删除旧数据")}</Button>
                  <Button size="small" type="link" autoInsertSpace={false} onClick={revert}>{t("改回旧位置")}</Button>
                </Item>
              )}
              <Item label={t("已用空间")}>
                <span>{storage ? t("{0}（{1} 个窗口）", formatBytes(storage.totalBytes), profiles.length) : '—'}</span>
                <Button size="small" type="link" autoInsertSpace={false} loading={clearing} onClick={clearCaches}>{t("清理缓存")}</Button>
              </Item>
              <Item label={t("全部环境迁移")}>
                <Button onClick={() => migration.start('export')}>{t("导出加密迁移包")}</Button>
                <Button onClick={() => migration.start('import')}>{t("导入迁移包")}</Button>
              </Item>
              <span />
              <span className="fb-muted">{t("换电脑时使用：包含全部窗口的配置、Cookie 和扩展数据，用你设置的密码加密。")}</span>
            </div>
          </>
        )}
        {tab === 'about' && (
          <>
            <h2>{t("关于")}</h2>
            <div className="fb-settings-grid">
              <Item label={t("版本")}>{t("指纹浏览器 v{0}（本地版）", info?.version ?? __APP_VERSION__)}</Item>
              <Item label={t("更新")}><AppUpdatePanel /></Item>
              <Item label={t("内核")}>{engine?.version ? kernelName(engine.version) : '—'}</Item>
              <Item label={t("项目主页")}>
                <Button size="small" type="link" className="fb-link-cell" onClick={() => void window.browserApi.app.openProjectPage().catch(ws.fail)}>github.com/zhangchedan000/fingerprint-browser</Button>
              </Item>
              <Item label={t("开源许可")}><span className="fb-muted">{t("基于 Prism Browser Community（MIT）开发")}</span></Item>
              <Item label={t("日志")}>
                <Button size="small" type="link" className="fb-link-cell" onClick={() => void window.browserApi.app.openFolder('logs').catch(ws.fail)}>{t("打开日志目录")}</Button>
              </Item>
            </div>
          </>
        )}
      </section>
      {migration.dialog}
      <Modal open={typeof moving === 'object'} title={t("正在迁移数据目录")} footer={null} closable={false} maskClosable={false}>
        {typeof moving === 'object' && (
          <>
            <Progress percent={moving.totalBytes ? Math.round(moving.copiedBytes / moving.totalBytes * 100) : 0} />
            <span className="fb-muted">{t("{0} / {1} 个文件 · {2} / {3}", moving.copiedFiles, moving.totalFiles, formatBytes(moving.copiedBytes), formatBytes(moving.totalBytes))}</span>
          </>
        )}
      </Modal>
    </div>
  )
}
