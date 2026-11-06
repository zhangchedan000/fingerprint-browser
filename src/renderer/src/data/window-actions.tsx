import { Button, Checkbox, Modal, Space } from 'antd'
import { DEFAULT_DEVICE_BINDING } from '../../../shared/defaults'
import { t, translateMessage as mt } from '../../../shared/i18n'
import { geoConflictConfirmationMessage, zoneNoticeConfirmation } from '../../../shared/network-identity'
import type { BrowserProfileView } from '../../../shared/types'
import { humanError, isEditable } from '../components/format'
import { orderBatchLaunchProfiles, waitForBatchLaunchGap } from '../pages/windows/batch-launch-order'
import { useWorkspace } from './workspace'

/**
 * Asks before opening a window whose proxy region or time zone does not fit. The time-zone notice
 * also offers 「这个 IP 不再提醒」 (mute: it is not asked again until the exit IP changes).
 * undefined = cancelled.
 */
function confirmGeoConflict(profile: BrowserProfileView, warning: string): Promise<{ mute: boolean } | undefined> {
  const { text, zoneNotice } = zoneNoticeConfirmation(warning)
  return new Promise((resolve) => {
    let settled = false
    let mute = false
    const settle = (value: { mute: boolean } | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    Modal.confirm({
      title: zoneNotice ? t("#{0} {1} 的时区和代理 IP 对不上", profile.serialNumber, profile.name) : t("#{0} {1} 的代理地区存在冲突", profile.serialNumber, profile.name),
      content: zoneNotice
        ? (
            <div>
              <div>{mt(text)}</div>
              <Checkbox style={{ marginTop: 12 }} onChange={(event) => { mute = event.target.checked }}>{t("知道了，这个 IP 不再提醒（IP 变了会再提醒）")}</Checkbox>
            </div>
          )
        : mt(text),
      okText: t("了解风险，继续打开"),
      cancelText: t("取消"),
      okButtonProps: { danger: true },
      onOk: () => settle({ mute }),
      onCancel: () => settle(undefined),
      afterClose: () => settle(undefined)
    })
  })
}

/** The label of a 「设备绑定登录」 choice; the default one (DEFAULT_DEVICE_BINDING) says it is recommended. */
export function deviceBindingLabel(value: 'on' | 'off'): string {
  if (value === 'on') return DEFAULT_DEVICE_BINDING === 'on' ? t("绑定（推荐）") : t("绑定")
  return DEFAULT_DEVICE_BINDING === 'off' ? t("不绑定（推荐）") : t("不绑定")
}

/**
 * Asked before a new window's first opening: may its sign-ins be bound to the device? Closing the
 * dialog (X) opens nothing; the window asks again next time. undefined = closed.
 */
function chooseDeviceBinding(profile: BrowserProfileView): Promise<'on' | 'off' | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: 'on' | 'off' | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const dialog = Modal.confirm({
      title: t("#{0} {1}：设备绑定登录", profile.serialNumber, profile.name),
      icon: null,
      closable: true,
      maskClosable: false,
      keyboard: false,
      content: (
        <div className="fb-device-binding-choice">
          <p><strong>{deviceBindingLabel('off')}</strong>{t("：谷歌、抖音的登录换到别的电脑也能直接用。")}</p>
          <p><strong>{deviceBindingLabel('on')}</strong>{t("：和正常 Chrome 一样做设备绑定，绑定数据存在这个窗口里，跟着窗口同步。")}</p>
          <p className="fb-muted">{t("选好后不能再改。")}</p>
        </div>
      ),
      footer: (
        <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Button type={DEFAULT_DEVICE_BINDING === 'on' ? 'primary' : 'default'} onClick={() => { settle('on'); dialog.destroy() }}>{deviceBindingLabel('on')}</Button>
          <Button type={DEFAULT_DEVICE_BINDING === 'off' ? 'primary' : 'default'} onClick={() => { settle('off'); dialog.destroy() }}>{deviceBindingLabel('off')}</Button>
        </Space>
      ),
      onCancel: () => settle(undefined),
      afterClose: () => settle(undefined)
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

  /**
   * A new window asks its device-bound sign-in choice first (saved, then fixed). The profile to open, or
   * undefined when the dialog was closed.
   */
  async function readyToOpen(profile: BrowserProfileView): Promise<BrowserProfileView | undefined> {
    if (profile.fingerprint.deviceBinding !== 'ask') return profile
    const choice = await chooseDeviceBinding(profile)
    if (!choice) return undefined
    const next = await window.browserApi.profiles.setDeviceBinding(profile.id, choice)
    ws.upsertProfiles([next])
    return next
  }

  /** Opens one window; asks before going on when the proxy's GeoIP sources disagree. undefined = cancelled. */
  async function launch(start: BrowserProfileView): Promise<BrowserProfileView | undefined> {
    const profile = await readyToOpen(start)
    if (!profile) return undefined
    try {
      return await window.browserApi.profiles.launch(profile.id)
    } catch (error) {
      const warning = geoConflictConfirmationMessage(humanError(error))
      if (!warning) throw error
      const answer = await confirmGeoConflict(profile, warning)
      if (!answer) return undefined
      return window.browserApi.profiles.launch(profile.id, { allowGeoConflict: true, muteZoneNotice: answer.mute })
    }
  }

  /** Opens a page in the window: a new tab when it runs, otherwise it starts with the page. */
  async function openUrl(start: BrowserProfileView, url: string): Promise<BrowserProfileView | undefined> {
    const profile = await readyToOpen(start)
    if (!profile) return undefined
    try {
      return await window.browserApi.profiles.openUrl(profile.id, url)
    } catch (error) {
      const warning = geoConflictConfirmationMessage(humanError(error))
      if (!warning) throw error
      const answer = await confirmGeoConflict(profile, warning)
      if (!answer) return undefined
      return window.browserApi.profiles.openUrl(profile.id, url, { allowGeoConflict: true, muteZoneNotice: answer.mute })
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
          errors.push(t("{0}：没有打开（取消了确认）", profile.name))
        }
      } catch (error) {
        errors.push(`${profile.name}：${humanError(error)}`)
      }
      if (index < candidates.length - 1) await waitForBatchLaunchGap(ws.preferences.batchLaunchGapSeconds * 1000)
    }
    return { total: candidates.length, succeeded: candidates.length - errors.length, errors }
  }

  return { launch, openUrl, openMany }
}
