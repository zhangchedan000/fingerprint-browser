import { Form, Input, Modal } from 'antd'
import { useEffect } from 'react'
import { t } from '../../../../shared/i18n'
import { GROUP_COLORS } from '../../../../shared/group-colors'
import type { GroupDraft, GroupRecordView } from '../../../../shared/types'

interface GroupFormModalProps {
  open: boolean
  /** Edit this group; create a new one when absent. */
  group?: GroupRecordView
  busy: boolean
  onSubmit: (draft: GroupDraft) => Promise<void>
  onClose: () => void
}

/** Create a group, or rename / recolour one. */
export function GroupFormModal({ open, group, busy, onSubmit, onClose }: GroupFormModalProps) {
  const [form] = Form.useForm<GroupDraft>()
  const color = Form.useWatch('color', form)
  useEffect(() => {
    if (!open) return
    form.resetFields()
    form.setFieldsValue(group ? { name: group.name, color: group.color, note: group.note } : { name: '', color: undefined, note: '' })
  }, [open, group, form])

  return (
    <Modal
      open={open}
      title={group ? t("重命名分组") : t("新建分组")}
      okText={t("保存")}
      cancelText={t("取消")}
      confirmLoading={busy}
      onOk={() => void form.validateFields().then((values) => onSubmit({ ...values, color: form.getFieldValue('color') }))}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label={t("分组名称")} rules={[{ required: true, whitespace: true, message: t("分组名称不能为空") }]}>
          <Input maxLength={40} placeholder={t("例如：TikTok 美区")} />
        </Form.Item>
        <Form.Item label={t("颜色")}>
          <div className="fb-swatches" role="radiogroup" aria-label={t("颜色")}>
            {GROUP_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                role="radio"
                aria-checked={color === swatch}
                aria-label={swatch}
                className={`fb-swatch${color === swatch ? ' is-active' : ''}`}
                style={{ background: swatch }}
                onClick={() => form.setFieldValue('color', swatch)}
              />
            ))}
          </div>
        </Form.Item>
        <Form.Item name="note" label={t("备注")}>
          <Input maxLength={200} placeholder={t("选填")} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
