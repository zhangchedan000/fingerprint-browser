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

/** The coloured state dot in front of a window name. With onOpen, an error dot opens its details. */
export function StatusDot({ status, error, onOpen }: { status: ProfileStatus; error?: string; onOpen?: () => void }) {
  const label = statusLabel(status)
  const openable = Boolean(onOpen) && (status === 'error' || status === 'orphaned')
  const text = error ? `${label} · ${mt(error)}` : label
  return (
    <Tooltip title={openable ? <>{text}<br />{t("点击查看详情和日志")}</> : text}>
      {openable ? (
        <button type="button" className={`fb-status-dot ${status} openable`} aria-label={`${label} · ${t("点击查看详情和日志")}`} onClick={(event) => { event.stopPropagation(); onOpen?.() }} />
      ) : (
        <span className={`fb-status-dot ${status}`} role="img" aria-label={label} />
      )}
    </Tooltip>
  )
}
