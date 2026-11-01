import { SearchOutlined } from '@ant-design/icons'
import { Checkbox, Input, Select } from 'antd'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { t } from '../../../shared/i18n'
import type { BrowserProfileView, GroupRecordView } from '../../../shared/types'

interface WindowPickerProps {
  windows: BrowserProfileView[]
  groups: GroupRecordView[]
  value: string[]
  onChange: (ids: string[]) => void
  /** Title and contents of the last column (e.g. the current proxy). */
  detailTitle: string
  detail: (window: BrowserProfileView, checked: boolean) => ReactNode
  /** An extra filter switch, e.g. "only windows without a proxy". */
  toggle?: { label: string; test: (window: BrowserProfileView) => boolean }
}

/** Search + group filter + a checklist of windows. Used wherever windows are picked for an assignment. */
export function WindowPicker({ windows, groups, value, onChange, detailTitle, detail, toggle }: WindowPickerProps) {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('__all__')
  const [onlyToggle, setOnlyToggle] = useState(false)
  const checked = new Set(value)
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return [...windows]
      .sort((a, b) => b.serialNumber - a.serialNumber)
      .filter((window) => group === '__all__' || window.groupId === group)
      .filter((window) => !onlyToggle || !toggle || toggle.test(window))
      .filter((window) => !normalized || window.name.toLowerCase().includes(normalized) || String(window.serialNumber).includes(normalized))
  }, [windows, query, group, onlyToggle, toggle])
  const allVisibleChecked = visible.length > 0 && visible.every((window) => checked.has(window.id))

  function toggleOne(id: string, on: boolean): void {
    onChange(on ? [...value, id] : value.filter((item) => item !== id))
  }

  function toggleVisible(on: boolean): void {
    const ids = new Set(visible.map((window) => window.id))
    onChange(on ? [...new Set([...value, ...ids])] : value.filter((id) => !ids.has(id)))
  }

  return (
    <div className="fb-picker">
      <div className="fb-picker-filters">
        <Input allowClear prefix={<SearchOutlined />} placeholder={t("搜索窗口名称 / 序号")} value={query} onChange={(event) => setQuery(event.target.value)} />
        <Select
          value={group}
          onChange={setGroup}
          aria-label={t("按分组筛选")}
          options={[{ value: '__all__', label: t("全部分组") }, { value: '', label: t("未分组") }, ...groups.map((item) => ({ value: item.id, label: item.name }))]}
        />
        {toggle && <Checkbox checked={onlyToggle} onChange={(event) => setOnlyToggle(event.target.checked)}>{toggle.label}</Checkbox>}
      </div>
      <div className="fb-picker-list" role="group" aria-label={t("选择窗口")}>
        <div className="fb-picker-head">
          <Checkbox checked={allVisibleChecked} indeterminate={!allVisibleChecked && visible.some((window) => checked.has(window.id))} onChange={(event) => toggleVisible(event.target.checked)} aria-label={t("全选")} />
          <span>{t("窗口")}</span>
          <span>{t("分组")}</span>
          <span>{detailTitle}</span>
        </div>
        {visible.map((window) => (
          <label key={window.id} className={`fb-picker-row${checked.has(window.id) ? ' is-checked' : ''}`}>
            <Checkbox checked={checked.has(window.id)} onChange={(event) => toggleOne(window.id, event.target.checked)} />
            <span className="fb-ellipsis"><strong>{window.name}</strong> <span className="fb-muted">#{window.serialNumber}</span></span>
            <span className="fb-ellipsis fb-muted">{window.group || t("未分组")}</span>
            <span className="fb-ellipsis">{detail(window, checked.has(window.id))}</span>
          </label>
        ))}
        {!visible.length && <div className="fb-picker-empty">{t("没有符合条件的窗口")}</div>}
      </div>
    </div>
  )
}
