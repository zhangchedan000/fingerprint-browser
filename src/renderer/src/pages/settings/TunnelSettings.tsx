import { CheckOutlined, CloseOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Radio, Space, Switch, Table, Typography, type TableColumnsType } from 'antd'
import { useEffect, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import type { TunnelNodeInfo, TunnelStatus } from '../../../../shared/types'
import { humanError } from '../../components/format'
import { DelayText, TUNNEL_STATE_PILL as STATE_PILL } from '../../components/TunnelRouteField'
import { useWorkspace } from '../../data/workspace'


/** Settings → 网络加速: the built-in tunnel that carries foreign window proxies out of the country. */
export function TunnelSettings() {
  const ws = useWorkspace()
  const [status, setStatus] = useState<TunnelStatus>()
  const [busy, setBusy] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [kind, setKind] = useState<'links' | 'subscription'>('links')
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [addError, setAddError] = useState<string>()

  useEffect(() => {
    void window.browserApi.tunnel.status().then(setStatus).catch(ws.fail)
    const unsubscribe = window.browserApi.tunnel.onChanged(setStatus)
    const timer = setInterval(() => { void window.browserApi.tunnel.status().then(setStatus).catch(() => undefined) }, 10_000)
    return () => { unsubscribe(); clearInterval(timer) }
  }, [ws.fail])

  async function run(key: string, action: () => Promise<TunnelStatus>): Promise<void> {
    setBusy(key)
    try {
      setStatus(await action())
    } catch (error) {
      ws.fail(error)
      void window.browserApi.tunnel.status().then(setStatus).catch(() => undefined)
    } finally {
      setBusy(undefined)
    }
  }

  async function add(): Promise<void> {
    setBusy('add')
    setAddError(undefined)
    try {
      setStatus(await (editingId
        ? window.browserApi.tunnel.updateSource(editingId, { name, kind, content })
        : window.browserApi.tunnel.addSource({ name, kind, content })))
      setAdding(false)
      setEditingId(undefined)
      setName('')
      setContent('')
    } catch (error) {
      setAddError(humanError(error))
    } finally {
      setBusy(undefined)
    }
  }

  function closeEditor(): void {
    setAdding(false)
    setEditingId(undefined)
    setName('')
    setContent('')
    setAddError(undefined)
  }

  async function edit(id: string): Promise<void> {
    setBusy('edit')
    try {
      const source = await window.browserApi.tunnel.source(id)
      setEditingId(id)
      setName(source.name)
      setKind(source.kind)
      setContent(source.content)
      setAddError(undefined)
      setAdding(true)
    } catch (error) { ws.fail(error) }
    finally { setBusy(undefined) }
  }

  function remove(id: string, sourceName: string): void {
    Modal.confirm({
      title: t("删除节点来源“{0}”？", sourceName),
      okText: t("删除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: () => run('remove', () => window.browserApi.tunnel.removeSource(id))
    })
  }

  const running = status?.state === 'running'
  const columns: TableColumnsType<TunnelNodeInfo> = [
    { title: t("节点"), dataIndex: 'name', render: (value: string) => <span className="fb-ellipsis" title={value}>{value}</span> },
    {
      title: t("出口 IP"),
      dataIndex: 'exitIp',
      width: 170,
      render: (value?: string) => value
        ? <Typography.Text className="fb-mono" copyable={{ text: value, tooltips: [t("复制"), t("已复制")] }}>{value}</Typography.Text>
        : <span className="fb-muted">—</span>
    },
    { title: t("类型"), dataIndex: 'type', width: 110 },
    { title: t("延迟"), dataIndex: 'delay', width: 100, render: (value?: number) => <DelayText delay={value} /> },
    {
      title: t("操作"),
      width: 190,
      align: 'right',
      render: (_, node) => <Space size={4}>
        {node.name === status?.selected && <span className="fb-tunnel-pill is-on"><CheckOutlined />{t("使用中")}</span>}
        {(node.name !== status?.selected || status.selectionMode === 'auto') && <Button size="small" type="link" autoInsertSpace={false} disabled={Boolean(busy)} onClick={() => void run('select', () => window.browserApi.tunnel.select(node.name))}>{t("固定使用")}</Button>}
        <Button size="small" type="link" autoInsertSpace={false} disabled={Boolean(busy) || !node.sourceId} onClick={() => node.sourceId && void edit(node.sourceId)}>{t("编辑")}</Button>
      </Space>
    }
  ]

  const [stateClass, label] = STATE_PILL[status?.state ?? 'off']
  const manual = status?.selectionMode === 'manual'
  return (
    <>
      <h2>{t("网络加速")}</h2>
      <p className="fb-muted fb-tunnel-intro">
        {t("有些代理 IP 在国内直连不上（或只接受境外 IP）。在这里添加你自己的节点、开启加速通道；每个窗口在「代理设置 → 网络加速」里选择要不要经过节点、用哪个节点，本机不用开 Clash。网站看到的仍然是窗口代理的 IP。")}
      </p>
      {status && !status.available && <Alert type="warning" showIcon title={t("当前版本没有附带加速通道组件，请安装最新版指纹浏览器。")} className="fb-block-gap" />}
      <section className="fb-tunnel-card">
        <div className="fb-settings-grid">
          <span className="fb-settings-label">{t("加速通道")}</span>
          <div className="fb-settings-control">
            <Switch
              checked={status?.enabled ?? false}
              loading={busy === 'enable'}
              disabled={Boolean(busy) || !status?.available || (!status.sources.length && !status.enabled)}
              onChange={(checked) => void run('enable', () => window.browserApi.tunnel.setEnabled(checked))}
            />
            <span className={`fb-tunnel-state ${stateClass}`}><i />{t(label)}</span>
            {!status?.sources.length && <span className="fb-muted">{t("先添加节点，再开启")}</span>}
            {status?.error && <span className="fb-proxy-result bad">{mt(status.error)}</span>}
          </div>
          <span className="fb-settings-label">{t("节点来源")}</span>
          <div className="fb-settings-control">
            {status?.sources.map((source) => (
              <span key={source.id} className="fb-tunnel-source">
                <span className={`fb-tunnel-source-kind${source.kind === 'subscription' ? ' is-sub' : ''}`}>{source.kind === 'subscription' ? t("订阅") : t("手动")}</span>
                <span className="fb-tunnel-source-name" title={source.name}>{source.name}</span>
                <Button type="text" size="small" icon={<EditOutlined />} title={t("编辑")} disabled={Boolean(busy)} onClick={() => void edit(source.id)} />
                <Button type="text" size="small" icon={<CloseOutlined />} title={t("删除")} disabled={Boolean(busy)} onClick={() => remove(source.id, source.name)} />
              </span>
            ))}
            <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => { closeEditor(); setKind('links'); setAdding(true) }} disabled={!status?.available || Boolean(busy)}>{t("添加节点")}</Button>
          </div>
          <span className="fb-settings-label">{t("节点选择")}</span>
          <div className="fb-settings-control">
            <span className={`fb-tunnel-pill ${manual ? 'is-manual' : 'is-on'}`}>{manual ? t("手动固定") : <><ThunderboltOutlined />{t("自动选择最低延迟")}</>}</span>
            {manual && (
              <Button size="small" disabled={Boolean(busy) || !status?.sources.length} loading={busy === 'auto'} onClick={() => void run('auto', () => window.browserApi.tunnel.autoSelect())}>{t("自动选择最低延迟")}</Button>
            )}
          </div>
        </div>
        <p className="fb-muted fb-tunnel-note">{t("自动模式每 5 分钟测速，延迟改善超过 50 ms 时切换；手动固定后保持所选节点，重启后仍生效。")}</p>
      </section>

      {running && (
        <section className="fb-tunnel-card fb-tunnel-nodes">
          <div className="fb-tunnel-actions">
            <span className="fb-muted">{t("这里选的是默认节点：新窗口和新代理先用它；每个窗口还可以在自己的代理设置里另选节点。出口 IP 是经过这个节点时网站看到的 IP，代理商要加白名单时填它；测速时会重新查一次。")}</span>
            <Button size="small" loading={busy === 'test'} disabled={Boolean(busy)} onClick={() => void run('test', () => window.browserApi.tunnel.test())}>{t("测速")}</Button>
            {status.sources.some((source) => source.kind === 'subscription') && (
              <Button size="small" loading={busy === 'refresh'} disabled={Boolean(busy)} onClick={() => void run('refresh', () => window.browserApi.tunnel.refresh())}>{t("更新订阅")}</Button>
            )}
          </div>
          <Table<TunnelNodeInfo> rowKey="name" size="small" columns={columns} dataSource={status.nodes}
            rowClassName={(node) => node.name === status.selected ? 'fb-tunnel-row-active' : ''}
            pagination={status.nodes.length > 12 ? { pageSize: 12, size: 'small' } : false} />
        </section>
      )}

      <Modal
        open={adding}
        title={editingId ? t("编辑节点来源") : t("添加节点")}
        okText={editingId ? t("保存修改") : t("添加")}
        cancelText={t("取消")}
        confirmLoading={busy === 'add'}
        cancelButtonProps={{ disabled: busy === 'add' }}
        closable={busy !== 'add'}
        maskClosable={false}
        keyboard={false}
        onOk={() => void add()}
        onCancel={closeEditor}
      >
        <div className="fb-stack">
          {editingId && <Alert type="info" showIcon title={t("编辑此来源的名称、节点链接或订阅地址；保存后重新连接加速通道。订阅中的节点由订阅内容管理。")} />}
          <Radio.Group optionType="button" value={kind} onChange={(event) => setKind(event.target.value)}
            options={[{ value: 'links', label: t("粘贴节点链接") }, { value: 'subscription', label: t("订阅链接") }]} />
          <Input placeholder={t("名称（可选）")} value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
          {kind === 'links'
            ? <Input.TextArea rows={6} value={content} onChange={(event) => setContent(event.target.value)}
              placeholder={t("每行一个：vless://、vmess://、trojan://、ss://、hysteria2:// 等，也可以粘贴 Clash 配置里的 proxies 部分")} />
            : <Input value={content} onChange={(event) => setContent(event.target.value)} placeholder="https://…" />}
          <span className="fb-muted">{t("可以用机场的订阅，也可以填自己服务器的节点。节点信息加密保存在本机。")}</span>
          {addError && <Alert type="error" showIcon title={addError} />}
        </div>
      </Modal>
    </>
  )
}
