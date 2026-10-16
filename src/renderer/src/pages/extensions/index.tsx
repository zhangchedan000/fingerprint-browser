import { useWorkspace } from '../../data/workspace'
import type { DialogProps } from '../registry'
import { ExtensionManagerModal } from './ExtensionManagerModal'

/** Extension center (still a dialog until its own page is built). */
export function ExtensionsDialog({ open, onClose }: DialogProps) {
  const ws = useWorkspace()
  return <ExtensionManagerModal open={open} extensions={ws.extensions} onClose={onClose} onChanged={ws.setExtensions} />
}
