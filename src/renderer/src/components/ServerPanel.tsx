import { Alert, Button, Form, Input, Modal, Popover, Space, Tag } from 'antd'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TeamStatus } from '../../../shared/team'
import { useWorkspace } from '../data/workspace'
import { humanError } from './format'

/**
 * The team server as the app sees it, behind the avatar (the brand mark at the top of the side
 * menu): a dot for its state, and a panel to retry, work in local mode, or connect to the team's
 * other server. Team texts are Chinese, like the team page.
 */

type Connection = 'online' | 'offline' | 'local' | 'none'

function connection(status?: TeamStatus): Connection {
  if (!status || status.disabled) return 'none'
  if (status.localMode) return 'local'
  if (status.offline) return 'offline'
  return status.user ? 'online' : 'none'
}

const LABEL: Record<Connection, { text: string; color: string }> = {
  online: { text: '已连接', color: 'success' },
  offline: { text: '连不上', color: 'error' },
  local: { text: '本地模式', color: 'warning' },
  none: { text: '未登录', color: 'default' }
}

/** Asks for another server of the team; one that is not in use yet takes over with its activation code. */
export function ConnectServerModal({ open, onClose, onDone, servers }: { open: boolean; onClose: () => void; onDone: (status: TeamStatus) => void; servers?: string[] }) {
  const [form] = Form.useForm<{ server: string; code?: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  async function submit(values: { server: string; code?: string }): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      onDone(await window.browserApi.team.connectServer(values.server, values.code || undefined))
      onClose()
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} title="连接其它服务器" okText="连接" cancelText="取消" maskClosable={false} keyboard={false}
      confirmLoading={busy} onOk={() => form.submit()} onCancel={onClose} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(values) => void submit(values)}
        initialValues={{ server: (servers ?? [])[1] ?? '' }}>
        <Form.Item name="server" label="服务器地址" rules={[{ required: true, message: '请填写服务器地址' }]}
          extra={servers?.length ? `团队的服务器：${servers.join('、')}` : undefined}>
          <Input placeholder="https://b.example.com" autoFocus />
        </Form.Item>
        <Form.Item name="code" label="激活码（只有主账号切换到还没接班的服务器时才要填）">
          <Input.Password autoComplete="off" />
        </Form.Item>
      </Form>
      {busy && <Alert type="info" showIcon title="正在连接；如果要接班，服务器会先从 R2 拉回全部数据再重启，大约 1 分钟。" />}
      {error && <Alert type="error" showIcon title={error} />}
    </Modal>
  )
}

/** The brand mark with the server dot; clicking it opens the panel. */
export function ServerAvatar({ children }: { children: ReactNode }) {
  const ws = useWorkspace()
  const [status, setStatus] = useState<TeamStatus>()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [connectOpen, setConnectOpen] = useState(false)
  const last = useRef<Connection | undefined>(undefined)
  // The last account seen (none while the server is out of reach): only the owner gets server notices.
  const owner = useRef(false)

  async function load(): Promise<void> {
    try {
      const next = await window.browserApi.team.status()
      setStatus(next)
      const state = connection(next)
      if (next.user) owner.current = next.user.role === 'owner'
      // Lost while working: the owner hears it once (members' apps follow the team by themselves).
      if (owner.current && state === 'offline' && last.current === 'online') ws.notify.warning('团队服务器连不上了：点左上角头像，可以重试、进入本地模式或连接备用服务器')
      if (owner.current && state === 'online' && (last.current === 'offline' || last.current === 'local')) ws.notify.success('团队服务器连上了')
      last.current = state
    } catch {
      // The panel shows the last state.
    }
  }

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, [])

  async function act(name: string, run: () => Promise<TeamStatus>): Promise<void> {
    setBusy(name)
    try {
      setStatus(await run())
      await load()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(undefined)
    }
  }

  const state = connection(status)
  if (state === 'none' && !status?.servers?.length) return <>{children}</>
  const label = LABEL[state]
  const panel = (
    <div className="fb-server-panel">
      <div className="fb-server-panel-row"><span>团队服务器</span><Tag color={label.color}>{label.text}</Tag></div>
      <div className="fb-server-panel-url fb-mono">{status?.server}</div>
      {status?.user && <div className="fb-server-panel-muted">账号：{status.user.name || status.user.username}</div>}
      {state === 'local' && <Alert type="warning" showIcon title="本地模式：窗口照常用；团队窗口在服务器恢复后自动上传。" />}
      {state === 'offline' && status?.offline && <Alert type="error" showIcon title={status.offline} />}
      {(status?.servers?.length ?? 0) > 1 && <div className="fb-server-panel-muted">团队的服务器：{status!.servers!.join('、')}</div>}
      <Space wrap>
        {state !== 'online' && <Button size="small" loading={busy === 'retry'} onClick={() => void act('retry', () => window.browserApi.team.retry())}>重试连接</Button>}
        {state === 'offline' && status?.canLocal && (
          <Button size="small" type="primary" loading={busy === 'local'} onClick={() => void act('local', () => window.browserApi.team.enterLocalMode())}>进入本地模式</Button>
        )}
        <Button size="small" onClick={() => { setOpen(false); setConnectOpen(true) }}>连接其它服务器</Button>
      </Space>
    </div>
  )
  return (
    <>
      <Popover content={panel} trigger="click" placement="rightTop" open={open} onOpenChange={(next) => { setOpen(next); if (next) void load() }}>
        <button type="button" className="fb-brand-avatar" aria-label="团队服务器">
          {children}
          <span className={`fb-server-dot fb-server-dot-${state}`} aria-hidden="true" />
        </button>
      </Popover>
      <ConnectServerModal open={connectOpen} servers={status?.servers} onClose={() => setConnectOpen(false)} onDone={(next) => { setStatus(next); void load() }} />
    </>
  )
}
