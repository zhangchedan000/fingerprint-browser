import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DeepSiteResult } from '../shared/deep-check'
import type { TeamSyncEvent } from '../shared/team'
import type { FontPackProgress } from '../shared/windows-font-packs'
import type { AppUpdateProgress, BrowserApi, BrowserProfileView, KernelInstallProgress, RelocateProgress, TunnelRoute, TunnelStatus, ProfileBatchClassification, ProfileDraft, ProfileLaunchOptions } from '../shared/types'

const api: BrowserApi = {
  uiLanguage: {
    get: () => ipcRenderer.invoke('ui-language:get'),
    set: (locale) => ipcRenderer.invoke('ui-language:set', locale)
  },
  app: {
    preferences: () => ipcRenderer.invoke('app:preferences'),
    setPreferences: (patch) => ipcRenderer.invoke('app:set-preferences', patch),
    info: () => ipcRenderer.invoke('app:info'),
    openFolder: (folder) => ipcRenderer.invoke('app:open-folder', folder),
    openProjectPage: () => ipcRenderer.invoke('app:open-project-page'),
    vaultLocation: () => ipcRenderer.invoke('app:vault-location'),
    relocateVault: () => ipcRenderer.invoke('app:relocate-vault'),
    deletePreviousVault: () => ipcRenderer.invoke('app:delete-previous-vault'),
    revertVault: () => ipcRenderer.invoke('app:revert-vault'),
    onRelocateProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: RelocateProgress): void => listener(progress)
      ipcRenderer.on('app:relocate-progress', handler)
      return () => ipcRenderer.removeListener('app:relocate-progress', handler)
    },
    checkUpdate: () => ipcRenderer.invoke('app:update-check'),
    downloadUpdate: () => ipcRenderer.invoke('app:update-download'),
    installUpdate: () => ipcRenderer.invoke('app:update-install'),
    openUpdatePage: () => ipcRenderer.invoke('app:update-page'),
    onUpdateProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: AppUpdateProgress): void => listener(progress)
      ipcRenderer.on('app:update-progress', handler)
      return () => ipcRenderer.removeListener('app:update-progress', handler)
    },
    chooseDownloadFolder: () => ipcRenderer.invoke('app:choose-download-folder'),
    openDownloadFolder: () => ipcRenderer.invoke('app:open-download-folder'),
    defaultDownloadFolder: () => ipcRenderer.invoke('app:default-download-folder'),
    fontPacks: () => ipcRenderer.invoke('fonts:packs'),
    installFontPacks: (scripts?: string[]) => ipcRenderer.invoke('fonts:install-packs', scripts),
    onFontPackProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: FontPackProgress): void => listener(progress)
      ipcRenderer.on('fonts:progress', handler)
      return () => ipcRenderer.removeListener('fonts:progress', handler)
    }
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    passwords: (id: string) => ipcRenderer.invoke('profiles:passwords', id),
    create: (draft: ProfileDraft) => ipcRenderer.invoke('profiles:create', draft),
    update: (id: string, draft: ProfileDraft) => ipcRenderer.invoke('profiles:update', id, draft),
    updateDetails: (id: string, draft: ProfileDraft) => ipcRenderer.invoke('profiles:update-details', id, draft),
    duplicate: (id: string) => ipcRenderer.invoke('profiles:duplicate', id),
    exportConfig: (id: string) => ipcRenderer.invoke('profiles:export-config', id),
    importConfig: () => ipcRenderer.invoke('profiles:import-config'),
    previewBatchImport: (path) => ipcRenderer.invoke('profiles:batch-import-preview', path),
    commitBatchImport: (token, options) => ipcRenderer.invoke('profiles:batch-import-commit', token, options),
    saveBatchImportErrors: (token) => ipcRenderer.invoke('profiles:batch-import-save-errors', token),
    exportBatchTemplate: (format) => ipcRenderer.invoke('profiles:export-batch-template', format),
    pathForFile: (file) => webUtils.getPathForFile(file),
    storageHealth: () => ipcRenderer.invoke('profiles:storage-health'),
    storageInfo: (id: string) => ipcRenderer.invoke('profiles:storage-info', id),
    storageOverview: () => ipcRenderer.invoke('profiles:storage-overview'),
    openDataFolder: (id: string) => ipcRenderer.invoke('profiles:open-data-folder', id),
    clearCache: (id: string) => ipcRenderer.invoke('profiles:clear-cache', id),
    checkFingerprint: (draft: ProfileDraft, profileId?: string, settingsKey?: string) => ipcRenderer.invoke('profiles:check-fingerprint', draft, profileId, settingsKey),
    deepCheck: (draft: ProfileDraft, profileId?: string, settingsKey?: string) => ipcRenderer.invoke('profiles:deep-check', draft, profileId, settingsKey),
    lastDeepCheck: (id: string) => ipcRenderer.invoke('profiles:last-deep-check', id),
    onDeepCheckProgress: (listener: (result: DeepSiteResult) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: DeepSiteResult): void => listener(result)
      ipcRenderer.on('profiles:deep-check-progress', handler)
      return () => ipcRenderer.removeListener('profiles:deep-check-progress', handler)
    },
    lastFingerprintCheck: (id: string) => ipcRenderer.invoke('profiles:last-fingerprint-check', id),
    exportBackup: (id: string) => ipcRenderer.invoke('profiles:export-backup', id),
    importBackup: () => ipcRenderer.invoke('profiles:import-backup'),
    exportWorkspace: (password: string) => ipcRenderer.invoke('profiles:export-workspace', password),
    importWorkspace: (password: string, conflictPolicy: 'rename' | 'skip') => ipcRenderer.invoke('profiles:import-workspace', password, conflictPolicy),
    trash: () => ipcRenderer.invoke('profiles:trash'),
    restore: (trashId: string) => ipcRenderer.invoke('profiles:restore', trashId),
    purgeTrash: (trashId: string) => ipcRenderer.invoke('profiles:purge-trash', trashId),
    emptyTrash: () => ipcRenderer.invoke('profiles:empty-trash'),
    recycleRetention: () => ipcRenderer.invoke('profiles:recycle-retention'),
    setRecycleRetention: (days) => ipcRenderer.invoke('profiles:set-recycle-retention', days),
    exportCookies: (id: string) => ipcRenderer.invoke('profiles:export-cookies', id),
    importCookies: (id: string) => ipcRenderer.invoke('profiles:import-cookies', id),
    remove: (id: string) => ipcRenderer.invoke('profiles:remove', id),
    launch: (id: string, options?: ProfileLaunchOptions) => ipcRenderer.invoke('profiles:launch', id, options),
    openUrl: (id: string, url: string, options?: ProfileLaunchOptions) => ipcRenderer.invoke('profiles:open-url', id, url, options),
    close: (id: string) => ipcRenderer.invoke('profiles:close', id),
    closeAll: () => ipcRenderer.invoke('profiles:close-all'),
    testProxy: (id: string, refresh?: boolean, route?: TunnelRoute) => ipcRenderer.invoke('profiles:test-proxy', id, refresh, route),
    setApiUrl: (ids: string[], url: string) => ipcRenderer.invoke('profiles:set-api-url', ids, url),
    setApiReleased: (id: string, released: boolean) => ipcRenderer.invoke('profiles:set-api-released', id, released),
    diagnose: (id: string) => ipcRenderer.invoke('profiles:diagnose', id),
    crashHistory: (id: string) => ipcRenderer.invoke('profiles:crash-history', id),
    readLaunchLog: (id: string, logFile: string) => ipcRenderer.invoke('profiles:read-launch-log', id, logFile),
    openLaunchLogFolder: (id: string, logFile?: string) => ipcRenderer.invoke('profiles:open-launch-log-folder', id, logFile),
    setFavorite: (id: string, favorite: boolean) => ipcRenderer.invoke('profiles:set-favorite', id, favorite),
    classifyMany: (ids: string[], patch: ProfileBatchClassification) => ipcRenderer.invoke('profiles:classify-many', ids, patch),
    assignMany: (ids, patch) => ipcRenderer.invoke('profiles:assign-many', ids, patch),
    setKernelMany: (ids: string[], kernelVersion: string) => ipcRenderer.invoke('profiles:set-kernel-many', ids, kernelVersion),
    importCookiesText: (id: string, text: string) => ipcRenderer.invoke('profiles:import-cookies-text', id, text),
    removeMany: (ids: string[]) => ipcRenderer.invoke('profiles:remove-many', ids),
    onChanged: (listener: (profile: BrowserProfileView) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, profile: BrowserProfileView): void => listener(profile)
      ipcRenderer.on('profiles:changed', handler)
      return () => ipcRenderer.removeListener('profiles:changed', handler)
    }
  },
  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    bundled: () => ipcRenderer.invoke('engine:bundled'),
    activateBundled: () => ipcRenderer.invoke('engine:activate-bundled'),
    select: () => ipcRenderer.invoke('engine:select'),
    importLocal: () => ipcRenderer.invoke('engine:import-local'),
    useSystem: () => ipcRenderer.invoke('engine:use-system'),
    installed: () => ipcRenderer.invoke('engine:installed'),
    activate: (version: string) => ipcRenderer.invoke('engine:activate', version),
    rollbackAvailable: () => ipcRenderer.invoke('engine:rollback-available'),
    rollback: () => ipcRenderer.invoke('engine:rollback'),
    remove: (version: string) => ipcRenderer.invoke('engine:remove', version),
    verify: (version: string) => ipcRenderer.invoke('engine:verify', version),
    releases: () => ipcRenderer.invoke('engine:releases'),
    sources: () => ipcRenderer.invoke('engine:sources'),
    setSources: (sources: string[]) => ipcRenderer.invoke('engine:set-sources', sources),
    install: (version: string, tag?: string) => ipcRenderer.invoke('engine:install', version, tag),
    cancelInstall: (version: string) => ipcRenderer.invoke('engine:cancel-install', version),
    onProgress: (listener: (progress: KernelInstallProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: KernelInstallProgress): void => listener(progress)
      ipcRenderer.on('engine:progress', handler)
      return () => ipcRenderer.removeListener('engine:progress', handler)
    }
  },
  tunnel: {
    status: () => ipcRenderer.invoke('tunnel:status'),
    setEnabled: (enabled) => ipcRenderer.invoke('tunnel:set-enabled', enabled),
    addSource: (input) => ipcRenderer.invoke('tunnel:add-source', input),
    source: (id) => ipcRenderer.invoke('tunnel:source', id),
    updateSource: (id, input) => ipcRenderer.invoke('tunnel:update-source', id, input),
    removeSource: (id) => ipcRenderer.invoke('tunnel:remove-source', id),
    select: (name) => ipcRenderer.invoke('tunnel:select', name),
    autoSelect: () => ipcRenderer.invoke('tunnel:auto-select'),
    test: () => ipcRenderer.invoke('tunnel:test'),
    refresh: () => ipcRenderer.invoke('tunnel:refresh'),
    onChanged: (listener: (status: TunnelStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: TunnelStatus): void => listener(status)
      ipcRenderer.on('tunnel:changed', handler)
      return () => ipcRenderer.removeListener('tunnel:changed', handler)
    }
  },
  proxy: {
    test: (config, profileId, proxyId) => ipcRenderer.invoke('proxy:test', config, profileId, proxyId),
    list: () => ipcRenderer.invoke('proxy:list'),
    create: (draft) => ipcRenderer.invoke('proxy:create', draft),
    createMany: (drafts) => ipcRenderer.invoke('proxy:create-many', drafts),
    update: (id, draft) => ipcRenderer.invoke('proxy:update', id, draft),
    remove: (id, replaceWith) => ipcRenderer.invoke('proxy:remove', id, replaceWith),
    check: (id, route) => ipcRenderer.invoke('proxy:check', id, route),
    password: (id) => ipcRenderer.invoke('proxy:password', id)
  },
  groups: {
    list: () => ipcRenderer.invoke('groups:list'),
    create: (draft) => ipcRenderer.invoke('groups:create', draft),
    update: (id, draft) => ipcRenderer.invoke('groups:update', id, draft),
    remove: (id) => ipcRenderer.invoke('groups:remove', id)
  },
  diagnostics: {
    sessionHealth: () => ipcRenderer.invoke('diagnostics:session-health'),
    e2eQuit: () => ipcRenderer.invoke('diagnostics:e2e-quit')
  },
  extensions: {
    list: () => ipcRenderer.invoke('extensions:list'),
    importDirectory: () => ipcRenderer.invoke('extensions:import-directory'),
    openSourceFolder: (id: string) => ipcRenderer.invoke('extensions:open-source-folder', id),
    setGlobalEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('extensions:set-global-enabled', id, enabled),
    remove: (id: string) => ipcRenderer.invoke('extensions:remove', id)
  },
  team: {
    status: () => ipcRenderer.invoke('team:status'),
    retry: () => ipcRenderer.invoke('team:retry'),
    probe: (server) => ipcRenderer.invoke('team:probe', server),
    setup: (server, code, username, name, password) => ipcRenderer.invoke('team:setup', server, code, username, name, password),
    login: (server, username, password) => ipcRenderer.invoke('team:login', server, username, password),
    register: (draft) => ipcRenderer.invoke('team:register', draft),
    changePassword: (oldPassword, password) => ipcRenderer.invoke('team:change-password', oldPassword, password),
    logout: () => ipcRenderer.invoke('team:logout'),
    invites: () => ipcRenderer.invoke('team:invites'),
    createInvite: (note) => ipcRenderer.invoke('team:invite-create', note),
    revokeInvite: (id) => ipcRenderer.invoke('team:invite-revoke', id),
    members: () => ipcRenderer.invoke('team:members'),
    createMember: (draft) => ipcRenderer.invoke('team:member-create', draft),
    updateMember: (id, draft) => ipcRenderer.invoke('team:member-update', id, draft),
    removeMember: (id) => ipcRenderer.invoke('team:member-remove', id),
    profiles: () => ipcRenderer.invoke('team:profiles'),
    links: () => ipcRenderer.invoke('team:links'),
    share: (ids, assignees) => ipcRenderer.invoke('team:share', ids, assignees),
    updateProfile: (id, patch) => ipcRenderer.invoke('team:profile-update', id, patch),
    unshare: (id) => ipcRenderer.invoke('team:unshare', id),
    forceUnlock: (id) => ipcRenderer.invoke('team:force-unlock', id),
    addToComputer: (id) => ipcRenderer.invoke('team:add-to-computer', id),
    sync: () => ipcRenderer.invoke('team:sync'),
    logs: (query) => ipcRenderer.invoke('team:logs', query),
    serverInfo: () => ipcRenderer.invoke('team:server-info'),
    backups: () => ipcRenderer.invoke('team:backups'),
    createBackup: () => ipcRenderer.invoke('team:backup-create'),
    removeBackup: (key) => ipcRenderer.invoke('team:backup-remove', key),
    setOffsite: (draft) => ipcRenderer.invoke('team:offsite-set', draft),
    removeOffsite: () => ipcRenderer.invoke('team:offsite-remove'),
    downloadBackup: (key) => ipcRenderer.invoke('team:backup-download', key),
    onSync: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, event: TeamSyncEvent): void => listener(event)
      ipcRenderer.on('team:sync', handler)
      return () => ipcRenderer.removeListener('team:sync', handler)
    }
  }
}

contextBridge.exposeInMainWorld('browserApi', api)
