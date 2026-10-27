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

export interface TeamStatus {
  /** The server address saved on this computer; '' before the first connection. */
  server: string
  /** Signed in as; undefined when signed out. The app is only usable signed in. */
  user?: TeamUser
  /** The saved sign-in could not be checked because the server was unreachable. */
  offline?: string
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

/** What the local window list needs to know about linked windows. */
export interface TeamLinkView {
  profileId: string
  teamId: string
  /** Members cannot change a team window on their computer. */
  readOnly: boolean
  /** An upload that failed and will be retried on the next open. */
  pendingUpload: boolean
}
