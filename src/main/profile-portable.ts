import type { BrowserProfile, ProfileDraft } from '../shared/types'

export interface PortableDraftOptions {
  /** 'strip' for files that leave the encrypted vault (config export, data backup). */
  passwords: 'keep' | 'strip'
  /** Extension ids only mean something on this computer or inside a migration package. */
  extensions: boolean
}

/**
 * The one place that turns a window back into the draft it can be recreated from.
 * Duplicate, config export, data backup and workspace migration all use it, so a new
 * window field only has to be added here once.
 *
 * The proxy and group are written out by value (not by id) because the other side
 * has its own libraries; creating a window from the draft puts them back into the library.
 */
export function portableDraft(profile: BrowserProfile, options: PortableDraftOptions): ProfileDraft {
  const strip = options.passwords === 'strip'
  return {
    name: profile.name,
    note: profile.note,
    group: profile.group,
    tags: [...profile.tags],
    extensionIds: options.extensions ? [...profile.extensionIds] : [],
    color: profile.color,
    startUrls: [...profile.startUrls],
    kernelVersion: profile.kernelVersion,
    window: { ...profile.window },
    proxy: strip
      ? { protocol: profile.proxy.protocol, host: profile.proxy.host, port: profile.proxy.port, username: profile.proxy.username, password: '' }
      : { protocol: profile.proxy.protocol, host: profile.proxy.host, port: profile.proxy.port, username: profile.proxy.username, password: profile.proxy.password },
    account: {
      platform: profile.account.platform,
      username: profile.account.username,
      password: strip ? '' : profile.account.password
    },
    fingerprint: { ...profile.fingerprint, disabledSpoofing: [...profile.fingerprint.disabledSpoofing] }
  }
}
