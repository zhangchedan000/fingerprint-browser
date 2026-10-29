import { Form, Input, InputNumber, Modal, Radio, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import { PASTE_PLACEHOLDER, parsePastedProxy, pastedProxySummary, type PastedProxy } from '../../../../shared/proxy-paste'
import type { ProxyDraft, ProxyRecordView, ProxyTestResult, TunnelRoute } from '../../../../shared/types'
import { defaultTunnelRoute, TunnelRouteField, useTunnelStatus } from '../../components/TunnelRouteField'
import { ProxyTestButton } from './ProxyTestButton'
import { useIpScore } from '../../components/useIpScore'
import { defaultProfileDraft } from '../../../../shared/defaults'

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
  // A check that finishes after the dialog was closed and opened again is dropped.
  const checkRun = useRef(0)
  const showResult = (run: number, next: ProxyTestResult) => {
    if (run !== checkRun.current) return
    setResult(next)
    // IP 评分 of the exit IP, as in the window editor.
    if (next.ok) void ipScore.read()
    else ipScore.reset()
  }
  const passwordStored = Form.useWatch('passwordStored', { form, preserve: true }) === true
  const password = Form.useWatch('password', form) ?? ''
  const protocol = Form.useWatch('protocol', form) ?? 'socks5'
  // API 提取: only the provider's extraction link; the proxy and its protocol come from it.
  const [apiMode, setApiMode] = useState(false)
  // 网络加速: used for 检测代理 here, and given to windows this proxy is assigned to.
  const tunnelStatus = useTunnelStatus()
  const [chosenRoute, setChosenRoute] = useState<TunnelRoute>()
  const shownRoute = chosenRoute ?? defaultTunnelRoute(tunnelStatus, undefined, proxy ? proxy.check?.countryCode ?? '' : undefined)
  // An HTTPS proxy cannot go through the tunnel (its certificate is checked against its own name).
  const route = !apiMode && protocol === 'https' ? { ...shownRoute, enabled: false } : shownRoute
  // The IP check sites read through a check browser with this proxy (the saved password fills an empty one).
  const ipScore = useIpScore({
    draft: () => {
      const values = form.getFieldsValue(true) as ProxyDraft
      const config = apiMode ? { ...apiDraft(), password: '' } : { ...values, password: values.password ?? '', tunnel: route }
      return { ...defaultProfileDraft(0), proxy: config, tunnel: route }
    },
    libraryProxyId: proxy?.id
  })

  useEffect(() => {
    if (!open) return
    form.resetFields()
    form.setFieldsValue(proxy
      ? { protocol: proxy.protocol, host: proxy.host, port: proxy.port, username: proxy.username, password: '', passwordStored: proxy.passwordStored, note: proxy.note, apiUrl: proxy.apiUrl ?? '' }
      : EMPTY)
    // The saved password fills its box as dots; the eye button shows it.
    let current = true
    if (proxy?.passwordStored) {
      void window.browserApi.proxy.password(proxy.id).then((password) => {
        if (current && password && !form.getFieldValue('password')) form.setFieldValue('password', password)
      }).catch(() => undefined)
    }
    setApiMode(Boolean(proxy?.apiUrl))
    setChosenRoute(proxy?.tunnel)
    setPaste('')
    setPasteError('')
    setPasted(null)
    checkRun.current += 1
    setResult(null)
    ipScore.reset()
    return () => { current = false }
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

  /** What an API proxy is saved and tested as: the link only (the app fills in the proxy). */
  function apiDraft(): ProxyDraft {
    const values = form.getFieldsValue(true) as ProxyDraft
    return { protocol: 'http', host: '', port: undefined, username: '', password: '', note: values.note ?? '', apiUrl: (values.apiUrl ?? '').trim(), tunnel: route }
  }

  async function submit(): Promise<void> {
    if (apiMode) {
      await form.validateFields(['apiUrl'])
      await onSubmit(apiDraft())
      return
    }
    const values = await form.validateFields()
    await onSubmit({ ...form.getFieldsValue(true), ...values, apiUrl: undefined, tunnel: route })
  }

  return (
    <Modal
      // Only × or 取消 closes it: a click beside it or Esc would lose what was typed.
      maskClosable={false}
      keyboard={false}
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
      <Form form={form} layout="vertical">
        {/* API 提取 lives on the window itself (窗口 → 代理设置 → API 提取), not in the library. */}
        {apiMode ? (
          <Form.Item
            name="apiUrl"
            label={t("API 链接")}
            extra={t("每次打开窗口都从这个链接取一个代理，自动识别是 SOCKS5 还是 HTTP。白名单模式要先在服务商后台把这台电脑的 IP 加进白名单；只接受境外 IP 的服务商，打开下面的网络加速，把加速节点的 IP 加进白名单。")}
            rules={[{ required: true, message: t("请输入 API 链接") }, { pattern: /^https?:\/\//i, message: t("API 链接要以 http:// 或 https:// 开头") }]}
          >
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="https://example.com/api?num=1&format=txt" />
          </Form.Item>
        ) : (<>
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
        </>)}
        <Form.Item name="note" label={t("备注")}>
          <Input maxLength={200} placeholder={t("例如：住宅 IP、BM 专用")} />
        </Form.Item>
        <Form.Item label={t("网络加速")} extra={t("分配给窗口时，窗口先用这个设置")}>
          <TunnelRouteField
            value={shownRoute}
            status={tunnelStatus}
            disabledReason={route === shownRoute ? undefined : t("HTTPS 代理暂不支持网络加速，可改用 HTTP 或 SOCKS5")}
            onChange={(next) => { setChosenRoute(next); setResult(null) }}
          />
        </Form.Item>
        <ProxyTestButton
          result={result}
          aside={ipScore.panel(result?.ok ? result.ip : undefined)}
          onTest={async () => {
            const run = ++checkRun.current
            if (apiMode) {
              await form.validateFields(['apiUrl'])
              showResult(run, await window.browserApi.proxy.test({ ...apiDraft(), password: '' }, undefined, proxy?.id))
              return
            }
            const values = await form.validateFields(['host', 'port'])
            const draft = { ...form.getFieldsValue(true), ...values, tunnel: route } as ProxyDraft
            showResult(run, await window.browserApi.proxy.test({ ...draft, password: draft.password ?? '' }, undefined, proxy?.id))
          }}
        />
      </Form>
    </Modal>
  )
}
