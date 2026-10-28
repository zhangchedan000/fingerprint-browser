import type { ReactNode } from 'react'

export interface Stat {
  label: string
  value: number | string
  /** Colour of the number; defaults to the normal text colour. */
  tone?: 'success' | 'danger' | 'warning'
  /** What to do about this number, e.g. 全部检测 next to 未检测. */
  action?: ReactNode
}

/** Summary numbers above a list (design: proxy page). */
export function StatCards({ stats }: { stats: Stat[] }) {
  return (
    <div className="fb-stats">
      {stats.map((stat) => (
        <div key={stat.label} className="fb-stat">
          <span>{stat.label}</span>
          <strong className={stat.tone ? `is-${stat.tone}` : undefined}>{stat.value}</strong>
          {stat.action && <div className="fb-stat-action">{stat.action}</div>}
        </div>
      ))}
    </div>
  )
}
