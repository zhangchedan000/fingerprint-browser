import { Button, Input, Modal, Radio, Space, Switch } from 'antd'
import { useState } from 'react'
import { t } from '../../../../shared/i18n'
import { DEFAULT_IP_CHECK_SITES, ipBaseline, knownIpSite, type IpCheckSite } from '../../../../shared/ip-sites'
import { useWorkspace } from '../../data/workspace'

/**
 * The IP check sites (shared by every window): switch, add, delete, pick the baseline (whose score,
 * native and data-centre verdicts count), back to IPLark and ping0.cc.
 */
export function IpCheckSites({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace()
  const sites = ws.preferences.ipCheckSites ?? [...DEFAULT_IP_CHECK_SITES]
  const baseline = ipBaseline(sites, ws.preferences.ipCheckBaseline)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const save = (patch: { ipCheckSites?: IpCheckSite[]; ipCheckBaseline?: string }) => ws.setPreferences(patch).catch((reason) => ws.fail(reason))

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
    void save({ ipCheckSites: [...sites, { id, name: name.trim() || address.hostname, url: address.href, enabled: true }] })
    setName('')
    setUrl('')
    setError('')
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} title={t("检测网站")} width={660}>
      <div className="fb-muted fb-ip-sites-desc">{t("每次检测：基准网站必查（IP 评分、原生 / 广播、数据中心 / 家宽以它为准），再从其余开着的网站里轮流挑一个对照。")}</div>
      <div className="fb-deep-sites">
        {sites.map((site) => {
          const readable = Boolean(knownIpSite(site.url))
          const isBaseline = site.id === baseline?.id
          return (
            <div key={site.id} className="fb-deep-sites-row">
              <Switch
                size="small"
                checked={site.enabled}
                // The baseline stays on: pick another one first.
                disabled={isBaseline}
                onChange={(enabled) => void save({ ipCheckSites: sites.map((item) => item.id === site.id ? { ...item, enabled } : item) })}
              />
              <div className="fb-deep-sites-name">
                <b>{site.name}</b>
                <span className="fb-muted fb-ellipsis">{site.url}</span>
              </div>
              <span className="fb-muted">{readable ? t("读取评分、类型、原生") : t("只截图")}</span>
              <Radio
                checked={isBaseline}
                disabled={!readable || !site.enabled}
                onChange={() => void save({ ipCheckBaseline: site.id })}
              >
                {isBaseline ? t("基准") : readable ? t("设为基准") : t("不能当基准")}
              </Radio>
              <Button type="link" size="small" danger disabled={isBaseline} onClick={() => void save({ ipCheckSites: sites.filter((item) => item.id !== site.id) })}>{t("删除")}</Button>
            </div>
          )
        })}
      </div>
      <Space.Compact className="fb-deep-sites-add">
        <Input placeholder={t("名称（可不填）")} value={name} onChange={(event) => setName(event.target.value)} style={{ width: 160 }} />
        <Input placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} onPressEnter={add} />
        <Button type="primary" disabled={!url.trim()} onClick={add}>{t("添加")}</Button>
      </Space.Compact>
      {error && <div className="fb-deep-sites-error">{error}</div>}
      <div className="fb-deep-sites-foot">
        <span className="fb-muted">{t("基准网站不能关、不能删，要先把别的网站设为基准。只有能读出内容的网站（IPLark、ping0.cc）能当基准；自己添加的网站只截图。")}</span>
        <Button size="small" onClick={() => void save({ ipCheckSites: undefined, ipCheckBaseline: undefined })}>{t("恢复默认")}</Button>
      </div>
    </Modal>
  )
}
