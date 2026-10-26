import { GlobalOutlined } from '@ant-design/icons'
import { Select, Tooltip, message } from 'antd'
import { useState, useSyncExternalStore } from 'react'
import { getLocale, languages, setLocale, subscribeLocale, t, type UiLocale } from '../../../shared/i18n'

export function LanguageSelector() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale)
  const [saving, setSaving] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()
  async function change(value: UiLocale): Promise<void> {
    setSaving(true)
    try {
      await window.browserApi.uiLanguage.set(value)
      setLocale(value)
    } catch { messageApi.error(t('保存语言失败，请重试')) }
    finally { setSaving(false) }
  }
  return <>
    {contextHolder}
    <Tooltip title={t('仅改变软件界面，不会修改环境指纹语言或时区。')}>
      <Select
        className="language-selector"
        aria-label={t('界面语言')}
        prefix={<GlobalOutlined />}
        value={locale}
        options={[...languages]}
        onChange={value => void change(value)}
        loading={saving}
        disabled={saving}
        popupMatchSelectWidth={210}
        virtual={false}
      />
    </Tooltip>
  </>
}
