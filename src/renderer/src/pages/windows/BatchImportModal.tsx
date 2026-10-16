import { CheckCircleOutlined, CloudUploadOutlined } from '@ant-design/icons'
import { Button, Checkbox, Modal, Select, Spin, Steps, Table, Tag, Tooltip, Typography } from 'antd'
import type { DragEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { formatList, joinMessages, t, translateMessage as mt } from '../../../../shared/i18n'
import type { BatchImportPreview, BatchImportResult, BatchImportRowView, BrowserProfileView } from '../../../../shared/types'

interface BatchImportModalProps {
  open: boolean
  /** Groups already used by windows, offered as the default group. */
  groups: string[]
  onImported: (profiles: BrowserProfileView[]) => void
  onClose: () => void
  onError: (error: unknown) => void
  onNotice: (text: string) => void
}

function mostCommonGroup(rows: BatchImportRowView[]): string {
  const counts = new Map<string, number>()
  for (const row of rows) if (row.group && !row.errors.length) counts.set(row.group, (counts.get(row.group) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

export function BatchImportModal({ open, groups, onImported, onClose, onError, onNotice }: BatchImportModalProps) {
  const [preview, setPreview] = useState<BatchImportPreview | null>(null)
  const [result, setResult] = useState<BatchImportResult | null>(null)
  const [defaultGroup, setDefaultGroup] = useState('')
  const [reading, setReading] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!open) return
    setPreview(null)
    setResult(null)
    setDefaultGroup('')
    setDragging(false)
  }, [open])

  const step = result ? 2 : preview ? 1 : 0
  const groupOptions = useMemo(() => {
    const names = new Set(groups)
    for (const row of preview?.rows ?? []) if (row.group) names.add(row.group)
    return [{ value: '', label: t("未分组") }, ...[...names].sort().map((name) => ({ value: name, label: name }))]
  }, [groups, preview])

  async function read(path?: string): Promise<void> {
    setReading(true)
    try {
      const next = await window.browserApi.profiles.previewBatchImport(path)
      if (!next) return
      setPreview(next)
      setDefaultGroup(mostCommonGroup(next.rows))
    } catch (error) {
      onError(error)
    } finally {
      setReading(false)
    }
  }

  function onDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    const path = window.browserApi.profiles.pathForFile(file)
    if (!path) return onError(new Error('无法读取拖入的文件，请点击选择文件'))
    void read(path)
  }

  async function commit(): Promise<void> {
    if (!preview) return
    setCommitting(true)
    try {
      const next = await window.browserApi.profiles.commitBatchImport(preview.token, { defaultGroup })
      onImported(next.created)
      setResult(next)
    } catch (error) {
      onError(error)
    } finally {
      setCommitting(false)
    }
  }

  async function saveErrors(): Promise<void> {
    if (!preview) return
    try {
      const path = await window.browserApi.profiles.saveBatchImportErrors(preview.token)
      if (path) onNotice(t("错误行已保存"))
    } catch (error) {
      onError(error)
    }
  }

  async function saveTemplate(format: 'xlsx' | 'csv'): Promise<void> {
    try {
      const path = await window.browserApi.profiles.exportBatchTemplate(format)
      if (path) onNotice(t("导入模板已保存"))
    } catch (error) {
      onError(error)
    }
  }

  const columns = [
    { title: t("行"), dataIndex: 'line', width: 56, render: (line: number) => <span className="fb-muted">{line}</span> },
    { title: t("窗口名称"), dataIndex: 'name', width: 130, ellipsis: true, render: (name: string) => <strong>{name || '—'}</strong> },
    { title: t("分组"), dataIndex: 'group', width: 120, ellipsis: true, render: (group: string) => group || <span className="fb-muted">{t("（空）")}</span> },
    {
      title: t("代理"), dataIndex: 'proxy', width: 210, ellipsis: true,
      render: (proxy: string, row: BatchImportRowView) => proxy
        ? <span className="fb-mono">{proxy}</span>
        : row.errors.length ? '—' : <span className="fb-muted">{t("直连")}</span>
    },
    {
      title: t("平台账号"), dataIndex: 'account', width: 160, ellipsis: true,
      render: (account: string, row: BatchImportRowView) => (
        <>{account || '—'}{row.cookie && <Tag className="fb-import-cookie">Cookie</Tag>}</>
      )
    },
    {
      title: t("校验"), dataIndex: 'errors',
      render: (errors: string[]) => errors.length
        ? <Tooltip title={joinMessages(errors.map((error) => mt(error)))}><span className="fb-import-error">{joinMessages(errors.map((error) => mt(error)))}</span></Tooltip>
        : <span className="fb-import-ok">{t("通过")}</span>
    }
  ]

  const footer = step === 2
    ? [<Button key="view" type="primary" onClick={onClose}>{t("查看窗口")}</Button>]
    : [
        <Button key="cancel" onClick={onClose} disabled={committing}>{t("取消")}</Button>,
        ...(step === 1
          ? [<Button key="import" type="primary" loading={committing} disabled={!preview?.valid} onClick={() => void commit()}>
              {t("导入 {0} 个窗口", preview?.valid ?? 0)}
            </Button>]
          : [])
      ]

  return (
    <Modal
      open={open}
      title={t("批量导入窗口")}
      width={900}
      footer={footer}
      onCancel={committing ? undefined : onClose}
      maskClosable={false}
      destroyOnHidden
      className="fb-import"
    >
      <Steps
        size="small"
        current={step}
        className="fb-import-steps"
        items={[{ title: t("上传文件") }, { title: t("预览校验") }, { title: t("完成") }]}
      />

      {step === 0 && (
        <div className="fb-import-body">
          <div className="fb-import-hint">
            <span>{t("先下载模板，按列填写：窗口名称、分组、代理、平台账号、Cookie、备注")}</span>
            <Button type="link" size="small" onClick={() => void saveTemplate('xlsx')}>{t("下载 Excel 模板")}</Button>
            <Button type="link" size="small" onClick={() => void saveTemplate('csv')}>{t("下载 CSV 模板")}</Button>
          </div>
          <Spin spinning={reading}>
            <button
              type="button"
              className={`fb-import-drop${dragging ? ' is-dragging' : ''}`}
              onClick={() => void read()}
              onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <CloudUploadOutlined className="fb-import-drop-icon" />
              <strong>{t("点击选择文件，或拖到这里")}</strong>
              <span>{t("支持 .xlsx / .csv / .txt，单次最多 1000 行")}</span>
            </button>
          </Spin>
          <details className="fb-import-formats">
            <summary>{t("支持的代理写法")}</summary>
            <div className="fb-mono">host:port:user:pass<br />socks5://user:pass@host:port<br />http://host:port</div>
          </details>
        </div>
      )}

      {step === 1 && preview && (
        <div className="fb-import-body">
          <div className="fb-import-summary">
            <span>{t("文件")} <strong>{preview.fileName}</strong></span>
            <span className="fb-import-badge is-ok">{t("有效 {0} 行", preview.valid)}</span>
            {preview.invalid > 0 && <span className="fb-import-badge is-error">{t("错误 {0} 行（将跳过）", preview.invalid)}</span>}
            <Button type="link" size="small" className="fb-import-reselect" disabled={committing} onClick={() => setPreview(null)}>{t("重新选择文件")}</Button>
          </div>
          <Table<BatchImportRowView>
            size="small"
            rowKey="line"
            columns={columns}
            dataSource={preview.rows}
            pagination={preview.rows.length > 100 ? { pageSize: 100, showSizeChanger: false } : false}
            scroll={{ y: 300 }}
            rowClassName={(row) => row.errors.length ? 'fb-import-row-error' : ''}
          />
          <div className="fb-import-options">
            <label htmlFor="fb-import-group">{t("未填分组的导入到")}</label>
            <Select id="fb-import-group" value={defaultGroup} options={groupOptions} onChange={setDefaultGroup} style={{ maxWidth: 260 }} />
            <span>{t("指纹")}</span>
            <span>{t("每个窗口自动生成独立指纹，按代理 IP 匹配时区和语言")}</span>
            <span>{t("代理")}</span>
            <Tooltip title={t("代理池功能完成后可用")}>
              <Checkbox disabled>{t("同时把新代理加入代理池（已存在的不重复添加）")}</Checkbox>
            </Tooltip>
          </div>
        </div>
      )}

      {step === 2 && result && (
        <div className="fb-import-done">
          <CheckCircleOutlined className="fb-import-done-icon" />
          <strong>{t("已导入 {0} 个窗口", result.created.length)}</strong>
          {result.skipped > 0 && <span>{t("跳过 {0} 行错误数据", result.skipped)}</span>}
          {result.cookiesImported > 0 && <span>{t("已写入 {0} 条 Cookie", result.cookiesImported)}</span>}
          {result.cookieErrors.length > 0 && (
            <Typography.Text type="warning">
              {t("{0} 个窗口的 Cookie 未能写入，可在窗口编辑里重新导入：{1}", result.cookieErrors.length, formatList(result.cookieErrors.map((item) => item.name)))}
            </Typography.Text>
          )}
          {result.skipped > 0 && <Button type="link" onClick={() => void saveErrors()}>{t("下载错误行，修改后重新导入")}</Button>}
        </div>
      )}
    </Modal>
  )
}
