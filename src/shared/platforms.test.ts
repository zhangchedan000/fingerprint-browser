import { describe, expect, it } from 'vitest'
import { PLATFORM_URLS, PLATFORMS, platformStartUrl } from './platforms'

describe('platform start pages', () => {
  it('lists every Amazon store and TikTok Shop market as its own seller site', () => {
    const amazon = PLATFORMS.find((item) => item.value === 'Amazon Seller')!.sites!
    // 23 stores in Amazon's list; the UK, Germany, France, Italy and Spain share the Europe site.
    expect(amazon).toHaveLength(19)
    expect(amazon.find((site) => site.region === 'EU')?.url).toBe('https://sellercentral-europe.amazon.com/')
    expect(amazon.find((site) => site.region === 'JP')?.url).toBe('https://sellercentral.amazon.co.jp/')
    const tiktok = PLATFORMS.find((item) => item.value === 'TikTok Shop')!.sites!
    expect(tiktok).toHaveLength(25)
    expect(tiktok.find((site) => site.region === 'GB')?.url).toBe('https://seller-uk.tiktok.com/')
    for (const site of [...amazon, ...tiktok]) expect(site.url).toMatch(/^https:\/\/[a-z0-9.-]+\/$/)
  })

  it('starts on the first site and knows every address it fills in', () => {
    expect(platformStartUrl('amazon seller')).toBe('https://sellercentral.amazon.com/')
    expect(PLATFORM_URLS.has('https://seller-mx.tiktok.com/')).toBe(true)
    expect(PLATFORM_URLS.has('https://example.com/')).toBe(false)
  })
})
