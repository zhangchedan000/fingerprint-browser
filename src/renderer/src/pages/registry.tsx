import {
  AppstoreAddOutlined,
  AppstoreOutlined,
  ClusterOutlined,
  DeploymentUnitOutlined,
  FolderOutlined,
  RestOutlined,
  SettingOutlined,
  TeamOutlined
} from '@ant-design/icons'
import type { ComponentType, ReactNode } from 'react'
import { t } from '../../../shared/i18n'
import type { Workspace } from '../data/workspace'
import { ExtensionsPage } from './extensions/ExtensionsPage'
import { GroupsPage } from './groups/GroupsPage'
import { KernelsPage } from './kernels/KernelsPage'
import { ProxiesPage, proxiesSubtitle } from './proxies/ProxiesPage'
import { RecyclePage } from './recycle/RecyclePage'
import { SettingsPage } from './settings/SettingsPage'
import { TeamPage } from './team/TeamPage'
import { windowsSubtitle, WindowsPage } from './windows/WindowsPage'

export type PageKey = 'windows' | 'groups' | 'proxies' | 'team' | 'extensions' | 'kernels' | 'recycle' | 'settings'
export type SectionKey = 'workspace' | 'tools' | 'system'

/** Context one page can hand to another, e.g. "show this group's windows". */
export interface PageParams {
  groupId?: string
  /** Settings tab to open, e.g. "about" from the sidebar's update badge. */
  settingsTab?: 'about'
  /** Windows running on this kernel version. */
  kernelVersion?: string
}

/** What a page receives from the app shell. */
export interface PageProps {
  navigate: (key: PageKey, params?: PageParams) => void
  params?: PageParams
}

export interface PageDefinition {
  key: PageKey
  section: SectionKey
  icon: ReactNode
  label: () => string
  /** Number shown next to the menu entry. */
  count?: (workspace: Workspace) => number | undefined
  /** Text next to the page title in the top bar. */
  subtitle?: (workspace: Workspace) => string
  /** A full page in the main area. */
  page?: ComponentType<PageProps>
  /** Listed but not built yet. */
  upcoming?: boolean
}

export const SECTIONS: Array<{ key: SectionKey; title: () => string }> = [
  { key: 'workspace', title: () => t("工作区") },
  { key: 'tools', title: () => t("工具") },
  { key: 'system', title: () => t("系统") }
]

/**
 * Every entry of the side menu. Adding a page = a folder under pages/ plus one line here;
 * the sidebar, top bar and navigation pick it up from this list.
 */
export const PAGES: PageDefinition[] = [
  {
    key: 'windows',
    section: 'workspace',
    icon: <AppstoreOutlined />,
    label: () => t("窗口管理"),
    count: (ws) => ws.profiles.length,
    subtitle: (ws) => windowsSubtitle(ws.profiles),
    page: ({ navigate, params }) => <WindowsPage openKernels={() => navigate('kernels')} groupId={params?.groupId} kernelVersion={params?.kernelVersion} />
  },
  {
    key: 'groups',
    section: 'workspace',
    icon: <FolderOutlined />,
    label: () => t("分组管理"),
    count: (ws) => ws.groups.length,
    subtitle: () => t("按业务或平台给窗口分类，方便筛选和批量操作"),
    page: GroupsPage
  },
  {
    key: 'proxies',
    section: 'workspace',
    icon: <ClusterOutlined />,
    label: () => t("代理 IP"),
    count: (ws) => ws.proxies.length,
    subtitle: () => proxiesSubtitle(),
    page: ProxiesPage
  },
  {
    key: 'team',
    section: 'workspace',
    icon: <TeamOutlined />,
    label: () => t("团队"),
    subtitle: () => t("把窗口分配给成员使用，登录态在成员之间自动同步"),
    page: TeamPage
  },
  {
    key: 'extensions',
    section: 'tools',
    icon: <AppstoreAddOutlined />,
    label: () => t("扩展中心"),
    count: (ws) => ws.extensions.length || undefined,
    subtitle: () => t("导入一次，按需分配给窗口；每个窗口的扩展数据彼此独立"),
    page: ExtensionsPage
  },
  {
    key: 'kernels',
    section: 'tools',
    icon: <DeploymentUnitOutlined />,
    label: () => t("内核管理"),
    subtitle: () => t("每个窗口可以单独指定内核；没指定的窗口使用默认内核"),
    page: KernelsPage
  },
  {
    key: 'recycle',
    section: 'tools',
    icon: <RestOutlined />,
    label: () => t("回收站"),
    subtitle: () => t("删除的窗口连同 Cookie 和缓存保留在这里，可随时恢复"),
    page: RecyclePage
  },
  { key: 'settings', section: 'system', icon: <SettingOutlined />, label: () => t("设置"), page: SettingsPage }
]

export function pageDefinition(key: PageKey): PageDefinition {
  return PAGES.find((page) => page.key === key)!
}
