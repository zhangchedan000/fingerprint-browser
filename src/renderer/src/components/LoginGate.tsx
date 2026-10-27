import { Alert, Button, Card, Form, Input, Spin } from 'antd'
import { useEffect, useState, type ReactNode } from 'react'
import { t } from '../../../shared/i18n'
import type { TeamStatus } from '../../../shared/team'
import { humanError } from './format'

/**
 * The app is only used signed in: until the team server confirms the account, this page is all
 * there is. The server address is built in; "更换服务器" shows it for a different server.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<TeamStatus>()
  const [ready, setReady] = useState<boolean>()
  const [server, setServer] = useState('')
  const [editServer, setEditServer] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()

  async function probe(address: string): Promise<void> {
    setError(undefined)
    setReady(undefined)
    try {
      const result = await window.browserApi.team.probe(address)
      setServer(result.server)
      setReady(result.ready)
    } catch (reason) {
      setError(humanError(reason))
    }
  }

  useEffect(() => {
    void window.browserApi.team.status().then((next) => {
      setStatus(next)
      setServer(next.server)
      if (!next.user) void probe(next.server)
    }).catch((reason) => setError(humanError(reason)))
  }, [])

  async function retry(): Promise<void> {
    setBusy(true)
    try {
      const next = await window.browserApi.team.retry()
      setStatus(next)
      if (!next.user) await probe(next.server)
    } finally {
      setBusy(false)
    }
  }

  async function submit(values: { code?: string; username: string; name?: string; password: string }): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      setStatus(ready
        ? await window.browserApi.team.login(server, values.username, values.password)
        : await window.browserApi.team.setup(server, values.code ?? '', values.username, values.name ?? '', values.password))
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setBusy(false)
    }
  }

  if (status?.user) return <>{children}</>
  if (!status) return <div className="fb-login"><Spin /></div>

  return (
    <div className="fb-login">
      <Card className="fb-login-card" title={ready === false ? t("创建主账号") : t("登录指纹浏览器")}>
        {status.offline && ready === undefined && (
          <Alert
            type="warning"
            showIcon
            className="fb-team-alert"
            title={t("连不上服务器，暂时不能使用")}
            description={status.offline}
            action={<Button size="small" loading={busy} onClick={() => void retry()}>{t("重试")}</Button>}
          />
        )}
        {error && <Alert type="error" showIcon className="fb-team-alert" title={error} />}
        {editServer && (
          <Form.Item label={t("服务器地址")}>
            <Input.Search value={server} enterButton={t("连接")} onChange={(event) => setServer(event.target.value)} onSearch={(value) => void probe(value)} />
          </Form.Item>
        )}
        {ready === false && (
          <Alert type="info" showIcon className="fb-team-alert" title={t("这台服务器还没有主账号。初始化码在服务器的 /opt/prism-team/.env 里，只能用一次。")} />
        )}
        {ready === undefined && !error && !status.offline && <div className="fb-login-wait"><Spin /></div>}
        {ready !== undefined && (
          <Form layout="vertical" form={form} onFinish={(values) => void submit(values)}>
            {ready === false && (
              <>
                <Form.Item name="code" label={t("初始化码")} rules={[{ required: true, message: t("请填写初始化码") }]}>
                  <Input.Password autoComplete="off" />
                </Form.Item>
                <Form.Item name="name" label={t("显示名称")}>
                  <Input placeholder={t("例如：老板")} />
                </Form.Item>
              </>
            )}
            <Form.Item name="username" label={t("用户名")} rules={[{ required: true, message: t("请填写用户名") }]}>
              <Input autoComplete="username" autoFocus />
            </Form.Item>
            <Form.Item name="password" label={t("密码")} rules={[{ required: true, min: ready ? 1 : 8, message: ready ? t("请填写密码") : t("密码至少 8 位") }]}>
              <Input.Password autoComplete={ready ? 'current-password' : 'new-password'} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={busy} block>{ready ? t("登录") : t("创建并登录")}</Button>
          </Form>
        )}
        <div className="fb-login-foot">
          <span className="fb-muted fb-mono">{server}</span>
          {!editServer && <Button type="link" size="small" onClick={() => setEditServer(true)}>{t("更换服务器")}</Button>}
        </div>
        <p className="fb-muted fb-login-hint">{t("账号由主账号在「团队 → 成员」里创建。")}</p>
      </Card>
    </div>
  )
}
