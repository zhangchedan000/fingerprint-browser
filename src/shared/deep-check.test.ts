import { describe, expect, it } from 'vitest'
import { pageStillLoading, parseDeepSite } from './deep-check'

// Page text as the sites showed it (tools/kernel-smoke BISECT=sites, and a user's iphey result).
const IPHEY_LOADING = 'Your Digital Identity Looks\n\nBROWSER\n\nTemporary value\n\nHARDWARE\n\nTemporary value\n\n0\nMX SCORE'
const IPHEY = 'Your Digital Identity Looks\nTrustworthy\nBROWSER\n\nChrome\n\nLOCATION\n\nFrance\n\nIP ADDRESS\n\n200.36.26.36\n\nHARDWARE\n\nEverything is fine\n\nSOFTWARE\n\nEverything is fine\n\n100\nMX SCORE'
const BROWSERSCAN = 'Bot Detection:\nNoDetection\nBrowser fingerprint authenticity: 90%\nUnexpand\nDifferent time zones\n-10%\n\nYour IP timezone does not match your local timezone.'
const PIXELSCAN = 'Fingerprint Scan\nRestart\n\nYour Browser Fingerprint is inconsistent\n\nHow to Fix it?\n\nChrome 144.0.0.0 on Windows\n\nBrowser\n\nCheck Geo API\n\nTimezone spoofed\n\nLocation\n\nProxy detected\n\nProxy\n\nBest proxy providers\n\nMasking detected\n\nFingerprint\n\nBest antidetect browsers\n\nNo automated behavior detected\n\nBot check'
const CREEPJS = 'Headless543e3565\nchromium: true\n25% like headless: fafdf9d1\n0% headless: 52defe05\n0% stealth: 295d4148'

describe('deep check parsers', () => {
  it('waits for iphey to finish, then reads its score and verdict', () => {
    expect(parseDeepSite('iphey', IPHEY_LOADING)).toBeUndefined()
    expect(parseDeepSite('iphey', IPHEY)).toEqual({ status: 'ok', score: '100', findings: ['Looks Trustworthy'] })
    expect(parseDeepSite('iphey', IPHEY.replace('Trustworthy', 'Unreliable').replace('100\nMX', '90\nMX'))).toEqual({
      status: 'warn', score: '90', findings: ['Looks Unreliable', 'LOCATION: France', 'IP ADDRESS: 200.36.26.36']
    })
  })

  it('reads BrowserScan authenticity and each deduction', () => {
    expect(parseDeepSite('browserscan', BROWSERSCAN)).toEqual({ status: 'warn', score: '90%', findings: ['Different time zones -10%'] })
    expect(parseDeepSite('browserscan', 'loading…')).toBeUndefined()
  })

  it('reads Pixelscan consistency and the flagged checks', () => {
    expect(parseDeepSite('pixelscan', PIXELSCAN)).toEqual({
      status: 'bad',
      findings: ['Fingerprint is inconsistent', 'Location: Timezone spoofed', 'Proxy: Proxy detected', 'Fingerprint: Masking detected']
    })
  })

  it('reads CreepJS headless and stealth ratings', () => {
    expect(parseDeepSite('creepjs', CREEPJS)).toEqual({ status: 'ok', score: '25% / 0% / 0%', findings: ['0% headless', '25% like headless', '0% stealth'] })
  })

  it('knows a page is still filling in', () => {
    expect(pageStillLoading('IP\n---.---.---.---\n--/--\nBrowser fingerprint authenticity: 100%')).toBe(true)
    expect(pageStillLoading(IPHEY_LOADING)).toBe(true)
    expect(pageStillLoading(BROWSERSCAN)).toBe(false)
    expect(pageStillLoading(IPHEY)).toBe(false)
  })
})
