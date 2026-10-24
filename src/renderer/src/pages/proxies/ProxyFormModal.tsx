import { Form, Input, InputNumber, Modal, Radio, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import { PASTE_PLACEHOLDER, parsePastedProxy, pastedProxySummary, type PastedProxy } from '../../../../shared/proxy-paste'
import type { ProxyDraft, ProxyRecordView, ProxyTestResult } from '../../../../shared/types'
import { ProxyTestButton } from './ProxyTestButton'

interface ProxyFormModalProps {
  open: boolean
  /** Edit this library proxy; add a new one when absent. */
  proxy?: ProxyRecordView
  busy: boolean
  onSubmit: (draft: ProxyDraft) => Promise<void>
  onClose: () => void
}

const EMPTY: ProxyDraft = { protocol: 'socks5', host: '', port: undefined, username: '', password: '', note: '' }

/** Add or edit one proxy in the library. */
export function ProxyFormModal({ open, proxy, busy, onSubmit, onClose }: ProxyFormModalProps) {
  const [form] = Form.useForm<ProxyDraft>()
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [pasted, setPasted] = useState<PastedProxy | null>(null)
  const [result, setResult] = useState<ProxyTestResult | null>(null)
  const passwordStored = Form.useWatch('passwordStored', { form, preserve: true }) === true
  const password = Form.useWatch('password', form) ?? ''
  const protocol = Form.useWatch('protocol', form) ?? 'socks5'

  useEffect(() => {
    if (!open) return
    form.resetFields()
    form.setFieldsValue(proxy
      ? { protocol: proxy.protocol, host: proxy.host, port: proxy.port, username: proxy.username, password: '', passwordStored: proxy.passwordStored, note: proxy.note }
      : EMPTY)
    setPaste('')
    setPasteError('')
    setPasted(null)
    setResult(null)
  }, [open, proxy, form])

  function applyPaste(text: string): void {
    setPaste(text)
    setPasted(null)
    if (!text.trim()) { setPasteError(''); return }
    try {
      const parsed = parsePastedProxy(text)
      form.setFieldsValue({ ...parsed, protocol: parsed.protocol ?? form.getFieldValue('protocol'), passwordStored: false })
      setPasted(parsed)
      setPasteError('')
      setResult(null)
    } catch (error) {
      setPasteError(mt(error instanceof Error ? error.message : String(error)))
    }
  }

  async function submit(): Promise<void> {
    const values = await form.validateFields()
    await onSubmit({ ...form.getFieldsValue(true), ...values })
  }

  return (
    <Modal
      open={open}
      title={proxy ? t("编辑代理") : t("添加代理")}
      okText={t("保存")}
      cancelText={t("取消")}
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
      width={560}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          label={t("快速粘贴")}
          help={pasteError
            ? <Typography.Text type="danger">{pasteError}</Typography.Text>
            : pasted
              ? <Typography.Text type="success">{t("已识别：{0}", pastedProxySummary(pasted, protocol))}{pasted.protocol ? '' : ` · ${t("未写协议，按当前选择的类型")}`}</Typography.Text>
              : undefined}
        >
          <Input.TextArea className="fb-paste" autoSize={{ minRows: 1, maxRows: 5 }} value={paste} placeholder={PASTE_PLACEHOLDER} onChange={(event) => applyPaste(event.target.value)} />
        </Form.Item>
        <Form.Item name="protocol" label={t("类型")}>
          <Radio.Group optionType="button" options={[{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }, { value: 'socks5', label: 'SOCKS5' }]} />
        </Form.Item>
        <div className="fb-host-grid">
          <Form.Item name="host" label={t("代理地址")} rules={[{ required: true, message: t("请输入代理主机") }]}>
            <Input placeholder="proxy.example.com" />
          </Form.Item>
          <Form.Item name="port" label={t("端口")} rules={[{ required: true, message: t("请输入端口") }]}>
            <InputNumber min={1} max={65535} precision={0} className="full-width" />
          </Form.Item>
        </div>
        <div className="fb-host-grid even">
          <Form.Item name="username" label={t("用户名")}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="password" label={t("密码")} extra={passwordStored && !password ? t("已保存，留空保持不变") : undefined}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </div>
        <Form.Item name="note" label={t("备注")}>
          <Input maxLength={200} placeholder={t("例如：住宅 IP、BM 专用")} />
        </Form.Item>
        <ProxyTestButton
          result={result}
          onTest={async () => {
            const values = await form.validateFields(['host', 'port'])
            const draft = { ...form.getFieldsValue(true), ...values } as ProxyDraft
            const tested = await window.browserApi.proxy.test({ ...draft, password: draft.password ?? '' }, undefined, proxy?.id)
            setResult(tested)
          }}
        />
      </Form>
    </Modal>
  )
}
