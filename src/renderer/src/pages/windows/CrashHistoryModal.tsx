import { t, getLocale, translateMessage as mt } from '../../../../shared/i18n'
import { Alert, Button, Empty, List, Modal, Space, Spin, Tag, Typography } from 'antd'
import type { BrowserCrashRecord, BrowserProfileView } from '../../../../shared/types'

interface CrashHistoryModalProps {
  open: boolean
  profile?: BrowserProfileView
  records: BrowserCrashRecord[]
  loading: boolean
  recovering: boolean
  onClose: () => void
  onRecover: () => void
  onDiagnose: () => void
}

export function CrashHistoryModal({
  open,
  profile,
  records,
  loading,
  recovering,
  onClose,
  onRecover,
  onDiagnose
}: CrashHistoryModalProps) {
  const recoverable = profile?.status === 'error' || profile?.status === 'orphaned'
  return (
    <Modal
      open={open}
      title={t("异常与恢复{0}", profile ? ` · ${profile.name}` : '')}
      onCancel={onClose}
      destroyOnHidden
      footer={(
        <Space>
          <Button onClick={onDiagnose} disabled={!profile}>{t("启动诊断")}</Button>
          {recoverable && (
            <Button type="primary" danger={profile?.status === 'orphaned'} loading={recovering} onClick={onRecover}>
              {profile?.status === 'orphaned' ? t("结束遗留进程") : t("重新启动环境")}
            </Button>
          )}
          <Button onClick={onClose}>{t("关闭")}</Button>
        </Space>
      )}
    >
      {profile?.lastError && (
        <Alert
          type={profile.status === 'orphaned' ? 'warning' : 'error'}
          showIcon
          title={t("最近异常状态")}
          description={mt(profile.lastError)}
        />
      )}
      <Spin spinning={loading}>
        {records.length ? (
          <List
            dataSource={[...records].reverse()}
            renderItem={(record) => (
              <List.Item>
                <List.Item.Meta
                  title={(
                    <Space>
                      <Tag color="error">{record.phase === 'starting' ? t("启动阶段") : t("运行阶段")}</Tag>
                      <Typography.Text>{new Date(record.occurredAt).toLocaleString(getLocale())}</Typography.Text>
                    </Space>
                  )}
                />
              </List.Item>
            )}
          />
        ) : !loading ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("没有浏览器崩溃记录")} /> : null}
      </Spin>
    </Modal>
  )
}
