import { useWorkspace } from '../../data/workspace'
import type { DialogProps } from '../registry'
import { RecycleBinModal } from './RecycleBinModal'

/** Recycle bin (still a dialog until its own page is built). */
export function RecycleDialog({ open, onClose }: DialogProps) {
  const ws = useWorkspace()
  return <RecycleBinModal open={open} onClose={onClose} onRestored={(profile) => ws.upsertProfiles([profile])} />
}
