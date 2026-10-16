import { PoweroffOutlined } from '@ant-design/icons'
import { Button, Layout, Space } from 'antd'
import { useState } from 'react'
import { t } from '../../shared/i18n'
import { LanguageSelector } from './components/LanguageSelector'
import { Sidebar } from './components/Sidebar'
import { useWorkspace, WorkspaceProvider } from './data/workspace'
import { PAGES, pageDefinition, type PageKey } from './pages/registry'

/** The app shell: side menu, top bar and the current page, all driven by pages/registry. */
function Shell() {
  const ws = useWorkspace()
  const [active, setActive] = useState<PageKey>('windows')
  const [dialog, setDialog] = useState<PageKey | null>(null)
  const page = pageDefinition(active)
  const Page = page.page

  function navigate(key: PageKey): void {
    const target = pageDefinition(key)
    if (target.upcoming) return
    if (target.dialog) setDialog(key)
    else setActive(key)
  }

  const running = ws.profiles.filter((profile) => profile.status === 'running' || profile.status === 'orphaned').length
  return (
    <Layout className="app-shell" hasSider>
      <Sidebar active={active} onNavigate={navigate} />
      <Layout>
        <header className="fb-topbar">
          <h1>{page.label()}</h1>
          {page.subtitle && <span className="fb-muted">{page.subtitle(ws)}</span>}
          <Space className="fb-topbar-actions">
            <LanguageSelector />
            {running > 0 && (
              <Button danger icon={<PoweroffOutlined />} onClick={() => void window.browserApi.profiles.closeAll()}>{t("全部关闭")}</Button>
            )}
          </Space>
        </header>
        <Layout.Content className="fb-content">
          {Page && <Page navigate={navigate} />}
        </Layout.Content>
      </Layout>
      {PAGES.filter((item) => item.dialog).map((item) => {
        const Dialog = item.dialog!
        return <Dialog key={item.key} open={dialog === item.key} onClose={() => setDialog(null)} />
      })}
    </Layout>
  )
}

export default function App() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  )
}
