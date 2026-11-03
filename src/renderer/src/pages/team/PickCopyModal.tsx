import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Table } from 'antd'
import { getLocale, t } from '../../../../shared/i18n'
import type { TeamDeviceStateView } from '../../../../shared/team'
import { DeviceCopyComputer } from '../../components/DeviceCopyComputer'
import { formatBytes, shortDateTime } from '../../components/format'

export interface PickCopyRequest {
  name: string
  states: TeamDeviceStateView[]
  /** The chosen copy's id, or null when the user cancels (nothing is added). */
  resolve: (stateId: string | null) => void
}

/**
 * Adding a cloud window that this computer had before: which computer's login state goes into it here
 * (this computer's own copy is chosen first). A computer that never had the window gets the latest
 * copy without asking.
 */
export function PickCopyModal({ request, onClose }: { request?: PickCopyRequest; onClose: () => void }) {
  const [chosen, setChosen] = useState<string>()

  useEffect(() => {
    setChosen(request?.states.find((state) => state.thisComputer)?.id ?? request?.states[0]?.id)
  }, [request])

  function finish(stateId: string | null): void {
    request?.resolve(stateId)
    onClose()
  }

  return (
    <Modal
      open={Boolean(request)}
      width={720}
      title={t("用哪台电脑的登录状态{0}", request ? ` · ${request.name}` : '')}
      maskClosable={false}
      onCancel={() => finish(null)}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={() => finish(null)}>{t("取消")}</Button>,
        <Button key="ok" type="primary" disabled={!chosen} onClick={() => finish(chosen ?? null)}>{t("添加到本机")}</Button>
      ]}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t("这台电脑以前用过这个窗口，云端存着它的备份。选一份放进本机这个窗口，之后打开就用它；别的电脑那份不受影响。")}
      />
      <Table<TeamDeviceStateView>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={request?.states ?? []}
        rowSelection={{ type: 'radio', selectedRowKeys: chosen ? [chosen] : [], onChange: (keys) => setChosen(String(keys[0])) }}
        onRow={(state) => ({ onClick: () => setChosen(state.id) })}
        columns={[
          {
            title: t("电脑"),
            dataIndex: 'deviceName',
            render: (_name: string, state) => <DeviceCopyComputer state={state} states={request?.states ?? []} />
          },
          { title: t("账号"), dataIndex: 'userName' },
          { title: t("最后备份"), dataIndex: 'updated', render: (value: string) => shortDateTime(value, getLocale()) },
          { title: t("大小"), dataIndex: 'size', render: (size: number) => formatBytes(size) }
        ]}
      />
    </Modal>
  )
}
