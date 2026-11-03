import { Tag } from 'antd'
import { t } from '../../../shared/i18n'
import type { TeamDeviceStateView } from '../../../shared/team'

/**
 * The 电脑 cell of a window's cloud copies: the computer's name (本机 for this one), its system under
 * it, and, when two copies carry the same computer name (the app's data on that computer was
 * reset, or a second app ran there), the first characters of each one's computer id.
 */
export function DeviceCopyComputer({ state, states }: { state: TeamDeviceStateView; states: readonly TeamDeviceStateView[] }) {
  const sameName = states.some((other) => other.id !== state.id && other.deviceName === state.deviceName)
  return (
    <div>
      <span>
        {state.deviceName}
        {state.thisComputer && <Tag color="blue" style={{ marginLeft: 8 }}>{t("本机")}</Tag>}
        {sameName && <span className="fb-muted" style={{ marginLeft: 8, fontSize: 12 }}>{t("编号 {0}", state.deviceShort)}</span>}
      </span>
      {state.os && <div className="fb-muted" style={{ fontSize: 12 }}>{state.os}</div>}
    </div>
  )
}
