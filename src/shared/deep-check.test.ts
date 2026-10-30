import { describe, expect, it } from 'vitest'
import { DEFAULT_DEEP_CHECK_SITES, knownDeepSite, pageStillLoading, parseDeepSite, validDeepCheckSites } from './deep-check'

// Page text as the sites showed it (tools/kernel-smoke BISECT=sites, and a user's iphey result).
const IPHEY_LOADING = 'Your Digital Identity Looks\n\nBROWSER\n\nTemporary value\n\nHARDWARE\n\nTemporary value\n\n0\nMX SCORE'
const IPHEY = 'Your Digital Identity Looks\nTrustworthy\nBROWSER\n\nChrome\n\nLOCATION\n\nFrance\n\nIP ADDRESS\n\n200.36.26.36\n\nHARDWARE\n\nEverything is fine\n\nSOFTWARE\n\nEverything is fine\n\n100\nMX SCORE'
const BROWSERSCAN = 'Bot Detection:\nNoDetection\nBrowser fingerprint authenticity: 90%\nUnexpand\nDifferent time zones\n-10%\n\nYour IP timezone does not match your local timezone.'
const PIXELSCAN = 'Fingerprint Scan\nRestart\n\nYour Browser Fingerprint is inconsistent\n\nHow to Fix it?\n\nChrome 144.0.0.0 on Windows\n\nBrowser\n\nCheck Geo API\n\nTimezone spoofed\n\nLocation\n\nProxy detected\n\nProxy\n\nBest proxy providers\n\nMasking detected\n\nFingerprint\n\nBest antidetect browsers\n\nNo automated behavior detected\n\nBot check'
// Pixelscan while it scans (10-30, prism13 on the Windows 11 computer): its FAQ further down already says "fingerprint is consistent".
const PIXELSCAN_FAQ = '\n\nHow can I tell if my fingerprint is consistent across sessions using Pixelscan?\nRun the same profile through Pixelscan multiple times without changing settings. If key values like canvas hash, WebGL, and timezone stay the same, your fingerprint is consistent.'
const PIXELSCAN_SCANNING = 'Fingerprint Scan\nYour Browser Fingerprint is scanning…\nCollecting Data…\nBrowser\nCheck Geo API\nLocation\nProxy\nFingerprint\nBot check' + PIXELSCAN_FAQ
const CREEPJS = 'Headless543e3565\nchromium: true\n25% like headless: fafdf9d1\n0% headless: 52defe05\n0% stealth: 295d4148'

describe('deep check parsers', () => {
  it('waits for iphey to finish, then reads its score and verdict', () => {
    expect(parseDeepSite('https://iphey.com/', IPHEY_LOADING)).toBeUndefined()
    expect(parseDeepSite('https://iphey.com/', IPHEY)).toEqual({ status: 'ok', score: '100', findings: ['Looks Trustworthy'] })
    expect(parseDeepSite('https://iphey.com/', IPHEY.replace('Trustworthy', 'Unreliable').replace('100\nMX', '90\nMX'))).toEqual({
      status: 'warn', score: '90', findings: ['Looks Unreliable', 'LOCATION: France', 'IP ADDRESS: 200.36.26.36']
    })
  })

  it('reads BrowserScan authenticity and each deduction', () => {
    expect(parseDeepSite('https://www.browserscan.net/', BROWSERSCAN)).toEqual({ status: 'warn', score: '90%', findings: ['Different time zones -10%'] })
    expect(parseDeepSite('https://www.browserscan.net/', 'loading…')).toBeUndefined()
  })

  it('reads Pixelscan consistency and the flagged checks', () => {
    // Not its FAQ while the scan still runs, which made the screenshot early and the verdict "consistent".
    expect(parseDeepSite('https://pixelscan.net/fingerprint-check', PIXELSCAN_SCANNING)).toBeUndefined()
    expect(pageStillLoading(PIXELSCAN_SCANNING)).toBe(true)
    expect(pageStillLoading(PIXELSCAN + PIXELSCAN_FAQ)).toBe(false)
    expect(parseDeepSite('https://pixelscan.net/fingerprint-check', PIXELSCAN + PIXELSCAN_FAQ)).toEqual({
      status: 'bad',
      findings: ['Fingerprint is inconsistent', 'Location: Timezone spoofed', 'Proxy: Proxy detected', 'Fingerprint: Masking detected']
    })
    expect(parseDeepSite('https://pixelscan.net/fingerprint-check', PIXELSCAN)).toEqual({
      status: 'bad',
      findings: ['Fingerprint is inconsistent', 'Location: Timezone spoofed', 'Proxy: Proxy detected', 'Fingerprint: Masking detected']
    })
  })

  it('reads CreepJS headless and stealth ratings', () => {
    expect(parseDeepSite('https://abrahamjuliot.github.io/creepjs/', CREEPJS)).toEqual({ status: 'ok', score: '25% / 0% / 0%', findings: ['0% headless', '25% like headless', '0% stealth'] })
  })

  it('knows a page is still filling in', () => {
    expect(pageStillLoading('IP\n---.---.---.---\n--/--\nBrowser fingerprint authenticity: 100%')).toBe(true)
    expect(pageStillLoading(IPHEY_LOADING)).toBe(true)
    expect(pageStillLoading(BROWSERSCAN)).toBe(false)
    expect(pageStillLoading(IPHEY)).toBe(false)
  })

  it('reads verdicts only from the built-in sites, wherever on them', () => {
    expect(knownDeepSite('https://browserscan.net/zh')?.site).toBe('browserscan')
    expect(knownDeepSite('https://pixelscan.net/')?.site).toBe('pixelscan')
    expect(knownDeepSite('https://abrahamjuliot.github.io/creepjs/tests/x.html')?.site).toBe('creepjs')
    expect(knownDeepSite('https://someone.github.io/creepjs/')).toBeUndefined()
    expect(parseDeepSite('https://browserleaks.com/', 'anything')).toBeUndefined()
  })

  it('keeps only usable sites in the user list', () => {
    expect(validDeepCheckSites(undefined)).toBeUndefined()
    expect(validDeepCheckSites([
      { id: 'a', name: ' Leaks ', url: 'https://browserleaks.com/', enabled: false },
      { id: 'a', name: 'dup', url: 'https://x.com/' },
      { id: 'b', name: 'bad', url: 'file:///c:/x' },
      { id: 'c', name: '', url: 'https://x.com/' }
    ])).toEqual([{ id: 'a', name: 'Leaks', url: 'https://browserleaks.com/', enabled: false }])
    expect(DEFAULT_DEEP_CHECK_SITES.map((site) => site.id)).toEqual(['iphey', 'browserscan', 'pixelscan', 'creepjs'])
  })
})
