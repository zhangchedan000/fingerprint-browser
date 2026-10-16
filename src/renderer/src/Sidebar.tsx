import {
  AppstoreAddOutlined,
  AppstoreOutlined,
  ClusterOutlined,
  DeploymentUnitOutlined,
  FolderOutlined,
  RestOutlined,
  SettingOutlined
} from '@ant-design/icons'
import { Tooltip } from 'antd'
import type { ReactNode } from 'react'
import { t, translateMessage as mt } from '../../shared/i18n'
import type { EngineStatus } from '../../shared/types'

export type SidebarTarget = 'windows' | 'groups' | 'proxies' | 'extensions' | 'kernels' | 'recycle' | 'settings'

interface NavItem {
  key: SidebarTarget
  icon: ReactNode
  label: string
  count?: number
  /** Planned page that is not built yet in the local edition. */
  upcoming?: boolean
}

interface SidebarProps {
  active: SidebarTarget
  windowCount: number
  extensionCount: number
  engine: EngineStatus | null
  onNavigate: (target: SidebarTarget) => void
}

export function Sidebar({ active, windowCount, extensionCount, engine, onNavigate }: SidebarProps) {
  const sections: Array<{ title: string; items: NavItem[] }> = [
    {
      title: t("工作区"),
      items: [
        { key: 'windows', icon: <AppstoreOutlined />, label: t("窗口管理"), count: windowCount },
        { key: 'groups', icon: <FolderOutlined />, label: t("分组管理"), upcoming: true },
        { key: 'proxies', icon: <ClusterOutlined />, label: t("代理 IP"), upcoming: true }
      ]
    },
    {
      title: t("工具"),
      items: [
        { key: 'extensions', icon: <AppstoreAddOutlined />, label: t("扩展中心"), count: extensionCount || undefined },
        { key: 'kernels', icon: <DeploymentUnitOutlined />, label: t("内核管理") },
        { key: 'recycle', icon: <RestOutlined />, label: t("回收站") }
      ]
    },
    {
      title: t("系统"),
      items: [{ key: 'settings', icon: <SettingOutlined />, label: t("设置"), upcoming: true }]
    }
  ]

  return (
    <nav className="fb-sidebar" aria-label={t("主导航")}>
      <div className="fb-brand">
        <span className="fb-brand-mark" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12 4a8 8 0 0 0-8 8M12 8a4 4 0 0 0-4 4v2M20 12a8 8 0 0 0-3-6.2M16 12v1a8 8 0 0 1-2 5.3M12 12v2a4 4 0 0 1-1.5 3.1" />
          </svg>
        </span>
        <span>
          <strong>{t("指纹浏览器")}</strong>
          <small>v{__APP_VERSION__}</small>
        </span>
      </div>
      {sections.map((section) => (
        <div key={section.title} className="fb-nav-section">
          <div className="fb-nav-title">{section.title}</div>
          {section.items.map((item) => {
            const button = (
              <button
                key={item.key}
                type="button"
                className={`fb-nav-item${active === item.key ? ' active' : ''}`}
                aria-current={active === item.key ? 'page' : undefined}
                disabled={item.upcoming}
                onClick={() => onNavigate(item.key)}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.upcoming
                  ? <em>{t("即将推出")}</em>
                  : item.count !== undefined && <b>{item.count}</b>}
              </button>
            )
            // A disabled button swallows hover events, so the tooltip hangs on a wrapper.
            return item.upcoming
              ? <Tooltip key={item.key} title={t("该模块正在开发中")} placement="right"><span className="fb-nav-upcoming">{button}</span></Tooltip>
              : button
          })}
        </div>
      ))}
      <div className="fb-nav-spacer" />
      <button type="button" className="fb-kernel-status" onClick={() => onNavigate('kernels')}>
        <span className={`fb-kernel-dot${engine?.fingerprintKernel ? ' ready' : ''}`} />
        <span>
          <strong>{engine?.fingerprintKernel ? t("内核已连接") : t("配置浏览器内核")}</strong>
          <small>{engine?.version ? `Chromium ${engine.version}` : mt(engine?.label ?? t("正在检查…"))}</small>
        </span>
      </button>
    </nav>
  )
}
