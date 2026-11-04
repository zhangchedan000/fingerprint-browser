import { Alert, Input, Modal, Radio } from 'antd'
import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import type { TunnelNodeInfo, TunnelSourceSummary, TunnelStatus } from '../../../shared/types'
import { humanError } from './format'

/** The account's subscriptions (代理 IP → 订阅) and their nodes, kept up to date. */
export function useSubscriptionStatus(): [TunnelStatus | undefined, (status: TunnelStatus) => void] {
  const [status, setStatus] = useState<TunnelStatus>()
  useEffect(() => {
    let alive = true
    const load = () => void window.browserApi.subscriptions.status().then((next) => { if (alive) setStatus(next) }).catch(() => undefined)
    load()
    const unsubscribe = window.browserApi.subscriptions.onChanged(setStatus)
    // Delays and exit IPs are measured in the background.
    const timer = setInterval(load, 15_000)
    return () => { alive = false; unsubscribe(); clearInterval(timer) }
  }, [])
  return [status, setStatus]
}

/** A node's name inside its subscription (the core lists it as "订阅名 · 节点名"). */
export function nodeShortName(source: Pick<TunnelSourceSummary, 'name'>, node: Pick<TunnelNodeInfo, 'name'>): string {
  const prefix = `${source.name} · `
  return node.name.startsWith(prefix) ? node.name.slice(prefix.length) : node.name
}

/** The nodes of one subscription. */
export function subscriptionNodes(status: TunnelStatus | undefined, source: TunnelSourceSummary): TunnelNodeInfo[] {
  return (status?.nodes ?? []).filter((node) => node.sourceId === source.id)
}

/** Adds a subscription (or edits one): a subscription link, or node links pasted one per line. */
export function SubscriptionModal({ open, editing, onClose, onSaved }: {
  open: boolean
  /** The subscription being edited; unset: a new one. */
  editing?: TunnelSourceSummary
  onClose: () => void
  onSaved: (status: TunnelStatus) => void
}) {
  const [kind, setKind] = useState<'links' | 'subscription'>('subscription')
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(undefined)
    if (!editing) {
      setKind('subscription')
      setName('')
      setContent('')
      return
    }
    void window.browserApi.subscriptions.source(editing.id).then((source) => {
      setKind(source.kind)
      setName(source.name)
      setContent(source.content)
    }).catch((reason: unknown) => setError(humanError(reason)))
  }, [open, editing])

  async function save(): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      onSaved(await (editing
        ? window.browserApi.subscriptions.updateSource(editing.id, { name, kind, content })
        : window.browserApi.subscriptions.addSource({ name, kind, content })))
      onClose()
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? t("编辑订阅") : t("添加订阅")}
      okText={editing ? t("保存修改") : t("添加")}
      cancelText={t("取消")}
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      closable={!busy}
      maskClosable={false}
      keyboard={false}
      onOk={() => void save()}
      onCancel={onClose}
    >
      <div className="fb-stack">
        <Radio.Group optionType="button" value={kind} onChange={(event) => setKind(event.target.value)}
          options={[{ value: 'subscription', label: t("订阅链接") }, { value: 'links', label: t("粘贴节点链接") }]} />
        <Input placeholder={t("订阅名称（不填就用链接的域名）")} value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
        {kind === 'links'
          ? <Input.TextArea rows={6} value={content} onChange={(event) => setContent(event.target.value)}
            placeholder={t("每行一个：vless://、vmess://、trojan://、ss://、hysteria2:// 等，也可以粘贴 Clash 配置里的 proxies 部分")} />
          : <Input value={content} onChange={(event) => setContent(event.target.value)} placeholder="https://…" />}
        <span className="fb-muted">{t("窗口可以从订阅里的某个节点出去（代理方式选「订阅」）。订阅加密保存，跟着账号同步到其他电脑。")}</span>
        {editing && <span className="fb-muted">{t("改名后，用这个订阅的窗口会跟着改，不用重新选择。")}</span>}
        {error && <Alert type="error" showIcon title={error} />}
      </div>
    </Modal>
  )
}
