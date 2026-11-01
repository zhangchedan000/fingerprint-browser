import { t, getLocale, translateMessage as mt } from '../../../../shared/i18n'
import { CheckCircleFilled, CloseCircleFilled, WarningFilled } from '@ant-design/icons'
import { Alert, List, Modal, Space, Tag, Typography } from 'antd'
import type { BrowserProfileView, LaunchDiagnosticReport } from '../../../../shared/types'

interface LaunchDiagnosticsModalProps {
  profile?: BrowserProfileView
  report?: LaunchDiagnosticReport
  open: boolean
  onClose: () => void
}


export function LaunchDiagnosticsModal({ profile, report, open, onClose }: LaunchDiagnosticsModalProps) {
  const statusView = {
    pass: { color: 'success', text: t("通过"), icon: <CheckCircleFilled /> },
    warning: { color: 'warning', text: t("提醒"), icon: <WarningFilled /> },
    error: { color: 'error', text: t("失败"), icon: <CloseCircleFilled /> }
  } as const

  return (
    <Modal open={open} title={t("启动诊断{0}", profile ? ` · ${profile.name}` : '')} footer={null} onCancel={onClose} destroyOnHidden>
      {report && (
        <>
          <Alert
            type={report.ready ? 'success' : 'error'}
            showIcon
            title={report.ready ? t("未发现阻止启动的问题") : t("发现可能导致启动失败的问题")}
            description={report.ready ? t("提醒项不会阻止启动，但建议在正式业务使用前处理。") : t("请处理失败项后重新诊断。")}
          />
          <List
            className="diagnostics-list"
            dataSource={report.checks}
            renderItem={(check) => {
              const view = statusView[check.status]
              return (
                <List.Item>
                  <List.Item.Meta
                    title={<Space><Tag color={view.color} icon={view.icon}>{view.text}</Tag><Typography.Text strong>{mt(check.label)}</Typography.Text></Space>}
                    description={mt(check.message)}
                  />
                </List.Item>
              )
            }}
          />
          <Typography.Text type="secondary">{t("检查时间：{0}", new Date(report.checkedAt).toLocaleString(getLocale()))}</Typography.Text>
        </>
      )}
    </Modal>
  )
}
