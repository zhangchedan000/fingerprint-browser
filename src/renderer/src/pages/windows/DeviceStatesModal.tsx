import { useEffect, useState } from 'react'
import { Alert, Button, Empty, Modal, Spin, Table, Tag } from 'antd'
import { getLocale, t } from '../../../../shared/i18n'
import type { TeamDeviceStateView } from '../../../../shared/team'
import type { BrowserProfileView } from '../../../../shared/types'
import { formatBytes, humanError, isEditable, shortDateTime } from '../../components/format'

interface DeviceStatesModalProps {
  profile?: BrowserProfileView
  onClose: () => void
  onRestored: () => void
}

/**
 * The cloud copies of a window's login state, one per computer it was used on (this account's;
 * the owner sees everyone's). Picking one puts it into the window on this computer.
 */
export function DeviceStatesModal({ profile, onClose, onRestored }: DeviceStatesModalProps) {
  const [states, setStates] = useState<TeamDeviceStateView[]>()
  const [error, setError] = useState('')
  const [restoring, setRestoring] = useState('')

  useEffect(() => {
    if (!profile) return
    let current = true
    setStates(undefined)
    setError('')
    window.browserApi.team.deviceStates(profile.id)
      .then((items) => { if (current) setStates(items) })
      .catch((reason) => { if (current) setError(humanError(reason)) })
    return () => { current = false }
  }, [profile])

  function restore(state: TeamDeviceStateView): void {
    if (!profile) return
    Modal.confirm({
      title: t("用“{0}”的备份替换这个窗口在本机的登录状态？", state.deviceName),
      content: t("本机这个窗口现在的登录状态会被替换。之后正常关闭窗口时，会作为本机的备份上传。"),
      okText: t("恢复"),
      cancelText: t("取消"),
      onOk: async () => {
        setRestoring(state.id)
        try {
          await window.browserApi.team.restoreDeviceState(profile.id, state.id)
          onRestored()
        } catch (reason) {
          setError(humanError(reason))
        } finally {
          setRestoring('')
        }
      }
    })
  }

  const closed = profile ? isEditable(profile) : false
  return (
    <Modal
      open={Boolean(profile)}
      width={720}
      title={t("恢复其他电脑的备份{0}", profile ? ` · ${profile.name}` : '')}
      onCancel={onClose}
      destroyOnHidden
      footer={<Button onClick={onClose}>{t("关闭")}</Button>}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t("同一个账号在几台电脑上用这个窗口时，每台电脑各存一份登录状态，互不覆盖。这里可以把另一台电脑的那份拿到本机。")}
      />
      {!closed && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t("请先关闭这个窗口")} />}
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      {!states && !error && <Spin />}
      {states && states.length === 0 && <Empty description={t("云端还没有按电脑存的备份（正常关闭一次窗口后就会有）")} />}
      {states && states.length > 0 && (
        <Table<TeamDeviceStateView>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={states}
          columns={[
            {
              title: t("电脑"),
              dataIndex: 'deviceName',
              render: (name: string, state) => (
                <span>
                  {name}
                  {state.thisComputer && <Tag color="blue" style={{ marginLeft: 8 }}>{t("本机")}</Tag>}
                </span>
              )
            },
            { title: t("账号"), dataIndex: 'userName' },
            { title: t("最后备份"), dataIndex: 'updated', render: (value: string) => shortDateTime(value, getLocale()) },
            { title: t("大小"), dataIndex: 'size', render: (size: number) => formatBytes(size) },
            {
              title: '',
              key: 'restore',
              render: (_value, state) => (
                <Button size="small" disabled={!closed || Boolean(restoring)} loading={restoring === state.id} onClick={() => restore(state)}>
                  {t("恢复")}
                </Button>
              )
            }
          ]}
        />
      )}
    </Modal>
  )
}
