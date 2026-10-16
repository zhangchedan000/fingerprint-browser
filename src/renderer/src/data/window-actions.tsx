import { Modal } from 'antd'
import { t, translateMessage as mt } from '../../../shared/i18n'
import { geoConflictConfirmationMessage } from '../../../shared/network-identity'
import type { BrowserProfileView } from '../../../shared/types'
import { humanError, isEditable } from '../components/format'
import { orderBatchLaunchProfiles, waitForBatchLaunchGap } from '../pages/windows/batch-launch-order'
import { useWorkspace } from './workspace'

function confirmGeoConflict(profile: BrowserProfileView, warning: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    Modal.confirm({
      title: t("#{0} {1} 的代理地区存在冲突", profile.serialNumber, profile.name),
      content: mt(warning),
      okText: t("了解风险，继续打开"),
      cancelText: t("取消"),
      okButtonProps: { danger: true },
      onOk: () => settle(true),
      onCancel: () => settle(false),
      afterClose: () => settle(false)
    })
  })
}

export interface OpenManyResult {
  total: number
  succeeded: number
  errors: string[]
}

/** Opening windows, shared by every page that has an "open" button. */
export function useWindowLauncher() {
  const ws = useWorkspace()

  /** Opens one window; asks before going on when the proxy's GeoIP sources disagree. undefined = cancelled. */
  async function launch(profile: BrowserProfileView): Promise<BrowserProfileView | undefined> {
    try {
      return await window.browserApi.profiles.launch(profile.id)
    } catch (error) {
      const warning = geoConflictConfirmationMessage(humanError(error))
      if (!warning) throw error
      if (!await confirmGeoConflict(profile, warning)) return undefined
      return window.browserApi.profiles.launch(profile.id, { allowGeoConflict: true })
    }
  }

  /** Opens closed windows one after another with the batch gap; collects the failures. */
  async function openMany(profiles: BrowserProfileView[], onEach?: (profile: BrowserProfileView) => void): Promise<OpenManyResult> {
    const candidates = orderBatchLaunchProfiles(profiles.filter(isEditable))
    const errors: string[] = []
    for (let index = 0; index < candidates.length; index++) {
      const profile = candidates[index]
      try {
        const next = await launch(profile)
        if (next) {
          ws.upsertProfiles([next])
          onEach?.(next)
        } else {
          errors.push(t("{0}：用户取消了 GeoIP 冲突风险确认", profile.name))
        }
      } catch (error) {
        errors.push(`${profile.name}：${humanError(error)}`)
      }
      if (index < candidates.length - 1) await waitForBatchLaunchGap(ws.preferences.batchLaunchGapSeconds * 1000)
    }
    return { total: candidates.length, succeeded: candidates.length - errors.length, errors }
  }

  return { launch, openMany }
}
