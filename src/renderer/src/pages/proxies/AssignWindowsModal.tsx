import { Alert, Checkbox, Modal, Radio, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { t } from '../../../../shared/i18n'
import type { BrowserProfileView, ProxyRecordView } from '../../../../shared/types'
import { proxyAddress } from '../../components/proxy'
import { WindowPicker } from '../../components/WindowPicker'
import { useWorkspace } from '../../data/workspace'
import { groupPairs, pairProxies } from './pairing'

export type AssignMode = 'single' | 'batch'

interface AssignWindowsModalProps {
  open: boolean
  /** One proxy for "指定窗口", several for "按顺序批量分配". */
  proxies: ProxyRecordView[]
  initialMode: AssignMode
  onClose: () => void
}

function currentProxy(window: BrowserProfileView): string {
  return window.proxy.protocol === 'direct' ? t("直连") : proxyAddress(window.proxy)
}

/** Assign proxies to windows (design: Proxy.dc.html dialog). Every change goes through assignMany. */
export function AssignWindowsModal({ open, proxies, initialMode, onClose }: AssignWindowsModalProps) {
  const ws = useWorkspace()
  const [mode, setMode] = useState<AssignMode>(initialMode)
  const [picked, setPicked] = useState<string[]>([])
  const [cycle, setCycle] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [followIp, setFollowIp] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setMode(initialMode)
    setPicked([])
    setCycle(false)
    setOverwrite(false)
    setFollowIp(true)
  }, [open, initialMode])

  const target = proxies[0]
  const pickedWindows = useMemo(
    () => [...ws.profiles].sort((a, b) => b.serialNumber - a.serialNumber).filter((window) => picked.includes(window.id)),
    [ws.profiles, picked]
  )
  const pairs = mode === 'batch' ? pairProxies(proxies.map((proxy) => proxy.id), pickedWindows, { cycle, overwrite }) : []
  const proxyById = new Map(ws.proxies.map((proxy) => [proxy.id, proxy]))
  const running = pickedWindows.filter((window) => window.status !== 'closed' && window.status !== 'error')
  const sharedOthers = mode === 'single' && target ? target.profileIds.filter((id) => !picked.includes(id)).length : 0
  const summary = mode === 'batch'
    ? t("将分配 {0} 个代理到 {1} 个窗口", new Set(pairs.map((pair) => pair.proxyId)).size, pairs.length)
    : t("已选 {0} 个窗口", picked.length)

  async function submit(): Promise<void> {
    setBusy(true)
    try {
      const assignments = mode === 'single'
        ? new Map([[target.id, picked]])
        : groupPairs(pairs)
      let changed = 0
      for (const [proxyId, ids] of assignments) {
        if (!ids.length) continue
        ws.upsertProfiles(await window.browserApi.profiles.assignMany(ids, { proxyId, followProxyIdentity: followIp }))
        changed += ids.length
      }
      ws.notify.success(t("已为 {0} 个窗口分配代理", changed))
      onClose()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  const count = mode === 'batch' ? pairs.length : picked.length
  return (
    <Modal
      open={open}
      title={t("分配代理到窗口")}
      width={760}
      okText={t("确认分配")}
      cancelText={t("取消")}
      okButtonProps={{ disabled: !count || running.length > 0 }}
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
      footer={(_, { OkBtn, CancelBtn }) => (
        <div className="fb-modal-footer">
          <span className="fb-muted">{summary}</span>
          <CancelBtn />
          <OkBtn />
        </div>
      )}
    >
      <Radio.Group
        className="fb-assign-modes"
        optionType="button"
        value={mode}
        onChange={(event) => setMode(event.target.value)}
        options={[
          { value: 'single', label: t("指定窗口"), disabled: proxies.length !== 1 },
          { value: 'batch', label: t("按顺序批量分配") }
        ]}
      />
      {mode === 'single' && target && (
        <div className="fb-assign-target">
          <span className="fb-muted">{t("代理")}</span>
          <strong className="fb-mono">{proxyAddress(target)}</strong>
          {target.check?.ok && target.check.countryCode && <span className="fb-cc">{target.check.countryCode}</span>}
          <span className="fb-muted">{[target.check?.ok ? target.check.city || target.check.country : '', target.protocol.toUpperCase()].filter(Boolean).join(' · ')}</span>
        </div>
      )}
      {mode === 'batch' && (
        <p className="fb-muted">{t("已选 {0} 个代理，勾选窗口后按列表顺序一一分配。", proxies.length)}</p>
      )}
      <WindowPicker
        windows={ws.profiles}
        groups={ws.groups}
        value={picked}
        onChange={setPicked}
        detailTitle={t("当前代理")}
        toggle={{ label: t("只看未设代理"), test: (window) => !window.proxyId }}
        detail={(window, checked) => {
          const pair = pairs.find((item) => item.windowId === window.id)
          return (
            <>
              <span className={window.proxyId ? 'fb-mono' : 'fb-muted'}>{currentProxy(window)}</span>
              {mode === 'single' && checked && window.proxyId && window.proxyId !== target?.id && <Tag color="orange" className="fb-inline-tag">{t("将替换")}</Tag>}
              {pair && <span className="fb-pair">→ <span className="fb-mono">{proxyAddress(proxyById.get(pair.proxyId)!)}</span></span>}
            </>
          )
        }}
      />
      {mode === 'batch' && (
        <div className="fb-inline-fields">
          <span>{t("窗口已有代理时：")}</span>
          <Radio.Group size="small" value={overwrite} onChange={(event) => setOverwrite(event.target.value)} options={[{ value: false, label: t("跳过") }, { value: true, label: t("覆盖") }]} />
          <Checkbox checked={cycle} onChange={(event) => setCycle(event.target.checked)}>{t("代理比窗口少时循环使用")}</Checkbox>
        </div>
      )}
      {((mode === 'single' && picked.length > 0 && picked.length + sharedOthers > 1) || (mode === 'batch' && pairs.length > proxies.length)) && (
        <Alert type="warning" showIcon className="fb-assign-extra" title={t("多个窗口共用同一个出口 IP，可能被平台判定为关联账号。")} />
      )}
      {running.length > 0 && (
        <Alert type="error" showIcon className="fb-assign-extra" title={t("有 {0} 个所选窗口正在运行，请先关闭", running.length)} />
      )}
      <Checkbox className="fb-assign-extra" checked={followIp} onChange={(event) => setFollowIp(event.target.checked)}>
        {t("分配后按代理出口 IP 自动更新窗口的时区、语言和地理位置")}
      </Checkbox>
    </Modal>
  )
}
