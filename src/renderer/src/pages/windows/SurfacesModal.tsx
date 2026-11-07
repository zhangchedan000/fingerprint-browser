import { Alert, Modal, Radio, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { t } from '../../../../shared/i18n'

interface SurfacesModalProps {
  open: boolean
  count: number
  runningCount: number
  busy: boolean
  onSubmit: (real: boolean) => void
  onClose: () => void
}

/**
 * Canvas / AudioContext / ClientRects of the selected windows at once (11-07): this computer's real
 * values, as new windows have them, or each window its own (the noise).
 */
export function SurfacesModal({ open, count, runningCount, busy, onSubmit, onClose }: SurfacesModalProps) {
  const [real, setReal] = useState(true)
  useEffect(() => { if (open) setReal(true) }, [open])

  return (
    <Modal
      open={open}
      title={t("为 {0} 个窗口设置 Canvas、AudioContext、ClientRects", count)}
      okText={t("应用")}
      cancelText={t("取消")}
      confirmLoading={busy}
      onOk={() => onSubmit(real)}
      onCancel={onClose}
      destroyOnHidden
    >
      <Radio.Group value={real} onChange={(event) => setReal(event.target.value as boolean)}>
        <Space direction="vertical">
          <Radio value={true}>{t("本机真实（推荐）")}</Radio>
          <Radio value={false}>{t("每个窗口不同")}</Radio>
        </Space>
      </Radio.Group>
      <Typography.Paragraph type="secondary" className="fb-assign-extra">
        {t("本机真实：和真实 Chrome 读到的一样，新建窗口默认用这个。实测检测网站对加了噪音的窗口打分忽高忽低，用真实值稳定在低分；窗口之间靠显卡、CPU、屏幕等硬件和 IP 区分。字体和显卡的设置不变。")}
      </Typography.Paragraph>
      {runningCount > 0 && (
        <Alert type="warning" showIcon title={t("{0} 个窗口正在运行，关闭后重新打开才会生效", runningCount)} />
      )}
    </Modal>
  )
}
