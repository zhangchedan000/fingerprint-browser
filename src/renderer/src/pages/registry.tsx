import {
  AppstoreAddOutlined,
  AppstoreOutlined,
  ClusterOutlined,
  DeploymentUnitOutlined,
  FolderOutlined,
  RestOutlined,
  SettingOutlined
} from '@ant-design/icons'
import type { ComponentType, ReactNode } from 'react'
import { t } from '../../../shared/i18n'
import type { Workspace } from '../data/workspace'
import { ExtensionsDialog } from './extensions'
import { GroupsPage } from './groups/GroupsPage'
import { KernelsDialog } from './kernels'
import { ProxiesPage, proxiesSubtitle } from './proxies/ProxiesPage'
import { RecycleDialog } from './recycle'
import { windowsSubtitle, WindowsPage } from './windows/WindowsPage'

export type PageKey = 'windows' | 'groups' | 'proxies' | 'extensions' | 'kernels' | 'recycle' | 'settings'
export type SectionKey = 'workspace' | 'tools' | 'system'

/** Context one page can hand to another, e.g. "show this group's windows". */
export interface PageParams {
  groupId?: string
}

/** What a page receives from the app shell. */
export interface PageProps {
  navigate: (key: PageKey, params?: PageParams) => void
  params?: PageParams
}

export interface DialogProps {
  open: boolean
  onClose: () => void
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
  /** A tool that still opens as a dialog over the current page. */
  dialog?: ComponentType<DialogProps>
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
    page: ({ navigate, params }) => <WindowsPage openKernels={() => navigate('kernels')} groupId={params?.groupId} />
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
    key: 'extensions',
    section: 'tools',
    icon: <AppstoreAddOutlined />,
    label: () => t("扩展中心"),
    count: (ws) => ws.extensions.length || undefined,
    dialog: ExtensionsDialog
  },
  { key: 'kernels', section: 'tools', icon: <DeploymentUnitOutlined />, label: () => t("内核管理"), dialog: KernelsDialog },
  { key: 'recycle', section: 'tools', icon: <RestOutlined />, label: () => t("回收站"), dialog: RecycleDialog },
  { key: 'settings', section: 'system', icon: <SettingOutlined />, label: () => t("设置"), upcoming: true }
]

export function pageDefinition(key: PageKey): PageDefinition {
  return PAGES.find((page) => page.key === key)!
}
