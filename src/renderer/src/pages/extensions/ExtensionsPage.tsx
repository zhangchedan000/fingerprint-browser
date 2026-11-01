import { FolderAddOutlined } from '@ant-design/icons'
import { Button, Empty, Modal, Spin, Switch, Tooltip } from 'antd'
import { useEffect, useState } from 'react'
import { t } from '../../../../shared/i18n'
import { GROUP_COLORS } from '../../../../shared/group-colors'
import type { BrowserExtension } from '../../../../shared/types'
import { PickWindowsModal } from '../../components/PickWindowsModal'
import { useWorkspace } from '../../data/workspace'

/** A stable badge colour per extension (user data marker, like group colours). */
function badgeColor(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return GROUP_COLORS[hash % GROUP_COLORS.length]
}

/** Extension center (design: Extensions.dc.html). Windows refer to extensions by id. */
export function ExtensionsPage() {
  const ws = useWorkspace()
  const { extensions, profiles, notify } = ws
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [assigning, setAssigning] = useState<BrowserExtension | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setLoading(true)
    void window.browserApi.extensions.list().then(ws.setExtensions).catch(ws.fail).finally(() => setLoading(false))
  }, [ws.setExtensions, ws.fail])

  const users = (extension: BrowserExtension) => profiles.filter((profile) => profile.extensionIds.includes(extension.id))

  async function importDirectory(): Promise<void> {
    setImporting(true)
    try {
      const imported = await window.browserApi.extensions.importDirectory()
      if (!imported) return
      ws.setExtensions([...extensions.filter((item) => item.id !== imported.id), imported])
      notify.success(t("扩展“{0}”已导入", imported.name))
    } catch (error) {
      ws.fail(error)
    } finally {
      setImporting(false)
    }
  }

  async function toggleGlobal(extension: BrowserExtension, enabled: boolean): Promise<void> {
    setToggling(extension.id)
    try {
      const changed = await window.browserApi.extensions.setGlobalEnabled(extension.id, enabled)
      ws.setExtensions(extensions.map((item) => item.id === changed.id ? changed : item))
    } catch (error) {
      ws.fail(error)
    } finally {
      setToggling(null)
    }
  }

  /** Ticked windows get the extension, unticked ones lose it — both through assignMany. */
  async function assign(extension: BrowserExtension, ids: string[]): Promise<void> {
    const before = new Set(users(extension).map((profile) => profile.id))
    const after = new Set(ids)
    const add = ids.filter((id) => !before.has(id))
    const remove = [...before].filter((id) => !after.has(id))
    setBusy(true)
    try {
      if (add.length) ws.upsertProfiles(await window.browserApi.profiles.assignMany(add, { extensionId: extension.id }))
      if (remove.length) ws.upsertProfiles(await window.browserApi.profiles.assignMany(remove, { extensionId: extension.id, removeExtension: true }))
      setAssigning(null)
      notify.success(t("“{0}”现在分配给 {1} 个窗口", extension.name, ids.length))
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  function confirmRemove(extension: BrowserExtension): void {
    Modal.confirm({
      title: t("移除扩展“{0}”？", extension.name),
      content: t("文件会移动到本机回收目录。"),
      okText: t("移除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          await window.browserApi.extensions.remove(extension.id)
          ws.setExtensions(extensions.filter((item) => item.id !== extension.id))
          notify.success(t("扩展“{0}”已移入回收目录", extension.name))
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  return (
    <div className="fb-stack">
      <div className="fb-toolbar">
        <Button type="primary" icon={<FolderAddOutlined />} loading={importing} onClick={() => void importDirectory()}>{t("导入扩展文件夹")}</Button>
        <span className="fb-muted">{t("选择解压后的扩展目录（含 manifest.json）")}</span>
      </div>
      <Spin spinning={loading && !extensions.length}>
        {extensions.length
          ? (
              <div className="fb-ext-grid">
                {extensions.map((extension) => {
                  const used = users(extension)
                  return (
                    <article key={extension.id} className="fb-card fb-ext-card">
                      <div className="fb-ext-head">
                        <span className="fb-ext-badge" style={{ background: badgeColor(extension.id) }} aria-hidden="true">{extension.name.slice(0, 1)}</span>
                        <div className="fb-two-line">
                          <strong className="fb-ellipsis" title={extension.name}>{extension.name}</strong>
                          <small>v{extension.version} · MV{extension.manifestVersion}</small>
                        </div>
                        <Tooltip title={t("所有窗口启用")}>
                          <Switch
                            checked={extension.globalEnabled}
                            loading={toggling === extension.id}
                            aria-label={t("所有窗口启用 {0}", extension.name)}
                            onChange={(checked) => void toggleGlobal(extension, checked)}
                          />
                        </Tooltip>
                      </div>
                      <p className="fb-ext-desc">{extension.description || t("没有描述")}</p>
                      <div className="fb-ext-foot">
                        <span className={extension.globalEnabled || used.length ? 'fb-badge is-ok' : 'fb-muted'}>
                          {extension.globalEnabled ? t("所有窗口") : used.length ? t("{0} 个窗口", used.length) : t("未分配")}
                        </span>
                        <Button size="small" type="link" autoInsertSpace={false} disabled={extension.globalEnabled} onClick={() => setAssigning(extension)}>{t("分配窗口")}</Button>
                        <Button size="small" type="link" autoInsertSpace={false} onClick={() => void window.browserApi.extensions.openSourceFolder(extension.id).catch(ws.fail)}>{t("打开目录")}</Button>
                        <Tooltip title={used.length ? t("还有 {0} 个窗口在用，先在“分配窗口”里取消", used.length) : undefined}>
                          <Button size="small" type="link" danger autoInsertSpace={false} disabled={used.length > 0} onClick={() => confirmRemove(extension)}>{t("移除")}</Button>
                        </Tooltip>
                      </div>
                    </article>
                  )
                })}
              </div>
            )
          : (
              <Empty className="fb-card fb-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("还没有导入扩展。把 Chrome 扩展解压成文件夹后导入，再在窗口里启用。")}>
                <Button type="primary" icon={<FolderAddOutlined />} loading={importing} onClick={() => void importDirectory()}>{t("导入扩展文件夹")}</Button>
              </Empty>
            )}
      </Spin>
      <PickWindowsModal
        open={Boolean(assigning)}
        title={assigning ? t("“{0}”分配给哪些窗口", assigning.name) : ''}
        windows={profiles}
        initial={assigning ? users(assigning).map((profile) => profile.id) : []}
        allowEmpty
        detailTitle={t("已有扩展")}
        detail={(window) => <span className="fb-muted">{t("{0} 个", window.extensionIds.length)}</span>}
        okText={t("保存")}
        busy={busy}
        onSubmit={(ids) => { if (assigning) return assign(assigning, ids) }}
        onClose={() => setAssigning(null)}
      />
    </div>
  )
}
