import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrowserApi, BrowserProfileView, KernelInstallProgress, ProfileBatchClassification, ProfileDraft, ProfileLaunchOptions } from '../shared/types'

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
    openProjectPage: () => ipcRenderer.invoke('app:open-project-page')
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    create: (draft: ProfileDraft) => ipcRenderer.invoke('profiles:create', draft),
    update: (id: string, draft: ProfileDraft) => ipcRenderer.invoke('profiles:update', id, draft),
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
    close: (id: string) => ipcRenderer.invoke('profiles:close', id),
    closeAll: () => ipcRenderer.invoke('profiles:close-all'),
    testProxy: (id: string) => ipcRenderer.invoke('profiles:test-proxy', id),
    diagnose: (id: string) => ipcRenderer.invoke('profiles:diagnose', id),
    crashHistory: (id: string) => ipcRenderer.invoke('profiles:crash-history', id),
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
    install: (version: string) => ipcRenderer.invoke('engine:install', version),
    cancelInstall: (version: string) => ipcRenderer.invoke('engine:cancel-install', version),
    onProgress: (listener: (progress: KernelInstallProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: KernelInstallProgress): void => listener(progress)
      ipcRenderer.on('engine:progress', handler)
      return () => ipcRenderer.removeListener('engine:progress', handler)
    }
  },
  proxy: {
    test: (config, profileId, proxyId) => ipcRenderer.invoke('proxy:test', config, profileId, proxyId),
    list: () => ipcRenderer.invoke('proxy:list'),
    create: (draft) => ipcRenderer.invoke('proxy:create', draft),
    createMany: (drafts) => ipcRenderer.invoke('proxy:create-many', drafts),
    update: (id, draft) => ipcRenderer.invoke('proxy:update', id, draft),
    remove: (id, replaceWith) => ipcRenderer.invoke('proxy:remove', id, replaceWith),
    check: (id) => ipcRenderer.invoke('proxy:check', id)
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
  }
}

contextBridge.exposeInMainWorld('browserApi', api)
