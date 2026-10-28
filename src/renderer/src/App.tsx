import { PoweroffOutlined } from '@ant-design/icons'
import { Button, Layout, Space } from 'antd'
import { useState } from 'react'
import { t } from '../../shared/i18n'
import { LoginGate } from './components/LoginGate'
import { Sidebar } from './components/Sidebar'
import { useWorkspace, WorkspaceProvider } from './data/workspace'
import { useTeamSyncNotices } from './data/team-sync'
import { useScrollMemory } from './components/scroll-memory'
import { pageDefinition, type PageKey, type PageParams } from './pages/registry'

const pageBody = () => document.querySelector<HTMLElement>('.fb-content')

/** The app shell: side menu, top bar and the current page, all driven by pages/registry. */
function Shell() {
  const ws = useWorkspace()
  const [active, setActive] = useState<PageKey>('windows')
  const [params, setParams] = useState<PageParams | undefined>()
  const page = pageDefinition(active)
  const Page = page.page

  useTeamSyncNotices()
  // Every page opens where it was left, until the app is restarted.
  useScrollMemory(pageBody, `page:${active}:${JSON.stringify(params ?? {})}`)

  function navigate(key: PageKey, next?: PageParams): void {
    const target = pageDefinition(key)
    if (target.upcoming) return
    setActive(key)
    setParams(next)
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
            {running > 0 && (
              <Button danger icon={<PoweroffOutlined />} onClick={() => void window.browserApi.profiles.closeAll()}>{t("全部关闭")}</Button>
            )}
          </Space>
        </header>
        <Layout.Content className="fb-content">
          {Page && <Page key={`${active}:${JSON.stringify(params ?? {})}`} navigate={navigate} params={params} />}
        </Layout.Content>
      </Layout>
    </Layout>
  )
}

export default function App() {
  return (
    <LoginGate>
      <WorkspaceProvider>
        <Shell />
      </WorkspaceProvider>
    </LoginGate>
  )
}
