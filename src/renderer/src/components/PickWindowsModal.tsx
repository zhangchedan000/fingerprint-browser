import { Modal } from 'antd'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import type { BrowserProfileView } from '../../../shared/types'
import { useWorkspace } from '../data/workspace'
import { WindowPicker } from './WindowPicker'

interface PickWindowsModalProps {
  open: boolean
  title: string
  /** Windows that can be picked. */
  windows: BrowserProfileView[]
  detailTitle: string
  detail: (window: BrowserProfileView) => ReactNode
  okText: string
  /** Windows ticked when the dialog opens (e.g. those that already have the extension). */
  initial?: string[]
  /** Allow submitting with nothing ticked (taking something off every window). */
  allowEmpty?: boolean
  busy: boolean
  onSubmit: (ids: string[]) => Promise<void> | void
  onClose: () => void
}

/** A dialog for ticking windows (move into a group, later: give to a member). */
export function PickWindowsModal({ open, title, windows, detailTitle, detail, okText, initial, allowEmpty, busy, onSubmit, onClose }: PickWindowsModalProps) {
  const ws = useWorkspace()
  const [picked, setPicked] = useState<string[]>([])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  useEffect(() => { if (open) setPicked(initial ?? []) }, [open])
  return (
    <Modal
      open={open}
      title={title}
      width={720}
      okText={okText}
      cancelText={t("取消")}
      okButtonProps={{ disabled: !picked.length && !allowEmpty }}
      confirmLoading={busy}
      onOk={() => void onSubmit(picked)}
      onCancel={onClose}
      destroyOnHidden
      footer={(_, { OkBtn, CancelBtn }) => (
        <div className="fb-modal-footer">
          <span className="fb-muted">{t("已选 {0} 个窗口", picked.length)}</span>
          <CancelBtn />
          <OkBtn />
        </div>
      )}
    >
      <WindowPicker windows={windows} groups={ws.groups} value={picked} onChange={setPicked} detailTitle={detailTitle} detail={detail} />
    </Modal>
  )
}
