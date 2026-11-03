/** Team accounts: windows shared through the team server (server/team, PocketBase). */

export type TeamRole = 'owner' | 'member'

export interface TeamUser {
  id: string
  username: string
  name: string
  role: TeamRole
  disabled: boolean
  created: string
}

/**
 * The team cloud (sign-in, shared windows, login-state sync). Off: the app opens without signing in
 * and talks to no team server; every window is a plain local window. The code and the windows'
 * links to their cloud copies stay, so turning it on again (with a server) carries on from there.
 * On (from v0.5.50): a server that cannot be reached leaves the choice of local mode instead.
 */
export const TEAM_FEATURE_ENABLED = true

export interface TeamStatus {
  /** The team feature is switched off (TEAM_FEATURE_ENABLED): no sign-in, no server. */
  disabled?: boolean
  /** The server address saved on this computer; '' before the first connection. */
  server: string
  /** Signed in as; undefined when signed out. The app is only usable signed in. */
  user?: TeamUser
  /** The saved sign-in could not be checked because the server was unreachable. */
  offline?: string
  /** Working without the server (it could not be reached): windows open here, team ones go up later. */
  localMode?: boolean
  /** This computer may enter local mode now (an account signed in here before, the server unreachable). */
  canLocal?: boolean
  /** The team's servers: the one in use and its standby. */
  servers?: string[]
}

/** One of the team's servers as this computer sees it (服务器 page, avatar panel). */
export interface TeamServerView {
  url: string
  reachable: boolean
  role?: 'active' | 'standby'
  ready: boolean
  /** The owner's computer keeps its activation code, so 批量切换 needs no typing. */
  codeSaved: boolean
}

export interface TeamServerPair {
  /** The server this computer works with. */
  current: string
  servers: TeamServerView[]
}

/** Who holds a shared window right now. */
export interface TeamLockView {
  holderId: string
  holderName: string
  device: string
  expires: number
}

export interface TeamProfileView {
  id: string
  name: string
  note: string
  /** 序号 of the window on the computer that made it (the creator's numbering). */
  serialNumber?: number
  /** When that window was created. */
  createdAt: string
  /** Who created it: the owner account, or a member for their own windows. */
  ownerId: string
  assignees: string[]
  configRev: number
  dataRev: number
  /** Name of who uploaded the latest login state. */
  dataByName: string
  dataSize: number
  updated: string
  lock?: TeamLockView
  /** The window on this computer linked to it, if any. */
  localId?: string
  /** Deleted on this computer; the cloud keeps it and it is not pulled again by itself. */
  removedHere: boolean
  /** The owner's own window it was shared from (owner only). */
  sourceId: string
}

export interface TeamMemberDraft {
  username?: string
  name?: string
  password?: string
  disabled?: boolean
}

export interface TeamProfilePatch {
  name?: string
  note?: string
  assignees?: string[]
}

export interface TeamLogEntry {
  id: string
  created: string
  userName: string
  action: string
  profileName: string
  detail: Record<string, unknown>
  ip: string
}

export interface TeamLogQuery {
  page: number
  perPage: number
  userId?: string
  profileId?: string
  action?: string
}

export interface TeamLogPage {
  items: TeamLogEntry[]
  page: number
  totalItems: number
}

/** Login state transfer of one linked window, shown next to it while it runs. */
export interface TeamSyncEvent {
  profileId: string
  phase: 'pulling' | 'pushing' | 'done' | 'error'
  message?: string
}

/** One computer's cloud copy of a window's login state (each computer an account opens it on keeps one). */
export interface TeamDeviceStateView {
  id: string
  /** The computer's name when it last uploaded. */
  deviceName: string
  /** The first characters of the computer's fixed id (tells apart two computers with one name). */
  deviceShort: string
  /** The computer's system when it last uploaded (copies from older apps: none). */
  os?: string
  /** The account it belongs to. */
  userName: string
  /** This computer's own copy (this account, this computer). */
  thisComputer: boolean
  updated: string
  size: number
  rev: number
}

/** What the local window list needs to know about linked windows. */
export interface TeamLinkView {
  profileId: string
  teamId: string
  /** Members cannot change a team window on their computer. */
  readOnly: boolean
  /** An upload that failed and will be retried on the next open. */
  pendingUpload: boolean
}

/** The team server page (owner only). Sizes in bytes. */
export interface TeamServerInfo {
  version: string
  diskTotal: number
  diskFree: number
  /** All of the server's data folder, backups included. */
  dataSize: number
  /** Uploaded login states. */
  storageSize: number
  backupsSize: number
  members: number
  profiles: number
  locks: Array<{ profile: string; holder: string; device: string }>
  /** PocketBase's daily backup: cron in UTC and how many are kept. */
  autoBackup: { cron: string; keep: number }
  offsite?: TeamOffsite
}

/** Off-server copy to Cloudflare R2 after each change. Times in epoch milliseconds. */
export interface TeamOffsite {
  configured: boolean
  /** A change is waiting for the next run (within a minute). */
  pending: boolean
  bucket?: string
  endpoint?: string
  /** Shortened; the secret key never leaves the server. */
  accessKeyId?: string
  lastDb?: number
  lastFiles?: number
  lastError?: string
  lastErrorAt?: number
}

/** What R2 shows for a bucket ("S3 API" address) and its API token. */
export interface TeamOffsiteDraft {
  url: string
  accessKeyId: string
  secretAccessKey: string
}

/** One person's sign-up code, made by the owner; used once, valid 7 days. Times in epoch milliseconds. */
export interface TeamInvite {
  id: string
  /** Without dashes; shown as XXXX-XXXX-XXXX. */
  code: string
  note: string
  expires: number
  /** Who signed up with it; '' while unused. */
  usedName: string
  usedAt: number
  created: string
}

export interface TeamRegistration {
  code: string
  username: string
  name: string
  password: string
}

export interface TeamBackup {
  key: string
  size: number
  /** Epoch milliseconds. */
  modified: number
  /** Made by the daily schedule (the server keeps the last few); otherwise by hand. */
  auto: boolean
}
