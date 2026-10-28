import { kernelChromiumVersion } from '../../../shared/kernel-id'
import { t, translateMessage as mt } from '../../../shared/i18n'
import type { ProfileStatus } from '../../../shared/types'

/** Window states in which a browser process exists. */
export const ACTIVE_STATUSES: ReadonlySet<ProfileStatus> = new Set(['starting', 'running', 'stopping', 'orphaned'])

/** Edits, deletes, cookie and proxy changes need a closed window. */
export function isEditable(profile: { status: ProfileStatus }): boolean {
  return profile.status === 'closed' || profile.status === 'error'
}

/** An error from the main process in the interface language. */
export function humanError(error: unknown): string {
  return mt(error instanceof Error ? error.message : String(error))
}

export function majorVersion(version: string): string {
  return kernelChromiumVersion(version).split('.')[0] || version
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** A full date and time, e.g. 2026/10/27 19:27, for telling windows apart by when they were made. */
export function dateTime(iso: string | undefined, locale: string): string {
  const time = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(time)) return '—'
  return new Date(time).toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** Like dateTime, without the year when it is this year (lists, where width counts). */
export function shortDateTime(iso: string | undefined, locale: string): string {
  const time = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(time)) return '—'
  const date = new Date(time)
  if (date.getFullYear() !== new Date().getFullYear()) return dateTime(iso, locale)
  return date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function relativeTime(iso: string | undefined, locale: string, never = t("从未打开")): string {
  if (!iso) return never
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return never
  const minutes = Math.floor((Date.now() - time) / 60_000)
  if (minutes < 1) return t("刚刚")
  if (minutes < 60) return t("{0} 分钟前", minutes)
  const date = new Date(time)
  const clock = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (time >= startOfToday) return t("今天 {0}", clock)
  if (time >= startOfToday - 86_400_000) return t("昨天 {0}", clock)
  return date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
