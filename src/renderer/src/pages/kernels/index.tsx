import { useWorkspace } from '../../data/workspace'
import type { DialogProps } from '../registry'
import { KernelManagerModal } from './KernelManagerModal'

/** Kernel management (still a dialog until its own page is built). */
export function KernelsDialog({ open, onClose }: DialogProps) {
  const ws = useWorkspace()
  return (
    <KernelManagerModal
      open={open}
      engine={ws.engine}
      onClose={onClose}
      onEngineChanged={(engine) => {
        ws.setEngine(engine)
        void ws.reloadKernels().catch(ws.fail)
      }}
    />
  )
}
