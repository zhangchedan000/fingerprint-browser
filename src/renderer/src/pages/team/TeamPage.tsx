import { CloudDownloadOutlined, DatabaseOutlined, KeyOutlined, LogoutOutlined, PlusOutlined, ReloadOutlined, SyncOutlined, UserAddOutlined } from '@ant-design/icons'
import { Button, Descriptions, Form, Input, Modal, Radio, Select, Space, Tabs, Tag, Tooltip, Typography, type TableColumnsType } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getLocale, t } from '../../../../shared/i18n'
import type { TeamBackup, TeamInvite, TeamLogEntry, TeamOffsite, TeamOffsiteDraft, TeamProfileView, TeamServerInfo, TeamStatus, TeamUser } from '../../../../shared/team'
import { dateTime, formatBytes } from '../../components/format'
import { ListPage } from '../../components/ListPage'
import { StatusPill } from '../../components/StatusPill'
import { useWindowLauncher } from '../../data/window-actions'
import { useWorkspace } from '../../data/workspace'
import { batchAssignees, type BatchAssignMode } from './batch-assign'
import type { PageProps } from '../registry'

const ACTIONS: Record<string, string> = {
  setup: '创建主账号',
  login: '登录',
  login_fail: '登录失败',
  register: '邀请码注册',
  invite_create: '生成邀请码',
  invite_revoke: '作废邀请码',
  open: '打开窗口',
  close: '关闭窗口',
  upload: '上传登录态',
  force_unlock: '强制释放',
  share: '新建云端窗口',
  update: '修改窗口',
  unshare: '删除云端窗口',
  member_create: '新建成员',
  member_update: '修改成员',
  member_delete: '删除成员',
  backup_create: '备份服务器',
  backup_download: '下载备份',
  backup_delete: '删除备份',
  offsite_set: '开启异地备份',
  offsite_off: '关闭异地备份'
}

function displayName(user: Pick<TeamUser, 'name' | 'username'>): string {
  return user.name || user.username
}

