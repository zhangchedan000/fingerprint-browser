import { ipcMain } from 'electron'
import type { TeamLogQuery, TeamMemberDraft, TeamProfilePatch } from '../../shared/team'
import type { TeamManager } from './team-manager'

export function registerTeamIpc(team: TeamManager): void {
  ipcMain.handle('team:status', () => team.status())
  ipcMain.handle('team:retry', () => team.retry())
  ipcMain.handle('team:probe', (_event, server: string) => team.probe(server))
  ipcMain.handle('team:setup', (_event, server: string, code: string, username: string, name: string, password: string) =>
    team.setup(server, code, username, name, password))
  ipcMain.handle('team:login', (_event, server: string, username: string, password: string) => team.login(server, username, password))
  ipcMain.handle('team:logout', () => team.logout())
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
  ipcMain.handle('team:add-to-computer', (_event, id: string) => team.addToComputer(id))
  ipcMain.handle('team:logs', (_event, query: TeamLogQuery) => team.logs(query))
}
