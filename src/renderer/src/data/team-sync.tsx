import { useEffect } from 'react'
import { t } from '../../../shared/i18n'
import { useWorkspace } from './workspace'

/** Team windows move their login state around opening and closing, from any page. */
export function useTeamSyncNotices(): void {
  const ws = useWorkspace()
  useEffect(() => window.browserApi.team.onSync((event) => {
    const name = ws.profiles.find((profile) => profile.id === event.profileId)?.name ?? ''
    const key = `team-sync-${event.profileId}`
    if (event.phase === 'pulling') ws.notify.loading({ key, content: t("{0}：正在拉取最新登录态…", name), duration: 0 })
    else if (event.phase === 'pushing') ws.notify.loading({ key, content: t("{0}：正在上传登录态…", name), duration: 0 })
    else if (event.phase === 'done') ws.notify.destroy(key)
    else ws.notify.error({ key, content: `${name}：${event.message ?? ''}`, duration: 8 })
  }), [ws.profiles, ws.notify])
}
