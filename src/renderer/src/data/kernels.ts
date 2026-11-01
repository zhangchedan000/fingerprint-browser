import type { BrowserProfileView } from '../../../shared/types'

/** Windows that run on a kernel: pinned to it, or following the default while it is the default. */
export function kernelUsers(profiles: BrowserProfileView[], version: string, defaultVersion?: string): BrowserProfileView[] {
  return profiles.filter((profile) => profile.kernelVersion === version || (!profile.kernelVersion && version === defaultVersion))
}
