import { Button, Input, Modal, Space, Switch } from 'antd'
import { useState } from 'react'
import { t } from '../../../../shared/i18n'
import { DEFAULT_DEEP_CHECK_SITES, knownDeepSite, type DeepCheckSite } from '../../../../shared/deep-check'
import { useWorkspace } from '../../data/workspace'

/** The deep check's site list (shared by every window): switch, add, delete, back to the default four. */
export function DeepCheckSites({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace()
  const sites = ws.preferences.deepCheckSites ?? [...DEFAULT_DEEP_CHECK_SITES]
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const save = (next: DeepCheckSite[] | undefined) => ws.setPreferences({ deepCheckSites: next }).catch((reason) => ws.fail(reason))

  function add(): void {
    let address: URL
    try {
      address = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`)
    } catch {
      setError(t("网址格式不对"))
      return
    }
    if (sites.length >= 20) {
      setError(t("最多 20 个检测网站"))
      return
    }
    const id = `site-${Date.now().toString(36)}`
    void save([...sites, { id, name: name.trim() || address.hostname, url: address.href, enabled: true }])
    setName('')
    setUrl('')
    setError('')
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} title={t("深度检测网站")} width={620}>
      <div className="fb-deep-sites">
        {sites.map((site) => (
          <div key={site.id} className="fb-deep-sites-row">
            <Switch
              size="small"
              checked={site.enabled}
              onChange={(enabled) => void save(sites.map((item) => item.id === site.id ? { ...item, enabled } : item))}
            />
            <div className="fb-deep-sites-name">
              <b>{site.name}</b>
              <span className="fb-muted fb-ellipsis">{site.url}</span>
            </div>
            <span className="fb-muted">{knownDeepSite(site.url) ? t("读取分数") : t("只截图")}</span>
            <Button type="link" size="small" danger onClick={() => void save(sites.filter((item) => item.id !== site.id))}>{t("删除")}</Button>
          </div>
        ))}
        {!sites.length && <span className="fb-muted">{t("没有检测网站，添加一个或恢复默认")}</span>}
      </div>
      <Space.Compact className="fb-deep-sites-add">
        <Input placeholder={t("名称（可不填）")} value={name} onChange={(event) => setName(event.target.value)} style={{ width: 160 }} />
        <Input placeholder="https://browserleaks.com/" value={url} onChange={(event) => setUrl(event.target.value)} onPressEnter={add} />
        <Button type="primary" disabled={!url.trim()} onClick={add}>{t("添加")}</Button>
      </Space.Compact>
      {error && <div className="fb-deep-sites-error">{error}</div>}
      <div className="fb-deep-sites-foot">
        <span className="fb-muted">{t("iphey、BrowserScan、Pixelscan、CreepJS 能读出分数和扣分原因；自己添加的网站只截图和显示网页标题。")}</span>
        <Button size="small" onClick={() => void save(undefined)}>{t("恢复默认")}</Button>
      </div>
    </Modal>
  )
}
