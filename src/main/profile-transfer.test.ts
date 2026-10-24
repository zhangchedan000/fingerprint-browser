import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'
import { parseProfileConfig, serializeProfileConfig } from './profile-transfer'

function profile(): BrowserProfile {
  const draft = defaultProfileDraft()
  return {
    ...draft,
    proxy: { protocol: 'socks5', host: '203.0.113.9', port: 1080, username: 'proxy-user', password: 'proxy-secret' },
    account: { platform: 'TikTok Shop', username: 'shop@example.com', password: 'account-secret' },
    id: 'profile-1',
    groupId: '',
    proxyId: '',
    serialNumber: 1,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    favorite: false,
    status: 'closed'
  }
}

describe('profile config transfer', () => {
  it('exports the account login but never its password or the proxy password', () => {
    const text = serializeProfileConfig(profile())
    expect(text).not.toContain('account-secret')
    expect(text).not.toContain('proxy-secret')
    const imported = parseProfileConfig(text)
    expect(imported.account).toEqual({ platform: 'TikTok Shop', username: 'shop@example.com', password: '' })
  })

  it('imports files written before accounts existed', () => {
    const data = JSON.parse(serializeProfileConfig(profile()))
    delete data.profile.account
    expect(parseProfileConfig(JSON.stringify(data)).account).toEqual({ platform: '', username: '', password: '' })
  })
})
