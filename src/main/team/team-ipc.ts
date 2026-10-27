import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { TeamLogQuery, TeamMemberDraft, TeamOffsiteDraft, TeamProfilePatch, TeamRegistration } from '../../shared/team'
import type { TeamManager } from './team-manager'

export function registerTeamIpc(team: TeamManager): void {
  ipcMain.handle('team:status', () => team.status())
  ipcMain.handle('team:retry', () => team.retry())
  ipcMain.handle('team:probe', (_event, server: string) => team.probe(server))
  ipcMain.handle('team:setup', (_event, server: string, code: string, username: string, name: string, password: string) =>
    team.setup(server, code, username, name, password))
  ipcMain.handle('team:login', (_event, server: string, username: string, password: string) => team.login(server, username, password))
  ipcMain.handle('team:register', (_event, draft: TeamRegistration) => team.register(draft))
  ipcMain.handle('team:change-password', (_event, oldPassword: string, password: string) => team.changePassword(oldPassword, password))
  ipcMain.handle('team:logout', () => team.logout())
  ipcMain.handle('team:invites', () => team.invites())
  ipcMain.handle('team:invite-create', (_event, note: string) => team.createInvite(note))
  ipcMain.handle('team:invite-revoke', (_event, id: string) => team.revokeInvite(id))
  ipcMain.handle('team:members', () => team.listMembers())
  ipcMain.handle('team:member-create', (_event, draft: TeamMemberDraft) => team.createMember(draft))
  ipcMain.handle('team:member-update', (_event, id: string, draft: TeamMemberDraft) => team.updateMember(id, draft))
  ipcMain.handle('team:member-remove', (_event, id: string) => team.removeMember(id))
  ipcMain.handle('team:profiles', () => team.listProfiles())
  ipcMain.handle('team:links', () => team.links())
  ipcMain.handle('team:share', (_event, ids: string[], assignees: string[]) => team.share(ids, assignees))
  ipcMain.handle('team:profile-update', async (_event, id: string, patch: TeamProfilePatch) => { await team.updateProfile(id, patch) })
  ipcMain.handle('team:unshare', (_event, id: string) => team.unshare(id))
  ipcMain.handle('team:force-unlock', (_event, id: string) => team.forceUnlock(id))
  ipcMain.handle('team:add-to-computer', (_event, id: string) => team.restoreToComputer(id))
  ipcMain.handle('team:sync', () => team.sync())
  ipcMain.handle('team:logs', (_event, query: TeamLogQuery) => team.logs(query))
  ipcMain.handle('team:server-info', () => team.serverInfo())
  ipcMain.handle('team:backups', () => team.backups())
  ipcMain.handle('team:backup-create', () => team.createBackup())
  ipcMain.handle('team:offsite-set', (_event, draft: TeamOffsiteDraft) => team.setOffsite(draft))
  ipcMain.handle('team:offsite-remove', () => team.removeOffsite())
  ipcMain.handle('team:backup-remove', (_event, key: string) => team.removeBackup(key))
  ipcMain.handle('team:backup-download', async (_event, key: string) => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: '保存团队服务器备份',
      defaultPath: key.replace(/^@/, ''),
      filters: [{ name: '备份', extensions: ['zip'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await team.downloadBackup(key, result.filePath)
    return result.filePath
  })
}
