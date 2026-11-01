import { Modal, Select, Typography } from 'antd'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'

export interface AssignOption {
  value: string
  label: ReactNode
  /** Text the search box matches. */
  search: string
}

interface AssignModalProps {
  open: boolean
  title: string
  description?: ReactNode
  /** What to pick from: a library (proxies, groups, later members). */
  options: AssignOption[]
  /** The "none" choice ('' value): direct connection, ungrouped… Leave out when none is not allowed. */
  noneLabel?: string
  placeholder: string
  /** Lets the person type a name that is not in the library yet; returns the new record's id. */
  onCreate?: (name: string) => Promise<string>
  createLabel?: (name: string) => string
  /** Shown under the picker for the chosen value (e.g. a sharing warning). */
  notice?: (value: string) => ReactNode
  /** Extra fields of a particular assignment. */
  children?: ReactNode
  busy: boolean
  onSubmit: (value: string) => Promise<void> | void
  onClose: () => void
}

/**
 * The one dialog for pointing records at a library record: windows to a proxy, windows to
 * a group, and later windows to members. Each use only passes its options.
 */
export function AssignModal({
  open, title, description, options, noneLabel, placeholder, onCreate, createLabel, notice, children, busy, onSubmit, onClose
}: AssignModalProps) {
  const [value, setValue] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    if (!open) return
    setValue(undefined)
    setSearch('')
  }, [open])

  const typed = search.trim()
  const canCreate = Boolean(onCreate && typed && !options.some((option) => option.search.split('\n')[0] === typed))
  const items = [
    ...(noneLabel ? [{ value: '', label: noneLabel, search: noneLabel }] : []),
    ...options,
    ...(canCreate ? [{ value: `__create__${typed}`, label: createLabel?.(typed) ?? typed, search: typed }] : [])
  ]

  async function choose(next: string): Promise<void> {
    if (!next.startsWith('__create__') || !onCreate) {
      setValue(next)
      return
    }
    setCreating(true)
    try {
      setValue(await onCreate(next.slice('__create__'.length)))
      setSearch('')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      okText={t("应用")}
      cancelText={t("取消")}
      confirmLoading={busy}
      okButtonProps={{ disabled: value === undefined }}
      onOk={() => { if (value !== undefined) void onSubmit(value) }}
      onCancel={onClose}
      destroyOnHidden
    >
      {description && <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>}
      <Select
        showSearch
        className="full-width"
        value={value}
        loading={creating}
        placeholder={placeholder}
        searchValue={search}
        onSearch={setSearch}
        optionFilterProp="search"
        onChange={(next) => void choose(next)}
        options={items}
      />
      {value !== undefined && notice?.(value)}
      {children}
    </Modal>
  )
}
