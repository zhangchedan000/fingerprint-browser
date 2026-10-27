import { Alert, Button, Card, Form, Input, Spin, Tabs } from 'antd'
import { useEffect, useState, type ReactNode } from 'react'
import { t } from '../../../shared/i18n'
import type { TeamRegistration, TeamStatus } from '../../../shared/team'
import { humanError } from './format'

/**
 * The app is only used signed in: until the team server confirms the account, this page is all
 * there is. The server is built in and not shown; new members sign up with an invite code.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<TeamStatus>()
  const [ready, setReady] = useState<boolean>()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()

  async function probe(address: string): Promise<void> {
    setError(undefined)
    setReady(undefined)
    try {
      setReady((await window.browserApi.team.probe(address)).ready)
    } catch (reason) {
      setError(humanError(reason))
    }
  }

  useEffect(() => {
    void window.browserApi.team.status().then((next) => {
      setStatus(next)
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

  async function submit(values: TeamRegistration): Promise<void> {
    if (!status) return
    setBusy(true)
    setError(undefined)
    try {
      if (ready === false) setStatus(await window.browserApi.team.setup(status.server, values.code, values.username, values.name ?? '', values.password))
      else if (mode === 'register') setStatus(await window.browserApi.team.register({ ...values, name: values.name ?? '' }))
      else setStatus(await window.browserApi.team.login(status.server, values.username, values.password))
    } catch (reason) {
      setError(humanError(reason))
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next: string): void {
    setMode(next as 'login' | 'register')
    setError(undefined)
    form.resetFields(['password', 'confirm'])
  }

  if (status?.user) return <>{children}</>
  if (!status) return <div className="fb-login"><Spin /></div>

  const signingUp = ready === false || mode === 'register'
  return (
    <div className="fb-login">
      <Card className="fb-login-card" title={ready === false ? t("创建主账号") : undefined}>
        {ready !== false && (
          <div className="fb-login-brand">
            <strong>{t("指纹浏览器")}</strong>
            <Tabs className="fb-login-tabs" activeKey={mode} onChange={switchMode} items={[
              { key: 'login', label: t("登录") },
              { key: 'register', label: t("注册") }
            ]} />
          </div>
        )}
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
        {error && (
          <Alert type="error" showIcon className="fb-team-alert" title={error}
            action={ready === undefined && !status.offline ? <Button size="small" onClick={() => void probe(status.server)}>{t("重试")}</Button> : undefined} />
        )}
        {ready === false && (
          <Alert type="info" showIcon className="fb-team-alert" title={t("这台服务器还没有主账号。初始化码在服务器的 /opt/prism-team/.env 里，只能用一次。")} />
        )}
        {ready === undefined && !error && !status.offline && <div className="fb-login-wait"><Spin /></div>}
        {ready !== undefined && (
          <Form layout="vertical" form={form} requiredMark={false} onFinish={(values) => void submit(values)}>
            {signingUp && (
              <Form.Item name="code" label={ready === false ? t("初始化码") : t("邀请码")}
                extra={ready === false ? undefined : t("向主账号要邀请码，一个码只能注册一个账号。")}
                rules={[{ required: true, message: ready === false ? t("请填写初始化码") : t("请填写邀请码") }]}>
                {ready === false ? <Input.Password autoComplete="off" /> : <Input autoComplete="off" placeholder="XXXX-XXXX-XXXX" className="fb-mono" />}
              </Form.Item>
            )}
            <Form.Item name="username" label={t("用户名")}
              rules={signingUp
                ? [{ required: true, message: t("请填写用户名") }, { pattern: /^[^\s@]{2,64}$/, message: t("2 到 64 个字符，不能有空格和 @") }]
                : [{ required: true, message: t("请填写用户名") }]}>
              <Input autoComplete="username" autoFocus />
            </Form.Item>
            {signingUp && (
              <Form.Item name="name" label={t("显示名称")}>
                <Input placeholder={ready === false ? t("例如：老板") : t("例如：小王")} />
              </Form.Item>
            )}
            <Form.Item name="password" label={t("密码")}
              rules={[{ required: true, min: signingUp ? 8 : 1, message: signingUp ? t("密码至少 8 位") : t("请填写密码") }]}>
              <Input.Password autoComplete={signingUp ? 'new-password' : 'current-password'} />
            </Form.Item>
            {signingUp && (
              <Form.Item name="confirm" label={t("确认密码")} dependencies={['password']} rules={[
                { required: true, message: t("请再输入一次密码") },
                ({ getFieldValue }) => ({
                  validator: (_rule, value) => !value || value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error(t("两次输入的密码不一样")))
                })
              ]}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            )}
            <Button type="primary" htmlType="submit" loading={busy} block>
              {ready === false ? t("创建并登录") : mode === 'register' ? t("注册并登录") : t("登录")}
            </Button>
          </Form>
        )}
        {ready && mode === 'login' && (
          <p className="fb-muted fb-login-hint">{t("没有账号？向主账号要邀请码，然后点上面的「注册」。")}</p>
        )}
      </Card>
    </div>
  )
}
