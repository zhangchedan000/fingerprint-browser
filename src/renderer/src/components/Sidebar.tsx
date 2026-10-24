import { Tooltip } from 'antd'
import { t, translateMessage as mt } from '../../../shared/i18n'
import { useWorkspace } from '../data/workspace'
import { PAGES, SECTIONS, type PageKey } from '../pages/registry'

/** The side menu, built from the page registry. */
export function Sidebar({ active, onNavigate }: { active: PageKey; onNavigate: (key: PageKey) => void }) {
  const ws = useWorkspace()
  const { engine } = ws
  return (
    <nav className="fb-sidebar" aria-label={t("主导航")}>
      <div className="fb-brand">
        <span className="fb-brand-mark" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12 4a8 8 0 0 0-8 8M12 8a4 4 0 0 0-4 4v2M20 12a8 8 0 0 0-3-6.2M16 12v1a8 8 0 0 1-2 5.3M12 12v2a4 4 0 0 1-1.5 3.1" />
          </svg>
        </span>
        <span>
          <strong>{t("指纹浏览器")}</strong>
          <small>v{__APP_VERSION__}</small>
        </span>
      </div>
      {SECTIONS.map((section) => (
        <div key={section.key} className="fb-nav-section">
          <div className="fb-nav-title">{section.title()}</div>
          {PAGES.filter((page) => page.section === section.key).map((page) => {
            const count = page.count?.(ws)
            const button = (
              <button
                key={page.key}
                type="button"
                className={`fb-nav-item${active === page.key ? ' active' : ''}`}
                aria-current={active === page.key ? 'page' : undefined}
                disabled={page.upcoming}
                onClick={() => onNavigate(page.key)}
              >
                {page.icon}
                <span>{page.label()}</span>
                {page.upcoming ? <em>{t("即将推出")}</em> : count !== undefined && <b>{count}</b>}
              </button>
            )
            // A disabled button swallows hover events, so the tooltip hangs on a wrapper.
            return page.upcoming
              ? <Tooltip key={page.key} title={t("该模块正在开发中")} placement="right"><span className="fb-nav-upcoming">{button}</span></Tooltip>
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
