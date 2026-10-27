import { LogoutOutlined, PlusOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons'
import { Button, Form, Input, Modal, Select, Space, Tabs, Tag, Tooltip, type TableColumnsType } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { t } from '../../../../shared/i18n'
import type { TeamLogEntry, TeamProfileView, TeamStatus, TeamUser } from '../../../../shared/team'
import { formatBytes } from '../../components/format'
import { ListPage } from '../../components/ListPage'
import { useWindowLauncher } from '../../data/window-actions'
import { useWorkspace } from '../../data/workspace'
import type { PageProps } from '../registry'

const ACTIONS: Record<string, string> = {
  setup: '创建主账号',
  login: '登录',
  open: '打开窗口',
  close: '关闭窗口',
  upload: '上传登录态',
  force_unlock: '强制释放',
  share: '新建云端窗口',
  update: '修改窗口',
  unshare: '删除云端窗口',
  member_create: '新建成员',
  member_update: '修改成员',
  member_delete: '删除成员'
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
    { title: t("状态"), key: 'disabled', width: 100, render: (_value, row) => row.disabled ? <Tag>{t("已停用")}</Tag> : <Tag color="green">{t("正常")}</Tag> },
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
        footnote={t("成员用自己的用户名和密码在指纹浏览器的「团队」里登录，只能看到分配给他的窗口。")}
      />
      <MemberFormModal open={formOpen} member={editing} onClose={() => setFormOpen(false)} onSaved={reload} />
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

  const localStatus = (profile: TeamProfileView) => ws.profiles.find((item) => item.id === profile.localId)?.status
  const ownerLabel = (profile: TeamProfileView) => profile.ownerId === me
    ? t("我")
    : memberNames.get(profile.ownerId) ?? (owner ? t("主账号") : t("主账号分配"))
  const columns: TableColumnsType<TeamProfileView> = [
    { title: t("窗口"), dataIndex: 'name', render: (value: string, row) => <><strong>{value}</strong>{row.note && <div className="fb-muted fb-ellipsis">{row.note}</div>}</> },
    { title: t("创建人"), key: 'owner', width: 110, render: (_value, row) => <span className="fb-muted">{ownerLabel(row)}</span> },
    ...(owner ? [{
      title: t("分配给"),
      key: 'assignees',
      render: (_value: unknown, row: TeamProfileView) => row.assignees.length
        ? row.assignees.map((id) => <Tag key={id}>{memberNames.get(id) ?? id}</Tag>)
        : <span className="fb-muted">{t("未分配")}</span>
    }] : []),
    {
      title: t("使用情况"),
      key: 'lock',
      width: 170,
      render: (_value, row) => row.lock
        ? <Tooltip title={row.lock.device ? t("设备：{0}", row.lock.device) : undefined}><Tag color="orange">{t("{0} 正在使用", row.lock.holderName)}</Tag></Tooltip>
        : <Tag>{t("空闲")}</Tag>
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
      width: 90,
      render: (_value, row) => row.localId
        ? <Tag color="green">{t("已在本机")}</Tag>
        : <Tag>{row.removedHere ? t("已从本机删除") : t("未添加")}</Tag>
    },
    {
      title: t("操作"),
      key: 'actions',
      width: owner ? 300 : 150,
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
        columns={columns}
        rows={profiles}
        loading={loading}
        emptyText={owner ? t("还没有云端窗口") : t("还没有你的窗口")}
        footnote={owner
          ? t("所有窗口都自动存到云端：新建后上传配置，关闭时上传登录状态，换电脑登录后自动出现。同一个窗口同一时间只能一个人打开。")
          : t("你自己建的窗口和分配给你的窗口都在这里。分配给你的窗口不能修改或导出。")}
      />
      <AssignModal open={Boolean(assigning)} profile={assigning} members={members} onClose={() => setAssigning(undefined)} onSaved={reload} />
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

/** Team accounts: the owner manages members, shared windows and the log; members open their windows. */
export function TeamPage(_props: PageProps) {
  const ws = useWorkspace()
  const [status, setStatus] = useState<TeamStatus>()
  const [members, setMembers] = useState<TeamUser[]>([])
  const [profiles, setProfiles] = useState<TeamProfileView[]>([])
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState('profiles')
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
          <span className="fb-muted fb-mono">{status.server}</span>
        </span>
        <Button icon={<LogoutOutlined />} onClick={() => void logout()}>{t("退出登录")}</Button>
      </div>
      {owner
        ? (
            <Tabs
              className="fb-tabs"
              activeKey={tab}
              onChange={setTab}
              items={[
                { key: 'profiles', label: t("云端窗口"), children: <ProfilesTab status={status} members={members} profiles={profiles} loading={loading} reload={() => void reload()} /> },
                { key: 'members', label: t("成员"), children: <MembersTab members={members} reload={() => void reload()} /> },
                { key: 'logs', label: t("日志"), children: <LogsTab members={members} profiles={profiles} /> }
              ]}
            />
          )
        : <ProfilesTab status={status} members={members} profiles={profiles} loading={loading} reload={() => void reload()} />}
    </div>
  )
}
