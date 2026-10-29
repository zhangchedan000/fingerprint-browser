import { Alert, Modal, Select, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { t } from '../../../../shared/i18n'
import type { EngineStatus, KernelRelease } from '../../../../shared/types'
import { kernelName } from '../../../../shared/kernel-id'

/** '' means "follow the default kernel". */
export const FOLLOW_DEFAULT_KERNEL = ''

interface KernelSwitchModalProps {
  open: boolean
  count: number
  runningCount: number
  kernels: KernelRelease[]
  engine: EngineStatus | null
  busy: boolean
  onSubmit: (kernelVersion: string) => void
  onClose: () => void
}

export function KernelSwitchModal({ open, count, runningCount, kernels, engine, busy, onSubmit, onClose }: KernelSwitchModalProps) {
  const [version, setVersion] = useState<string>(FOLLOW_DEFAULT_KERNEL)
  useEffect(() => { if (open) setVersion(FOLLOW_DEFAULT_KERNEL) }, [open])

  const options = [
    {
      value: FOLLOW_DEFAULT_KERNEL,
      label: engine?.version ? t("跟随默认内核（{0}）", kernelName(engine.version)) : t("跟随默认内核")
    },
    ...kernels
      .filter((kernel) => kernel.installed && kernel.executable)
      .map((kernel, _index, ready) => ({ value: kernel.version, label: kernelName(kernel.version, ready.map((item) => item.version)) }))
  ]

  return (
    <Modal
      open={open}
      title={t("为 {0} 个窗口切换内核", count)}
      okText={t("应用")}
      cancelText={t("取消")}
      confirmLoading={busy}
      onOk={() => onSubmit(version)}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">{t("指定内核后，窗口固定使用该版本；选择跟随默认内核则使用内核管理中的默认版本。")}</Typography.Paragraph>
      <Select className="full-width" value={version} options={options} onChange={setVersion} aria-label={t("目标内核")} />
      {runningCount > 0 && (
        <Alert
          className="kernel-switch-note"
          type="warning"
          showIcon
          title={t("{0} 个窗口正在运行，关闭后重新打开才会使用新内核", runningCount)}
        />
      )}
    </Modal>
  )
}
