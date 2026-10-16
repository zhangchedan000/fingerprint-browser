import React, { useEffect, useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom/client'
import zhCN from 'antd/locale/zh_CN'
import zhTW from 'antd/locale/zh_TW'
import en from 'antd/locale/en_US'
import ru from 'antd/locale/ru_RU'
import vi from 'antd/locale/vi_VN'
import th from 'antd/locale/th_TH'
import ptBR from 'antd/locale/pt_BR'
import fr from 'antd/locale/fr_FR'
import uk from 'antd/locale/uk_UA'
import es from 'antd/locale/es_ES'
import tr from 'antd/locale/tr_TR'
import ja from 'antd/locale/ja_JP'
import hi from 'antd/locale/hi_IN'
import { getLocale, resolveLocale, setLocale, subscribeLocale } from '../../shared/i18n'
import App from './App'
import { applyTheme, DEFAULT_THEME, ThemeProvider } from './theme'
import './styles.css'

const ANTD_LOCALES = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, ru, vi, th, 'pt-BR': ptBR, fr, uk, es, tr, ja, hi }

function PrismApplication() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale)
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  return (
    <ThemeProvider locale={ANTD_LOCALES[locale]}>
      <App />
    </ThemeProvider>
  )
}

async function mount(): Promise<void> {
  const selected = await window.browserApi.uiLanguage.get().catch(() => 'en')
  setLocale(resolveLocale(selected))
  document.documentElement.lang = getLocale()
  applyTheme(DEFAULT_THEME)
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><PrismApplication /></React.StrictMode>)
}
void mount()
