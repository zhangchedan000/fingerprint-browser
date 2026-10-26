import { useState } from 'react'
import { t } from '../../../shared/i18n'
import { formatBytes } from '../components/format'
import { WorkspaceMigrationModal } from '../components/WorkspaceMigrationModal'
import { useWorkspace } from './workspace'

/**
 * Moving every window to another computer (encrypted package). Used by the windows page
 * menu and the settings page; returns the trigger and the dialog to render.
 */
export function useWorkspaceMigration() {
  const ws = useWorkspace()
  const [mode, setMode] = useState<'export' | 'import' | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(password: string, conflictPolicy: 'rename' | 'skip'): Promise<void> {
    if (!mode) return
    setBusy(true)
    try {
      const result = mode === 'export'
        ? await window.browserApi.profiles.exportWorkspace(password)
        : await window.browserApi.profiles.importWorkspace(password, conflictPolicy)
      if (!result) return
      if (mode === 'export') {
        ws.notify.success(t("已加密导出 {0} 个环境、{1}", result.profileCount, formatBytes(result.totalBytes)))
      } else {
        await Promise.all([ws.reloadProfiles(), ws.reloadLibraries(), window.browserApi.extensions.list().then(ws.setExtensions)])
        ws.notify.success(result.renamedCount
          ? result.skippedCount
            ? t("已导入 {0} 个环境，自动改名 {1} 个，跳过 {2} 个", result.importedCount, result.renamedCount, result.skippedCount)
            : t("已导入 {0} 个环境，自动改名 {1} 个", result.importedCount, result.renamedCount)
          : result.skippedCount
            ? t("已导入 {0} 个环境，跳过 {1} 个", result.importedCount, result.skippedCount)
            : t("已导入 {0} 个环境", result.importedCount))
      }
      setMode(null)
    } catch (error) {
      ws.fail(error, 8)
    } finally {
      setBusy(false)
    }
  }

  const dialog = (
    <WorkspaceMigrationModal
      mode={mode}
      busy={busy}
      profileCount={ws.profiles.length}
      onSubmit={run}
      onClose={() => { if (!busy) setMode(null) }}
    />
  )
  return { start: setMode, dialog }
}
