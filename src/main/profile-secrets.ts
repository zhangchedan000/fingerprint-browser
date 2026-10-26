import type { BrowserProfile, BrowserProfileView, GroupRecord, GroupRecordView, PlatformAccount, ProxyConfig, ProxyRecord, ProxyRecordView } from '../shared/types'
import { redactSensitiveText } from './redaction'

export function sameProxyIdentity(first: ProxyConfig, second: ProxyConfig): boolean {
  return first.protocol === second.protocol
    && first.host.trim() === second.host.trim()
    && first.port === second.port
    && first.username === second.username
}

export function privateProxyConfig(proxy: ProxyConfig): ProxyConfig {
  const { passwordStored: _passwordStored, ...privateConfig } = proxy
  return privateConfig
}

export function sameAccountIdentity(first: PlatformAccount, second: PlatformAccount): boolean {
  return first.platform === second.platform && first.username === second.username
}

export function privateAccount(account: PlatformAccount): PlatformAccount {
  const { passwordStored: _passwordStored, ...privateConfig } = account
  return privateConfig
}

export function publicProfile(profile: BrowserProfile): BrowserProfileView {
  return {
    ...profile,
    lastError: profile.lastError ? redactSensitiveText(profile.lastError) : undefined,
    tags: [...profile.tags],
    extensionIds: [...profile.extensionIds],
    startUrls: [...profile.startUrls],
    proxy: {
      ...profile.proxy,
      password: '',
      passwordStored: Boolean(profile.proxy.password)
    },
    account: {
      platform: profile.account.platform,
      username: profile.account.username,
      password: '',
      passwordStored: Boolean(profile.account.password)
    },
    fingerprint: {
      ...profile.fingerprint,
      disabledSpoofing: [...profile.fingerprint.disabledSpoofing]
    }
  }
}

/** Typed-in proxy settings to test; an empty password with passwordStored uses the saved one. */
export function proxyForTest(input: ProxyConfig, saved?: ProxyConfig): ProxyConfig {
  const candidate = privateProxyConfig(input)
  if (candidate.password || !input.passwordStored || !saved || !sameProxyIdentity(candidate, saved)) return candidate
  return { ...candidate, password: saved.password }
}

/** A library proxy as the UI sees it: no password, plus the windows that use it. */
export function publicProxyRecord(proxy: ProxyRecord, profiles: Array<Pick<BrowserProfile, 'id' | 'proxyId'>>): ProxyRecordView {
  return {
    ...proxy,
    check: proxy.check ? { ...proxy.check } : undefined,
    password: '',
    passwordStored: Boolean(proxy.password),
    profileIds: profiles.filter((profile) => profile.proxyId === proxy.id).map((profile) => profile.id)
  }
}

export function publicGroupRecord(group: GroupRecord, profiles: Array<Pick<BrowserProfile, 'groupId'>>): GroupRecordView {
  return { ...group, profileCount: profiles.filter((profile) => profile.groupId === group.id).length }
}
