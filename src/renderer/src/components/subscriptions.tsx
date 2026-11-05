import { CheckCircleFilled } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Radio, Table, Tooltip, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import { useWorkspace } from '../data/workspace'
import type { TunnelNodeInfo, TunnelSourcePreview, TunnelSourceSummary, TunnelStatus } from '../../../shared/types'
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

/** The source just added (the newest) or edited, and how many nodes it gave. */
export function savedSource(status: TunnelStatus, editingId?: string): { name: string; nodes: number } | undefined {
  const source = editingId
    ? status.sources.find((item) => item.id === editingId)
    : [...status.sources].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return source && { name: source.name, nodes: subscriptionNodes(status, source).length }
}

/** Shown while 获取节点 runs: a subscription link is downloaded first. */
export function FetchingNodes() {
  return <Alert type="info" showIcon title={t("正在获取节点…订阅链接要先下载，最多等 20 秒")} />
}

/** What 获取节点 found: how many nodes, and each one's name and protocol. */
export function NodePreviewList({ preview }: { preview: TunnelSourcePreview }) {
  return (
    <div className="fb-stack">
      <Typography.Text type="success"><CheckCircleFilled /> {t("取到 {0} 个节点", preview.nodes.length)}</Typography.Text>
      <Table
        size="small"
        rowKey={(node, index) => `${index}-${node.name}`}
        pagination={false}
        scroll={{ y: 240 }}
        dataSource={preview.nodes}
        columns={[
          { title: t("节点名称"), dataIndex: 'name', render: (value: string) => <span className="fb-ellipsis" title={value}>{value}</span> },
          { title: t("协议"), dataIndex: 'type', width: 130 }
        ]}
      />
    </div>
  )
}

type SourceKind = 'links' | 'subscription'

/**
 * Adds a node source (or edits one), in two steps: 获取节点 shows what the link or the pasted links
 * give (name, protocol, how many), then 添加 saves it. Used by 代理 IP → 订阅 and by 设置 → 网络加速.
 */
