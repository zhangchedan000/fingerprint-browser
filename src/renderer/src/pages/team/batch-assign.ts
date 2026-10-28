export type BatchAssignMode = 'add' | 'set' | 'remove'

/** The members a window is assigned to after a batch change: some added, the list replaced, or some taken back. */
export function batchAssignees(current: string[], picked: string[], mode: BatchAssignMode): string[] {
  if (mode === 'set') return [...picked]
  if (mode === 'remove') return current.filter((id) => !picked.includes(id))
  return [...current, ...picked.filter((id) => !current.includes(id))]
}
