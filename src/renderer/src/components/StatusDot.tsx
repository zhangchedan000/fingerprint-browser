import { Tooltip } from 'antd'
import { t, translateMessage as mt } from '../../../shared/i18n'
import type { ProfileStatus } from '../../../shared/types'

export function statusLabel(status: ProfileStatus): string {
  return {
    closed: t("未运行"),
    starting: t("启动中"),
    running: t("运行中"),
    stopping: t("关闭中"),
    orphaned: t("进程遗留"),
    error: t("异常")
  }[status]
}

/** The coloured state dot in front of a window name. */
export function StatusDot({ status, error }: { status: ProfileStatus; error?: string }) {
  const label = statusLabel(status)
  return (
    <Tooltip title={error ? `${label} · ${mt(error)}` : label}>
      <span className={`fb-status-dot ${status}`} role="img" aria-label={label} />
    </Tooltip>
  )
}
