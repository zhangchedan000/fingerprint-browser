import { kernelName } from '../../../../shared/kernel-id'
import { t, getLocale, translateMessage as mt } from '../../../../shared/i18n'
import { useEffect, useState } from 'react'
import { Alert, Button, Collapse, Empty, Modal, Space, Spin, Tag, Typography, message as antdMessage } from 'antd'
import { CopyOutlined, FolderOpenOutlined } from '@ant-design/icons'
import type { BrowserCrashRecord, BrowserLaunchLog, BrowserProfileView } from '../../../../shared/types'
import { explainExit } from '../../../../shared/exit-codes'

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

/** Error state of a window: why the kernel stopped, with its log, launch arguments and dumps. */
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
  const newestFirst = [...records].reverse()
  return (
    <Modal
      open={open}
      width={880}
      title={t("异常详情{0}", profile ? ` · ${profile.name}` : '')}
      onCancel={onClose}
      destroyOnHidden
      footer={(
        <Space>
          {profile && (
            <Button icon={<FolderOpenOutlined />} onClick={() => void window.browserApi.profiles.openLaunchLogFolder(profile.id)}>
              {t("打开日志文件夹")}
            </Button>
          )}
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
          style={{ marginBottom: 12 }}
        />
      )}
      <Spin spinning={loading}>
        {newestFirst.length && profile ? (
          <Collapse
            defaultActiveKey={[newestFirst[0].occurredAt]}
            items={newestFirst.map((record) => {
              const exit = explainExit(record.code, record.signal)
              return {
                key: record.occurredAt,
                label: (
                  <Space wrap size={8}>
                    <Tag color="error">{record.phase === 'starting' ? t("启动阶段") : t("运行阶段")}</Tag>
                    <Typography.Text>{new Date(record.occurredAt).toLocaleString(getLocale())}</Typography.Text>
                    <Typography.Text strong>{t(exit.title)}</Typography.Text>
                    <Typography.Text type="secondary" className="fb-crash-code">{exit.code}</Typography.Text>
                  </Space>
                ),
                children: <CrashDetail profileId={profile.id} record={record} />
              }
            })}
          />
        ) : !loading ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("没有浏览器崩溃记录")} /> : null}
      </Spin>
    </Modal>
  )
}

function CrashDetail({ profileId, record }: { profileId: string; record: BrowserCrashRecord }) {
  const [message, messageHolder] = antdMessage.useMessage()
  const [log, setLog] = useState<BrowserLaunchLog>()
  const [loadingLog, setLoadingLog] = useState(false)
  const [showArgs, setShowArgs] = useState(false)
  const exit = explainExit(record.code, record.signal)

  useEffect(() => { setLog(undefined) }, [record.logFile])

  async function loadLog(): Promise<void> {
    if (!record.logFile) return
    setLoadingLog(true)
    try {
      setLog(await window.browserApi.profiles.readLaunchLog(profileId, record.logFile))
    } catch (error) {
      message.error(mt(error instanceof Error ? error.message : String(error)))
    } finally {
      setLoadingLog(false)
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      message.success(t("已复制"))
    } catch {
      message.error(t("复制失败"))
    }
  }

  const tail = record.logTail?.join('\n') ?? ''
  const shownLog = log ? log.text : tail
  const report = [
    `${t("退出代码")}: ${exit.code} · ${t(exit.title)}`,
    record.kernelVersion ? `${t("内核")}: ${kernelName(record.kernelVersion)}` : '',
    record.reason ? `${t("崩溃原因")}: ${record.reason}` : '',
    record.args?.length ? `${t("启动参数")}:\n${record.args.join('\n')}` : '',
    shownLog ? `${t("日志")}:\n${shownLog}` : ''
  ].filter(Boolean).join('\n\n')

  return (
    <div>
      {messageHolder}
      <dl className="fb-crash-fields">
        <dt>{t("退出代码")}</dt>
        <dd>
          <Typography.Text className="fb-crash-code">{exit.code}</Typography.Text>
          {' · '}{t(exit.title)}
          <div><Typography.Text type="secondary">{t(exit.hint)}</Typography.Text></div>
        </dd>
        {record.kernelVersion && (<><dt>{t("内核")}</dt><dd>{kernelName(record.kernelVersion)}</dd></>)}
        <dt>{t("崩溃原因")}</dt>
        <dd>
          {record.reason
            ? <pre className="fb-crash-reason">{record.reason}</pre>
            : <Typography.Text type="secondary">{record.logFile ? t("日志里没有明确的崩溃原因，看下面的日志最后几行") : t("这条记录早于日志功能，没有日志")}</Typography.Text>}
        </dd>
        {record.dumps?.length ? (
          <>
            <dt>{t("崩溃转储")}</dt>
            <dd>{record.dumps.map((dump) => <div key={dump}><Typography.Text className="fb-crash-code" copyable>{dump}</Typography.Text></div>)}</dd>
          </>
        ) : null}
        {record.args?.length ? (
          <>
            <dt>{t("启动参数")}</dt>
            <dd>
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setShowArgs((value) => !value)}>
                {showArgs ? t("收起") : t("展开 {0} 个参数", record.args.length)}
              </Button>
              {showArgs && <pre className="fb-crash-log">{record.args.join('\n')}</pre>}
            </dd>
          </>
        ) : null}
      </dl>

      {record.logFile && (
        <>
          <Space wrap style={{ marginBottom: 8 }}>
            <Typography.Text strong>{log ? t("完整日志") : t("日志最后 {0} 行", record.logTail?.length ?? 0)}</Typography.Text>
            {!log && <Button size="small" loading={loadingLog} onClick={() => void loadLog()}>{t("查看完整日志")}</Button>}
            <Button size="small" icon={<CopyOutlined />} onClick={() => void copy(report)}>{t("复制全部信息")}</Button>
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void window.browserApi.profiles.openLaunchLogFolder(profileId, record.logFile)}>{t("打开日志文件")}</Button>
          </Space>
          {log?.truncated && <Typography.Paragraph type="secondary">{t("日志较大，只显示最后一部分")}</Typography.Paragraph>}
          {shownLog
            ? <pre className="fb-crash-log">{shownLog}</pre>
            : <Typography.Text type="secondary">{t("内核没有写出日志")}</Typography.Text>}
        </>
      )}
    </div>
  )
}
