import type { ReactNode } from 'react'

export type PillTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

/** One look for every status in the app: a soft coloured pill, with a dot unless told otherwise. */
export function StatusPill({ tone = 'neutral', dot = true, pulse = false, children, title }: {
  tone?: PillTone
  dot?: boolean
  /** A gently pulsing dot for something live (running, connected). */
  pulse?: boolean
  children: ReactNode
  title?: string
}) {
  return (
    <span className={`fb-pill is-${tone}${pulse ? ' is-pulse' : ''}`} title={title}>
      {dot && <i aria-hidden="true" />}
      {children}
    </span>
  )
}