export function SourceModal({ api, open, editingId, onClose, onSaved, texts, kinds }: {
  api: 'subscriptions' | 'tunnel'
  open: boolean
  /** The source being edited; unset: a new one. */
  editingId?: string
  onClose: () => void
  onSaved: (status: TunnelStatus) => void
  texts: { addTitle: string; editTitle: string; namePlaceholder: string; hint: string; editHint?: string }
  /** The kinds offered, the first one chosen for a new source. */
  kinds: SourceKind[]
}) {
  const { notify } = useWorkspace()
  const calls = window.browserApi[api]
  const [kind, setKind] = useState<SourceKind>(kinds[0])
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState<{ kind: SourceKind; content: string }>()
  const [preview, setPreview] = useState<{ key: string; value: TunnelSourcePreview }>()
  const [failure, setFailure] = useState<{ key: string; message: string }>()
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    setError(undefined)
    setPreview(undefined)
    setFailure(undefined)
    setOriginal(undefined)
    if (!editingId) {
      setKind(kinds[0])
      setName('')
      setContent('')
      return
    }
    void calls.source(editingId).then((source) => {
      setKind(source.kind)
      setName(source.name)
      setContent(source.content)
      setOriginal({ kind: source.kind, content: source.content.trim() })
    }).catch((reason: unknown) => setError(humanError(reason)))
  }, [open, editingId])

  // A result belongs to the link (or links) it was fetched for: changing them asks for 获取节点 again.
  const key = `${kind}\n${content.trim()}`
  const shown = preview?.key === key ? preview.value : undefined
  const failed = failure?.key === key ? failure.message : undefined
  const unchanged = Boolean(original && original.kind === kind && original.content === content.trim())
  const canSave = Boolean(shown) || unchanged

  async function fetchNodes(): Promise<void> {
    setFetching(true)
    setError(undefined)
    setFailure(undefined)
    try {
      setPreview({ key, value: await calls.previewSource({ name, kind, content }) })
    } catch (reason) {
      setPreview(undefined)
      setFailure({ key, message: humanError(reason) })
    } finally {
      setFetching(false)
    }
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(undefined)
    try {
      const status = await (editingId ? calls.updateSource(editingId, { name, kind, content }) : calls.addSource({ name, kind, content }))
      onSaved(status)
      onClose()
      const saved = savedSource(status, editingId)
      if (saved?.nodes) notify.success(t("「{0}」取到 {1} 个节点", saved.name, saved.nodes))
      else if (shown) notify.success(t("「{0}」取到 {1} 个节点", saved?.name ?? shown.name, shown.nodes.length))
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setSaving(false)
    }
  }

  const busy = fetching || saving
  return (
    <Modal
      open={open}
      title={editingId ? texts.editTitle : texts.addTitle}
      width={620}
      closable={!busy}
      maskClosable={false}
      keyboard={false}
      onCancel={onClose}
      footer={[
        <Button key="cancel" disabled={busy} onClick={onClose}>{t("取消")}</Button>,
        <Button key="fetch" type={canSave ? 'default' : 'primary'} loading={fetching} disabled={saving || !content.trim()} onClick={() => void fetchNodes()}>
          {shown ? t("重新获取") : t("获取节点")}
        </Button>,
        <Tooltip key="save" title={canSave ? undefined : t("先点「获取节点」，看到节点再添加")}>
          <Button type="primary" disabled={!canSave || fetching} loading={saving} onClick={() => void save()}>{editingId ? t("保存修改") : t("添加")}</Button>
        </Tooltip>
      ]}
    >
      <div className="fb-stack">
        <Radio.Group optionType="button" value={kind} disabled={busy} onChange={(event) => setKind(event.target.value)}
          options={kinds.map((value) => ({ value, label: value === 'subscription' ? t("订阅链接") : t("粘贴节点链接") }))} />
        <Input placeholder={texts.namePlaceholder} value={name} maxLength={40} disabled={busy} onChange={(event) => setName(event.target.value)} />
        {kind === 'links'
          ? <Input.TextArea rows={5} value={content} disabled={busy} onChange={(event) => setContent(event.target.value)}
            placeholder={t("每行一个：vless://、vmess://、trojan://、ss://、hysteria2:// 等，也可以粘贴 Clash 配置里的 proxies 部分")} />
          : <Input value={content} disabled={busy} onChange={(event) => setContent(event.target.value)} placeholder="https://…" />}
        <span className="fb-muted">{texts.hint}</span>
        {editingId && texts.editHint && <span className="fb-muted">{texts.editHint}</span>}
        {fetching && <FetchingNodes />}
        {failed && <Alert type="error" showIcon title={failed} />}
        {shown && <NodePreviewList preview={shown} />}
        {!shown && !failed && !fetching && !unchanged && content.trim() && <span className="fb-muted">{t("先点「获取节点」，看到节点再添加")}</span>}
        {error && <Alert type="error" showIcon title={error} />}
      </div>
    </Modal>
  )
}

/** Adds a subscription (or edits one): a subscription link, or node links pasted one per line. */
export function SubscriptionModal({ open, editing, onClose, onSaved }: {
  open: boolean
  /** The subscription being edited; unset: a new one. */
  editing?: TunnelSourceSummary
  onClose: () => void
  onSaved: (status: TunnelStatus) => void
}) {
  return (
    <SourceModal
      api="subscriptions"
      open={open}
      editingId={editing?.id}
      onClose={onClose}
      onSaved={onSaved}
      kinds={['subscription', 'links']}
      texts={{
        addTitle: t("添加订阅"),
        editTitle: t("编辑订阅"),
        namePlaceholder: t("订阅名称（不填就用链接的域名）"),
        hint: t("窗口可以从订阅里的某个节点出去（代理方式选「订阅」）。订阅加密保存，跟着账号同步到其他电脑。"),
        editHint: t("改名后，用这个订阅的窗口会跟着改，不用重新选择。")
      }}
    />
  )
}
