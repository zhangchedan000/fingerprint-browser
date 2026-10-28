import { Alert, Input, Modal, Radio, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { joinMessages, t, translateMessage as mt } from '../../../../shared/i18n'
import { parsePastedProxy, splitPastedProxies } from '../../../../shared/proxy-paste'
import type { ProxyDraft, TunnelRoute } from '../../../../shared/types'
import { defaultTunnelRoute, TunnelRouteField, useTunnelStatus } from '../../components/TunnelRouteField'

interface ParsedLine {
  line: number
  draft?: ProxyDraft
  error?: string
}

/** One proxy per line, in any format the quick paste understands. */
export function parseProxyLines(text: string, protocol: ProxyDraft['protocol'], note: string): ParsedLine[] {
  return splitPastedProxies(text)
    .map(({ text: raw, line }) => {
      try {
        const parsed = parsePastedProxy(raw)
        return { line, draft: { ...parsed, protocol: parsed.protocol ?? protocol, note } }
      } catch (error) {
        return { line, error: error instanceof Error ? error.message : String(error) }
      }
    })
}

interface ProxyImportModalProps {
  open: boolean
  busy: boolean
  onSubmit: (drafts: ProxyDraft[]) => Promise<void>
  onClose: () => void
}

/** Adds a pasted list of proxies to the library. */
export function ProxyImportModal({ open, busy, onSubmit, onClose }: ProxyImportModalProps) {
  const [text, setText] = useState('')
  const [protocol, setProtocol] = useState<ProxyDraft['protocol']>('socks5')
  const [note, setNote] = useState('')
  const tunnelStatus = useTunnelStatus()
  const [chosenRoute, setChosenRoute] = useState<TunnelRoute>()
  const route = chosenRoute ?? defaultTunnelRoute(tunnelStatus)
  useEffect(() => {
    if (!open) return
    setText('')
    setNote('')
    setChosenRoute(undefined)
  }, [open])

  const lines = useMemo(() => parseProxyLines(text, protocol, note.trim()), [text, protocol, note])
  const valid = lines.filter((line) => line.draft)
  const invalid = lines.filter((line) => line.error)

  return (
    <Modal
      open={open}
      title={t("批量导入代理")}
      okText={t("导入 {0} 个代理", valid.length)}
      cancelText={t("取消")}
      okButtonProps={{ disabled: !valid.length }}
      confirmLoading={busy}
      // HTTPS proxies cannot go through the tunnel (their certificate is checked against their own name).
      onOk={() => void onSubmit(valid.map((line) => ({ ...line.draft!, tunnel: line.draft!.protocol === 'https' ? { ...route, enabled: false } : route })))}
      onCancel={onClose}
      destroyOnHidden
      width={640}
    >
      <Typography.Paragraph type="secondary">{t("每行一个代理，支持 host:port:user:pass、user:pass:host:port、user:pass@host:port、socks5:// 链接，以及多行的“地址：… 端口：… 用户名：… 密码：…”；代理库里已有的会自动跳过。")}</Typography.Paragraph>
      <Input.TextArea
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoSize={{ minRows: 8, maxRows: 16 }}
        className="fb-mono-input"
        placeholder={'203.0.113.10:1080:user:pass\nsocks5://user:pass@203.0.113.11:1080'}
      />
      <div className="fb-inline-fields">
        <span>{t("未写类型的按")}</span>
        <Radio.Group size="small" optionType="button" value={protocol} onChange={(event) => setProtocol(event.target.value)} options={[{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }, { value: 'socks5', label: 'SOCKS5' }]} />
        <Input size="small" className="fb-small-input" maxLength={200} value={note} placeholder={t("统一备注（可选）")} onChange={(event) => setNote(event.target.value)} />
      </div>
      <div className="fb-import-route">
        <span className="fb-import-route-label">{t("网络加速")}</span>
        <TunnelRouteField value={route} status={tunnelStatus} onChange={setChosenRoute} />
      </div>
      {invalid.length > 0 && (
        <Alert
          type="warning"
          showIcon
          className="fb-assign-extra"
          title={t("{0} 行无法识别，将跳过", invalid.length)}
          description={joinMessages(invalid.slice(0, 5).map((line) => t("第 {0} 行：{1}", line.line, mt(line.error))))}
        />
      )}
    </Modal>
  )
}