function time(value: string): string {
  const date = new Date(value.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function logDetail(entry: TeamLogEntry): string {
  const detail = entry.detail
  const parts: string[] = []
  if (typeof detail.device === 'string' && detail.device) parts.push(`设备 ${detail.device}`)
  if (typeof detail.rev === 'number') parts.push(`第 ${detail.rev} 版`)
  if (typeof detail.size === 'number' && detail.size) parts.push(formatBytes(detail.size))
  if (typeof detail.holder === 'string') parts.push(`原占用人 ${detail.holder}`)
  if (typeof detail.member === 'string') parts.push(detail.member)
  if (typeof detail.key === 'string') parts.push(detail.key)
  if (typeof detail.username === 'string' && detail.username) parts.push(`用户名 ${detail.username}`)
  if (typeof detail.note === 'string' && detail.note) parts.push(`备注 ${detail.note}`)
  if (Array.isArray(detail.assignees)) parts.push(`成员：${detail.assignees.join('、') || '无'}`)
  if (Array.isArray(detail.fields)) {
    const names: Record<string, string> = { name: '名称', note: '备注', config: '配置', assignees: '成员', username: '用户名', password: '密码', disabled: '启用状态' }
    parts.push(`改了${(detail.fields as string[]).map((field) => names[field] ?? field).join('、')}`)
  }
  if (detail.disabled === true) parts.push('已停用')
  return parts.join(' · ')
}

function MemberFormModal({ member, open, onClose, onSaved }: { member?: TeamUser; open: boolean; onClose: () => void; onSaved: () => void }) {
  const ws = useWorkspace()
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) form.setFieldsValue({ username: member?.username ?? '', name: member?.name ?? '', password: '' })
  }, [open, member, form])

  async function save(values: { username: string; name: string; password: string }): Promise<void> {
    setBusy(true)
    try {
      if (member) await window.browserApi.team.updateMember(member.id, { username: values.username, name: values.name, password: values.password || undefined })
      else await window.browserApi.team.createMember(values)
      ws.notify.success(member ? t("成员已更新") : t("成员已创建"))
      onSaved()
      onClose()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title={member ? t("修改成员") : t("新建成员")} okText={t("保存")} cancelText={t("取消")} confirmLoading={busy} onOk={() => form.submit()} onCancel={onClose} destroyOnHidden>
      <Form layout="vertical" form={form} onFinish={(values) => void save(values)}>
        <Form.Item name="username" label={t("用户名")} extra={t("成员用它登录，不能有空格和 @")} rules={[{ required: true, message: t("请填写用户名") }, { pattern: /^[^\s@]{2,64}$/, message: t("2 到 64 个字符，不能有空格和 @") }]}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="name" label={t("显示名称")}>
          <Input placeholder={t("例如：小王")} />
        </Form.Item>
        <Form.Item
          name="password"
          label={member ? t("新密码") : t("密码")}
          extra={member ? t("留空则不修改") : undefined}
          rules={[{ required: !member, message: t("请填写密码") }, { min: 8, message: t("密码至少 8 位") }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/** XXXX-XXXX-XXXX, easier to read off a chat message. */
function inviteCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code
}

function inviteState(invite: TeamInvite): 'used' | 'expired' | 'open' {
  if (invite.usedAt) return 'used'
  return invite.expires <= Date.now() ? 'expired' : 'open'
}

/** Owner: one code per person; it signs up one member and is then used up. */
function InvitesPanel({ reloadMembers }: { reloadMembers: () => void }) {
  const ws = useWorkspace()
  const [invites, setInvites] = useState<TeamInvite[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [note, setNote] = useState('')
  const [askOpen, setAskOpen] = useState(false)
  const [made, setMade] = useState<TeamInvite>()

  async function reload(): Promise<void> {
    setLoading(true)
    try {
      const next = await window.browserApi.team.invites()
      setInvites(next)
      // A code used since the last look means a new member.
      if (next.some((invite) => invite.usedAt && !invites.find((old) => old.id === invite.id)?.usedAt)) reloadMembers()
    } catch (error) {
      ws.fail(error)
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  useEffect(() => { void reload() }, [])

  async function create(): Promise<void> {
    setCreating(true)
    try {
      const invite = await window.browserApi.team.createInvite(note)
      setAskOpen(false)
      setNote('')
      setMade(invite)
      await reload()
    } catch (error) {
      ws.fail(error)
    } finally {
      setCreating(false)
    }
  }

  function revoke(invite: TeamInvite): void {
    Modal.confirm({
      title: t("作废邀请码 {0}？", inviteCode(invite.code)),
      content: t("作废后这个码不能再注册。"),
      okText: t("作废"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          await window.browserApi.team.revokeInvite(invite.id)
          await reload()
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  const columns: TableColumnsType<TeamInvite> = [
    {
      title: t("邀请码"),
      dataIndex: 'code',
      width: 210,
      render: (code: string, row) => inviteState(row) === 'open'
        ? <Typography.Text className="fb-invite-code" copyable={{ text: inviteCode(code) }}>{inviteCode(code)}</Typography.Text>
        : <span className="fb-invite-code fb-muted">{inviteCode(code)}</span>
    },
    { title: t("备注"), dataIndex: 'note', render: (value: string) => value || <span className="fb-muted">—</span> },
    {
      title: t("状态"),
      key: 'state',
      width: 200,
      render: (_value, row) => {
        const state = inviteState(row)
        if (state === 'used') return <StatusPill tone="success">{t("已被 {0} 使用", row.usedName)}</StatusPill>
        if (state === 'expired') return <StatusPill>{t("已过期")}</StatusPill>
        return <StatusPill tone="info">{t("{0} 前有效", new Date(row.expires).toLocaleDateString())}</StatusPill>
      }
    },
    { title: t("生成时间"), dataIndex: 'created', width: 180, render: (value: string) => <span className="fb-muted">{time(value)}</span> },
    {
      title: t("操作"),
      key: 'actions',
      width: 90,
      align: 'right',
      render: (_value, row) => inviteState(row) === 'open'
        ? <Button size="small" type="link" danger autoInsertSpace={false} onClick={() => revoke(row)}>{t("作废")}</Button>
        : null
    }
  ]

  return (
    <div className="fb-team-invites">
      <h3>{t("邀请码")}</h3>
      <ListPage<TeamInvite>
        toolbar={(
          <Space>
            <Button type="primary" icon={<UserAddOutlined />} onClick={() => setAskOpen(true)}>{t("生成邀请码")}</Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>{t("刷新")}</Button>
          </Space>
        )}
        columns={columns}
        rows={invites}
        loading={loading}
        paginate={false}
        emptyText={t("还没有邀请码")}
        footnote={t("把邀请码发给对方，对方在登录页点「注册」，填邀请码、用户名和密码就成为你的成员。一个码只能用一次，7 天内有效。")}
      />
      <Modal open={askOpen} title={t("生成邀请码")} okText={t("生成")} cancelText={t("取消")} confirmLoading={creating}
        onOk={() => void create()} onCancel={() => setAskOpen(false)} destroyOnHidden>
        <Input placeholder={t("备注（可选），例如：给小王")} maxLength={100} value={note} onChange={(event) => setNote(event.target.value)}
          onPressEnter={() => void create()} autoFocus />
      </Modal>
      <Modal open={Boolean(made)} title={t("邀请码已生成")} okText={t("复制并关闭")} cancelText={t("关闭")}
        onOk={() => { if (made) void navigator.clipboard.writeText(inviteCode(made.code)).then(() => ws.notify.success(t("已复制"))); setMade(undefined) }}
        onCancel={() => setMade(undefined)}>
        {made && (
          <>
            <span className="fb-invite-big">{inviteCode(made.code)}</span>
            <p className="fb-muted">
              {made.note ? t("备注：{0}。", made.note) : ''}
              {t("发给对方，在指纹浏览器登录页点「注册」使用。{0} 前有效，只能用一次。", new Date(made.expires).toLocaleString())}
            </p>
          </>
        )}
      </Modal>
    </div>
  )
}

/** Own password; the app signs in again with the new one. */
function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace()
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)

  async function save(values: { oldPassword: string; password: string }): Promise<void> {
    setBusy(true)
    try {
      await window.browserApi.team.changePassword(values.oldPassword, values.password)
      ws.notify.success(t("密码已修改，其他电脑上需要用新密码重新登录"))
      onClose()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title={t("修改密码")} okText={t("保存")} cancelText={t("取消")} confirmLoading={busy} onOk={() => form.submit()} onCancel={onClose} destroyOnHidden>
      <Form layout="vertical" form={form} onFinish={(values) => void save(values)} autoComplete="off">
        <Form.Item name="oldPassword" label={t("当前密码")} rules={[{ required: true, message: t("请填写当前密码") }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="password" label={t("新密码")} rules={[{ required: true, message: t("请填写新密码") }, { min: 8, message: t("密码至少 8 位") }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="confirm" label={t("确认新密码")} dependencies={['password']} rules={[
          { required: true, message: t("请再输入一次密码") },
          ({ getFieldValue }) => ({
            validator: (_rule, value) => !value || value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error(t("两次输入的密码不一样")))
          })
        ]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

function MembersTab({ members, reload }: { members: TeamUser[]; reload: () => void }) {
  const ws = useWorkspace()
  const [editing, setEditing] = useState<TeamUser>()
  const [formOpen, setFormOpen] = useState(false)
  const rows = members.filter((member) => member.role === 'member')

  async function toggle(member: TeamUser): Promise<void> {
    try {
      await window.browserApi.team.updateMember(member.id, { disabled: !member.disabled })
      ws.notify.success(member.disabled ? t("已启用") : t("已停用，对方会立即失去访问权限"))
      reload()
    } catch (error) {
      ws.fail(error)
    }
  }

  function remove(member: TeamUser): void {
    Modal.confirm({
      title: t("删除成员“{0}”？", displayName(member)),
      content: t("删除后对方无法登录，日志里的记录会保留。只想暂时禁止登录可以用“停用”。"),
      okText: t("删除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          await window.browserApi.team.removeMember(member.id)
          reload()
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  const columns: TableColumnsType<TeamUser> = [
    { title: t("用户名"), dataIndex: 'username', render: (value: string) => <strong>{value}</strong> },
    { title: t("显示名称"), dataIndex: 'name', render: (value: string) => value || <span className="fb-muted">—</span> },
    { title: t("状态"), key: 'disabled', width: 100, render: (_value, row) => row.disabled ? <StatusPill>{t("已停用")}</StatusPill> : <StatusPill tone="success">{t("正常")}</StatusPill> },
    { title: t("创建时间"), dataIndex: 'created', width: 180, render: (value: string) => <span className="fb-muted">{time(value)}</span> },
    {
      title: t("操作"),
      key: 'actions',
      width: 220,
      align: 'right',
      render: (_value, row) => (
        <Space size={2}>
          <Button size="small" type="link" autoInsertSpace={false} onClick={() => { setEditing(row); setFormOpen(true) }}>{t("修改")}</Button>
          <Button size="small" type="link" autoInsertSpace={false} onClick={() => void toggle(row)}>{row.disabled ? t("启用") : t("停用")}</Button>
          <Button size="small" type="link" danger autoInsertSpace={false} onClick={() => remove(row)}>{t("删除")}</Button>
        </Space>
      )
    }
  ]

  return (
    <>
      <ListPage<TeamUser>
        toolbar={<Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(undefined); setFormOpen(true) }}>{t("新建成员")}</Button>}
        columns={columns}
        rows={rows}
        paginate={false}
        emptyText={t("还没有成员")}
        footnote={t("成员用自己的用户名和密码登录，只能看到自己建的和分配给他的窗口。忘了密码可以点「修改」给他设新密码。")}
      />
      <MemberFormModal open={formOpen} member={editing} onClose={() => setFormOpen(false)} onSaved={reload} />
      <InvitesPanel reloadMembers={reload} />
    </>
  )
}

function AssignModal({ profile, members, open, onClose, onSaved }: { profile?: TeamProfileView; members: TeamUser[]; open: boolean; onClose: () => void; onSaved: () => void }) {
  const ws = useWorkspace()
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setPicked(profile?.assignees ?? []) }, [open, profile])
  async function save(): Promise<void> {
    if (!profile) return
    setBusy(true)
    try {
      await window.browserApi.team.updateProfile(profile.id, { assignees: picked })
      onSaved()
      onClose()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} title={profile ? t("分配“{0}”", profile.name) : ''} okText={t("保存")} cancelText={t("取消")} confirmLoading={busy} onOk={() => void save()} onCancel={onClose}>
      <MemberSelect members={members} value={picked} onChange={setPicked} />
      <p className="fb-muted fb-team-hint">{t("收回后对方再也打不开这个窗口；正在使用的会在关闭时上传登录态。")}</p>
    </Modal>
  )
}

/** Owner: assigns several cloud windows at once. */
function BatchAssignModal({ profiles, members, open, onClose, onSave }: {
  profiles: TeamProfileView[]
  members: TeamUser[]
  open: boolean
  onClose: () => void
  onSave: (picked: string[], mode: BatchAssignMode) => Promise<void>
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [mode, setMode] = useState<BatchAssignMode>('add')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setPicked([]); setMode('add') } }, [open])
  async function save(): Promise<void> {
    setBusy(true)
    try {
      await onSave(picked, mode)
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      title={t("分配 {0} 个云端窗口", profiles.length)}
      okText={t("保存")}
      cancelText={t("取消")}
      confirmLoading={busy}
      okButtonProps={{ disabled: mode !== 'set' && !picked.length }}
      onOk={() => void save()}
      onCancel={onClose}
    >
      <div className="fb-stack">
        <Radio.Group
          optionType="button"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
          options={[
            { value: 'add', label: t("加上这些成员") },
            { value: 'set', label: t("只给这些成员") },
            { value: 'remove', label: t("收回这些成员") }
          ]}
        />
        <MemberSelect members={members} value={picked} onChange={setPicked} />
        <p className="fb-muted fb-team-hint">
          {mode === 'add'
            ? t("已经分配的成员保留，再加上选中的成员。")
            : mode === 'set'
              ? t("每个窗口都改成只分配给选中的成员；不选任何人就是全部收回。")
              : t("从这些窗口收回选中的成员，其他成员不变。")}
          {mode !== 'add' && ` ${t("收回后对方再也打不开这个窗口；正在使用的会在关闭时上传登录态。")}`}
        </p>
      </div>
    </Modal>
  )
}

function MemberSelect({ members, value, onChange }: { members: TeamUser[]; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <Select
      mode="multiple"
      style={{ width: '100%' }}
      placeholder={t("选择成员")}
      value={value}
      onChange={onChange}
      optionFilterProp="label"
      options={members.filter((member) => member.role === 'member').map((member) => ({
        value: member.id,
        label: member.disabled ? `${displayName(member)}（${t("已停用")}）` : displayName(member)
      }))}
    />
  )
}

/** Every window is a cloud window: the owner assigns them; everyone opens theirs from here or the window list. */
function ProfilesTab({ status, members, profiles, loading, reload }: {
  status: TeamStatus
  members: TeamUser[]
  profiles: TeamProfileView[]
  loading: boolean
  reload: () => void
}) {
  const ws = useWorkspace()
  const { launch } = useWindowLauncher()
  const owner = status.user?.role === 'owner'
  const me = status.user?.id
  const [assigning, setAssigning] = useState<TeamProfileView>()
  const [busy, setBusy] = useState<string>()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [batchAssigning, setBatchAssigning] = useState(false)
  // A refresh drops windows that are gone from the selection.
  useEffect(() => setSelectedIds((ids) => ids.filter((id) => profiles.some((profile) => profile.id === id))), [profiles])
  const selected = profiles.filter((profile) => selectedIds.includes(profile.id))
  const memberNames = useMemo(() => new Map(members.map((member) => [member.id, displayName(member)])), [members])

  async function syncNow(): Promise<void> {
    setBusy('sync')
    try {
      const result = await window.browserApi.team.sync()
      await ws.reloadProfiles()
      ws.notify.success(result.added || result.uploaded
        ? t("已同步：下载 {0} 个，上传 {1} 个", result.added, result.uploaded)
        : t("已是最新"))
      reload()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(undefined)
    }
  }

  async function open(profile: TeamProfileView): Promise<void> {
    setBusy(profile.id)
    try {
      const localId = profile.localId ?? await window.browserApi.team.addToComputer(profile.id)
      await ws.reloadProfiles()
      const local = (await window.browserApi.profiles.list()).find((item) => item.id === localId)
      if (!local) throw new Error(t("本机没有找到这个窗口"))
      const next = await launch(local)
      if (next) ws.upsertProfiles([next])
      reload()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(undefined)
    }
  }

  async function addHere(profile: TeamProfileView): Promise<void> {
    setBusy(profile.id)
    try {
      await window.browserApi.team.addToComputer(profile.id)
      await ws.reloadProfiles()
      ws.notify.success(t("已添加到本机"))
      reload()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(undefined)
    }
  }

  function removeFromCloud(profile: TeamProfileView): void {
    Modal.confirm({
      title: t("删除云端窗口“{0}”？", profile.name),
      content: t("云端的配置和登录状态会被删除，所有人都打不开它；这台电脑上的副本移到回收站。其他电脑上的副本留着但打不开。"),
      okText: t("删除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        try {
          await window.browserApi.team.unshare(profile.id)
          await ws.reloadProfiles()
          reload()
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  async function forceUnlock(profile: TeamProfileView): Promise<void> {
    try {
      await window.browserApi.team.forceUnlock(profile.id)
      ws.notify.success(t("已释放"))
      reload()
    } catch (error) {
      ws.fail(error)
    }
  }

  /** Runs one action per window, one after another, and says how it went. */
  async function runMany(key: string, rows: TeamProfileView[], action: (profile: TeamProfileView) => Promise<unknown>, done: string): Promise<void> {
    setBusy(key)
    const failures: string[] = []
    for (const profile of rows) {
      try {
        await action(profile)
      } catch (error) {
        failures.push(`${profile.name}：${error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)}`)
      }
    }
    await ws.reloadProfiles().catch(() => undefined)
    reload()
    setBusy(undefined)
    if (failures.length) ws.fail(new Error(t("{0}：成功 {1} 个，失败 {2} 个。{3}", done, rows.length - failures.length, failures.length, failures.slice(0, 3).join('；'))))
    else ws.notify.success(t("{0}：{1} 个", done, rows.length))
  }

  async function assignMany(picked: string[], mode: BatchAssignMode): Promise<void> {
    await runMany('assign', selected, (profile) => window.browserApi.team.updateProfile(profile.id, { assignees: batchAssignees(profile.assignees, picked, mode) }), t("已分配"))
  }

  function removeManyFromCloud(): void {
    const rows = selected
    const names = rows.slice(0, 8).map((profile) => profile.name).join('、') + (rows.length > 8 ? t(" 等 {0} 个", rows.length) : '')
    Modal.confirm({
      title: t("删除 {0} 个云端窗口？", rows.length),
      content: <>
        <p>{names}</p>
        <p>{t("云端的配置和登录状态会被删除，所有人都打不开它；这台电脑上的副本移到回收站。其他电脑上的副本留着但打不开。")}</p>
      </>,
      okText: t("删除"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: async () => {
        await runMany('remove', rows, (profile) => window.browserApi.team.unshare(profile.id), t("已删除云端窗口"))
        setSelectedIds([])
      }
    })
  }

  const notHere = selected.filter((profile) => !profile.localId)
  const locked = selected.filter((profile) => profile.lock)

  const localStatus = (profile: TeamProfileView) => ws.profiles.find((item) => item.id === profile.localId)?.status
  const ownerLabel = (profile: TeamProfileView) => profile.ownerId === me
    ? t("我")
    : memberNames.get(profile.ownerId) ?? (owner ? t("主账号") : t("主账号分配"))
  const columns: TableColumnsType<TeamProfileView> = [
    {
      title: t("序号"),
      dataIndex: 'serialNumber',
      width: 64,
      sorter: (first, second) => (first.serialNumber ?? 0) - (second.serialNumber ?? 0),
      render: (serial?: number) => <span className="fb-muted">{serial ?? '—'}</span>
    },
    { title: t("窗口"), dataIndex: 'name', width: 180, render: (value: string, row) => <><strong>{value}</strong>{row.note && <div className="fb-muted fb-ellipsis">{row.note}</div>}</> },
    {
      title: t("创建时间"),
      dataIndex: 'createdAt',
      width: 130,
      sorter: (first, second) => first.createdAt.localeCompare(second.createdAt),
      render: (createdAt: string) => <span className="fb-muted fb-nowrap">{dateTime(createdAt, getLocale())}</span>
    },
    { title: t("创建人"), key: 'owner', width: 110, render: (_value, row) => <span className="fb-muted">{ownerLabel(row)}</span> },
    ...(owner ? [{
      title: t("分配给"),
      key: 'assignees',
      width: 140,
      render: (_value: unknown, row: TeamProfileView) => row.assignees.length
        ? row.assignees.map((id) => <Tag key={id}>{memberNames.get(id) ?? id}</Tag>)
        : <span className="fb-muted">{t("未分配")}</span>
    }] : []),
    {
      title: t("使用情况"),
      key: 'lock',
      width: 130,
      render: (_value, row) => row.lock
        ? <Tooltip title={row.lock.device ? t("设备：{0}", row.lock.device) : undefined}><span><StatusPill tone="warning" pulse>{t("{0} 正在使用", row.lock.holderName)}</StatusPill></span></Tooltip>
        : <StatusPill>{t("空闲")}</StatusPill>
    },
    {
      title: t("登录状态"),
      key: 'data',
      width: 190,
      render: (_value, row) => row.dataRev
        ? <span className="fb-muted">{t("第 {0} 版", row.dataRev)}{row.dataByName && ` · ${row.dataByName}`}{row.dataSize ? ` · ${formatBytes(row.dataSize)}` : ''}</span>
        : <span className="fb-muted">—</span>
    },
    {
      title: t("本机"),
      key: 'local',
      width: 130,
      render: (_value, row) => row.localId
        ? <StatusPill tone="success">{t("已在本机")}</StatusPill>
        : <StatusPill>{row.removedHere ? t("已从本机删除") : t("未添加")}</StatusPill>
    },
    {
      title: t("操作"),
      key: 'actions',
      width: owner ? 210 : 130,
      align: 'right',
      render: (_value, row) => {
        const running = localStatus(row) === 'running' || localStatus(row) === 'starting'
        const heldByOther = Boolean(row.lock && row.lock.holderId !== me)
        return (
          <Space size={2}>
            {row.localId
              ? (
                  <Button size="small" type="link" autoInsertSpace={false} loading={busy === row.id} disabled={running || heldByOther} onClick={() => void open(row)}>
                    {running ? t("运行中") : t("打开")}
                  </Button>
                )
              : <Button size="small" type="link" autoInsertSpace={false} loading={busy === row.id} onClick={() => void addHere(row)}>{t("添加到本机")}</Button>}
            {owner && <Button size="small" type="link" autoInsertSpace={false} onClick={() => setAssigning(row)}>{t("分配")}</Button>}
            {owner && row.lock && <Button size="small" type="link" autoInsertSpace={false} onClick={() => void forceUnlock(row)}>{t("强制释放")}</Button>}
            {owner && <Button size="small" type="link" danger autoInsertSpace={false} onClick={() => removeFromCloud(row)}>{t("删除云端")}</Button>}
          </Space>
        )
      }
    }
  ]

  return (
    <>
      <ListPage<TeamProfileView>
        toolbar={(
          <>
            <Button type="primary" icon={<SyncOutlined />} loading={busy === 'sync'} onClick={() => void syncNow()}>{t("立即同步")}</Button>
            <Button icon={<ReloadOutlined />} onClick={reload}>{t("刷新")}</Button>
          </>
        )}
        selection={{
          ids: selectedIds,
          onChange: setSelectedIds,
          label: (count) => t("已选 {0} 个云端窗口", count),
          actions: (
            <>
              {owner && <Button size="small" type="link" disabled={Boolean(busy)} loading={busy === 'assign'} onClick={() => setBatchAssigning(true)}>{t("批量分配")}</Button>}
              <Button size="small" type="link" disabled={Boolean(busy) || !notHere.length} loading={busy === 'add'}
                onClick={() => void runMany('add', notHere, (profile) => window.browserApi.team.addToComputer(profile.id), t("已添加到本机"))}>
                {notHere.length && notHere.length < selected.length ? t("添加到本机（{0} 个）", notHere.length) : t("添加到本机")}
              </Button>
              {owner && (
                <Button size="small" type="link" disabled={Boolean(busy) || !locked.length} loading={busy === 'unlock'}
                  onClick={() => void runMany('unlock', locked, (profile) => window.browserApi.team.forceUnlock(profile.id), t("已释放"))}>
                  {locked.length && locked.length < selected.length ? t("强制释放（{0} 个）", locked.length) : t("强制释放")}
                </Button>
              )}
              {owner && <Button size="small" type="link" danger disabled={Boolean(busy)} loading={busy === 'remove'} onClick={removeManyFromCloud}>{t("删除云端")}</Button>}
            </>
          )
        }}
        columns={columns}
        rows={profiles}
        loading={loading}
        scrollX="content"
        emptyText={owner ? t("还没有云端窗口") : t("还没有你的窗口")}
        footnote={owner
          ? t("所有窗口都自动存到云端：新建后上传配置，关闭时上传登录状态，换电脑登录后自动出现。同一个窗口同一时间只能一个人打开。")
          : t("你自己建的窗口和分配给你的窗口都在这里。分配给你的窗口不能修改或导出。")}
      />
      <AssignModal open={Boolean(assigning)} profile={assigning} members={members} onClose={() => setAssigning(undefined)} onSaved={reload} />
      <BatchAssignModal open={batchAssigning} profiles={selected} members={members} onClose={() => setBatchAssigning(false)} onSave={assignMany} />
    </>
  )
}

function LogsTab({ members, profiles }: { members: TeamUser[]; profiles: TeamProfileView[] }) {
  const ws = useWorkspace()
  const [page, setPage] = useState(1)
  const [userId, setUserId] = useState<string>()
  const [profileId, setProfileId] = useState<string>()
  const [action, setAction] = useState<string>()
  const [rows, setRows] = useState<TeamLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const perPage = 50

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.browserApi.team.logs({ page, perPage, userId, profileId, action })
      .then((result) => { if (!cancelled) { setRows(result.items); setTotal(result.totalItems) } })
      .catch((error) => ws.fail(error))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ws.fail is stable enough for a reload
  }, [page, userId, profileId, action])

  const columns: TableColumnsType<TeamLogEntry> = [
    { title: t("时间"), dataIndex: 'created', width: 170, render: (value: string) => time(value) },
    { title: t("成员"), dataIndex: 'userName', width: 120 },
    { title: t("操作"), dataIndex: 'action', width: 110, render: (value: string) => ACTIONS[value] ?? value },
    { title: t("窗口"), dataIndex: 'profileName', width: 160, render: (value: string) => value || <span className="fb-muted">—</span> },
    { title: t("详情"), key: 'detail', ellipsis: true, render: (_value, row) => <span className="fb-muted">{logDetail(row)}</span> },
    { title: 'IP', dataIndex: 'ip', width: 140, render: (value: string) => <span className="fb-mono fb-muted">{value}</span> }
  ]

  return (
    <>
      <ListPage<TeamLogEntry>
        toolbar={<span className="fb-muted">{t("共 {0} 条", total)}</span>}
        filters={(
          <Space>
            <Select allowClear placeholder={t("全部成员")} style={{ width: 140 }} value={userId} onChange={(value) => { setUserId(value); setPage(1) }}
              options={members.map((member) => ({ value: member.id, label: displayName(member) }))} />
            <Select allowClear placeholder={t("全部窗口")} style={{ width: 160 }} value={profileId} onChange={(value) => { setProfileId(value); setPage(1) }}
              options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))} />
            <Select allowClear placeholder={t("全部操作")} style={{ width: 130 }} value={action} onChange={(value) => { setAction(value); setPage(1) }}
              options={Object.entries(ACTIONS).map(([value, label]) => ({ value, label }))} />
          </Space>
        )}
        columns={columns}
        rows={rows}
        loading={loading}
        paginate={false}
        emptyText={t("没有日志")}
      />
      {total > perPage && (
        <div className="fb-team-pager">
          <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("上一页")}</Button>
          <span className="fb-muted">{page} / {Math.ceil(total / perPage)}</span>
          <Button disabled={page * perPage >= total} onClick={() => setPage(page + 1)}>{t("下一页")}</Button>
        </div>
      )}
    </>
  )
}

/** "0 19 * * *" (UTC) → "每天 03:00" in this computer's time; anything else is shown as it is. */
function scheduleText(cron: string): string {
  const match = cron.match(/^(\d+) (\d+) \* \* \*$/)
  if (!match) return cron
  const at = new Date(Date.UTC(2000, 0, 1, Number(match[2]), Number(match[1])))
  return `每天 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

type BackupRow = TeamBackup & { id: string }

/** The R2 address and token keys; the server tries them before it keeps them. */
function OffsiteModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const ws = useWorkspace()
  const [form] = Form.useForm<TeamOffsiteDraft>()
  const [busy, setBusy] = useState(false)

  async function save(values: TeamOffsiteDraft): Promise<void> {
    setBusy(true)
    try {
      await window.browserApi.team.setOffsite(values)
      ws.notify.success('异地备份已开启，1 分钟内会做第一次完整同步')
      onSaved()
      onClose()
    } catch (error) {
      ws.fail(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title="设置异地备份（Cloudflare R2）" okText="测试并保存" cancelText="取消" confirmLoading={busy} onOk={() => form.submit()} onCancel={onClose} destroyOnHidden>
      <Form layout="vertical" form={form} onFinish={(values) => void save(values)} autoComplete="off">
        <Form.Item name="url" label="S3 API 地址" extra="R2 存储桶「设置」页里的 S3 API，形如 https://xxxx.r2.cloudflarestorage.com/存储桶名"
          rules={[{ required: true, message: '请填写 S3 API 地址' }, { pattern: /^https:\/\/[a-z0-9.-]+\/[a-z0-9-]+\/?$/i, message: '地址要带上存储桶名' }]}>
          <Input placeholder="https://xxxx.r2.cloudflarestorage.com/prism-team-backup" />
        </Form.Item>
        <Form.Item name="accessKeyId" label="访问密钥 ID" rules={[{ required: true, message: '请填写访问密钥 ID' }]}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="secretAccessKey" label="机密访问密钥" extra="只存在你的团队服务器上，软件里不会再显示。" rules={[{ required: true, message: '请填写机密访问密钥' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/** The R2 copy: made a minute after each change, so its last time says how fresh it is. */
function OffsiteStatus({ offsite, onEdit, onRemove }: { offsite?: TeamOffsite; onEdit: () => void; onRemove: () => void }) {
  if (!offsite?.configured) {
    return (
      <Space size={6} wrap>
        <span className="fb-muted">没有开启</span>
        <Button size="small" type="primary" onClick={onEdit}>设置异地备份</Button>
      </Space>
    )
  }
  const last = Math.max(offsite.lastDb ?? 0, offsite.lastFiles ?? 0)
  const failing = Boolean(offsite.lastErrorAt && offsite.lastErrorAt > last)
  return (
    <Space size={6} wrap>
      <span>Cloudflare R2 · {offsite.bucket}</span>
      <span className="fb-muted fb-mono">{offsite.accessKeyId}</span>
      {failing
        ? <StatusPill tone="danger">失败：{offsite.lastError}</StatusPill>
        : last
          ? <StatusPill tone="success">最近同步 {new Date(last).toLocaleString()}</StatusPill>
          : <StatusPill>等待第一次同步</StatusPill>}
      {offsite.pending && <StatusPill tone="info" pulse>有改动，1 分钟内同步</StatusPill>}
      <Button size="small" type="link" autoInsertSpace={false} onClick={onEdit}>修改</Button>
      <Button size="small" type="link" danger autoInsertSpace={false} onClick={onRemove}>关闭</Button>
    </Space>
  )
}

function ServerTab() {
  const ws = useWorkspace()
  const [info, setInfo] = useState<TeamServerInfo>()
  const [backups, setBackups] = useState<TeamBackup[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [downloading, setDownloading] = useState<string>()
  const [offsiteOpen, setOffsiteOpen] = useState(false)

  async function reload(): Promise<void> {
    setLoading(true)
    try {
      const [nextInfo, nextBackups] = await Promise.all([window.browserApi.team.serverInfo(), window.browserApi.team.backups()])
      setInfo(nextInfo)
      setBackups(nextBackups)
    } catch (error) {
      ws.fail(error)
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  useEffect(() => { void reload() }, [])

  async function backupNow(): Promise<void> {
    setCreating(true)
    try {
      await window.browserApi.team.createBackup()
      ws.notify.success('备份完成')
      await reload()
    } catch (error) {
      ws.fail(error)
    } finally {
      setCreating(false)
    }
  }

  async function download(backup: TeamBackup): Promise<void> {
    setDownloading(backup.key)
    try {
      const saved = await window.browserApi.team.downloadBackup(backup.key)
      if (saved) ws.notify.success(`已保存到 ${saved}`)
    } catch (error) {
      ws.fail(error)
    } finally {
      setDownloading(undefined)
    }
  }

  function removeOffsite(): void {
    Modal.confirm({
      title: '关闭异地备份？',
      content: '服务器会删掉保存的 R2 密钥，不再往 R2 同步。R2 上已有的备份不会删除。',
      okText: '关闭',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.browserApi.team.removeOffsite()
          await reload()
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  function remove(backup: TeamBackup): void {
    Modal.confirm({
      title: `删除备份“${backup.key}”？`,
      content: '删除后无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.browserApi.team.removeBackup(backup.key)
          await reload()
        } catch (error) {
          ws.fail(error)
          throw error
        }
      }
    })
  }

  const columns: TableColumnsType<BackupRow> = [
    { title: '备份', dataIndex: 'key', render: (value: string) => <span className="fb-mono">{value}</span> },
    { title: '方式', dataIndex: 'auto', width: 90, render: (value: boolean) => value ? <StatusPill dot={false}>自动</StatusPill> : <StatusPill tone="info" dot={false}>手动</StatusPill> },
    { title: '大小', dataIndex: 'size', width: 110, render: (value: number) => formatBytes(value) },
    { title: '时间', dataIndex: 'modified', width: 180, render: (value: number) => <span className="fb-muted">{new Date(value).toLocaleString()}</span> },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      align: 'right',
      render: (_value, row) => (
        <Space size={2}>
          <Button size="small" type="link" autoInsertSpace={false} loading={downloading === row.key} disabled={Boolean(downloading) && downloading !== row.key}
            onClick={() => void download(row)}>下载</Button>
          <Button size="small" type="link" danger autoInsertSpace={false} onClick={() => remove(row)}>删除</Button>
        </Space>
      )
    }
  ]

  return (
    <>
      {info && (
        <Descriptions className="fb-team-server" size="small" bordered column={3} items={[
          { key: 'disk', label: '服务器磁盘', children: `剩余 ${formatBytes(info.diskFree)} / 共 ${formatBytes(info.diskTotal)}` },
          { key: 'data', label: '团队数据', children: `${formatBytes(info.dataSize - info.backupsSize)}（登录态 ${formatBytes(info.storageSize)}）` },
          { key: 'backups', label: '备份占用', children: formatBytes(info.backupsSize) },
          { key: 'members', label: '成员', children: `${info.members} 个` },
          { key: 'profiles', label: '云端窗口', children: `${info.profiles} 个` },
          { key: 'version', label: '服务端版本', children: <span className="fb-mono">PocketBase {info.version || '—'}</span> },
          { key: 'offsite', label: '异地备份', span: 3, children: <OffsiteStatus offsite={info.offsite} onEdit={() => setOffsiteOpen(true)} onRemove={removeOffsite} /> },
          {
            key: 'locks',
            label: '正在使用',
            span: 3,
            children: info.locks.length
              ? info.locks.map((lock) => `${lock.holder} · ${lock.profile}${lock.device ? `（${lock.device}）` : ''}`).join('；')
              : <span className="fb-muted">没有人在用</span>
          }
        ]} />
      )}
      <ListPage<BackupRow>
        toolbar={(
          <Space>
            <Button type="primary" icon={<DatabaseOutlined />} loading={creating} onClick={() => void backupNow()}>立即备份</Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>刷新</Button>
          </Space>
        )}
        columns={columns}
        rows={backups.map((backup) => ({ ...backup, id: backup.key }))}
        loading={loading}
        paginate={false}
        emptyText="还没有备份"
        footnote={(
          <>
            <CloudDownloadOutlined />{' '}
            {info?.autoBackup.cron
              ? `服务器${scheduleText(info.autoBackup.cron)}自动备份一次，保留最近 ${info.autoBackup.keep} 份；手动备份不会自动删除。`
              : '服务器没有开启自动备份。'}
            另外每次有改动（窗口关闭、改配置、改成员），1 分钟内会同步一份到 Cloudflare R2，保留 7 天。
            备份里有全部窗口的配置（含代理和平台账号密码）和登录态，下载后请妥善保管。
          </>
        )}
      />
      <OffsiteModal open={offsiteOpen} onClose={() => setOffsiteOpen(false)} onSaved={() => void reload()} />
    </>
  )
}

/** Team accounts: the owner manages members, shared windows and the log; members open their windows. */
export function TeamPage(_props: PageProps) {
  const ws = useWorkspace()
  const [status, setStatus] = useState<TeamStatus>()
  const [members, setMembers] = useState<TeamUser[]>([])
  const [profiles, setProfiles] = useState<TeamProfileView[]>([])
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState('profiles')
  const [passwordOpen, setPasswordOpen] = useState(false)
  const owner = status?.user?.role === 'owner'

  useEffect(() => {
    void window.browserApi.team.status().then(setStatus).catch((error) => ws.fail(error))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, [])

  async function reload(): Promise<void> {
    if (!status?.user) return
    setLoading(true)
    try {
      const [nextProfiles, nextMembers] = await Promise.all([
        window.browserApi.team.profiles(),
        owner ? window.browserApi.team.members() : Promise.resolve([])
      ])
      setProfiles(nextProfiles)
      setMembers(nextMembers)
    } catch (error) {
      ws.fail(error)
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the account changes
  useEffect(() => { void reload() }, [status?.user?.id])
  useEffect(() => window.browserApi.team.onSync((event) => {
    if (event.phase === 'done') void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the latest reload is fine
  }), [status?.user?.id])

  async function logout(): Promise<void> {
    try {
      await window.browserApi.team.logout()
      // The app is only used signed in: back to the sign-in page.
      window.location.reload()
    } catch (error) {
      ws.fail(error)
    }
  }

  if (!status) return null
  if (!status.user) return null

  const user = status.user
  return (
    <div className="fb-team">
      <div className="fb-team-head">
        <span>
          <strong>{displayName(user)}</strong>
          <Tag color={owner ? 'blue' : undefined}>{owner ? t("主账号") : t("成员")}</Tag>
          <span className="fb-muted">{user.username}</span>
        </span>
        <Space>
          <Button icon={<KeyOutlined />} onClick={() => setPasswordOpen(true)}>{t("修改密码")}</Button>
          <Button icon={<LogoutOutlined />} onClick={() => void logout()}>{t("退出登录")}</Button>
        </Space>
      </div>
      <PasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      {owner
        ? (
            <Tabs
              className="fb-tabs"
              activeKey={tab}
              onChange={setTab}
              items={[
                { key: 'profiles', label: t("云端窗口"), children: <ProfilesTab status={status} members={members} profiles={profiles} loading={loading} reload={() => void reload()} /> },
                { key: 'members', label: t("成员"), children: <MembersTab members={members} reload={() => void reload()} /> },
                { key: 'logs', label: t("日志"), children: <LogsTab members={members} profiles={profiles} /> },
                { key: 'server', label: '服务器', children: <ServerTab /> }
              ]}
            />
          )
        : <ProfilesTab status={status} members={members} profiles={profiles} loading={loading} reload={() => void reload()} />}
    </div>
  )
}
