/**
 * Marker colours a group can have (user data shown as a dot, not theme colours).
 * New groups take the next one in turn.
 */
export const GROUP_COLORS = ['#2f6bff', '#0f9d8a', '#e8590c', '#6a4cff', '#c2185b', '#8a5a00', '#1e88e5', '#43a047'] as const

export function nextGroupColor(existing: number): string {
  return GROUP_COLORS[existing % GROUP_COLORS.length]
}
