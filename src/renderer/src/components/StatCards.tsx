export interface Stat {
  label: string
  value: number | string
  /** Colour of the number; defaults to the normal text colour. */
  tone?: 'success' | 'danger' | 'warning'
}

/** Summary numbers above a list (design: proxy page). */
export function StatCards({ stats }: { stats: Stat[] }) {
  return (
    <div className="fb-stats">
      {stats.map((stat) => (
        <div key={stat.label} className="fb-stat">
          <span>{stat.label}</span>
          <strong className={stat.tone ? `is-${stat.tone}` : undefined}>{stat.value}</strong>
        </div>
      ))}
    </div>
  )
}
