import { describe, expect, it } from 'vitest'
import { DEFAULT_DEEP_CHECK_SITES, knownDeepSite, pageStillLoading, parseDeepSite, scoreLines, validDeepCheckSites } from './deep-check'

// Page text as the sites showed it (tools/kernel-smoke BISECT=sites, and a user's iphey result).
const IPHEY_LOADING = 'Your Digital Identity Looks\n\nBROWSER\n\nTemporary value\n\nHARDWARE\n\nTemporary value\n\n0\nMX SCORE'
const IPHEY = 'Your Digital Identity Looks\nTrustworthy\nBROWSER\n\nChrome\n\nLOCATION\n\nFrance\n\nIP ADDRESS\n\n200.36.26.36\n\nHARDWARE\n\nEverything is fine\n\nSOFTWARE\n\nEverything is fine\n\n100\nMX SCORE'
const BROWSERSCAN = 'Bot Detection:\nNoDetection\nBrowser fingerprint authenticity: 90%\nUnexpand\nDifferent time zones\n-10%\n\nYour IP timezone does not match your local timezone.'
const PIXELSCAN = 'Fingerprint Scan\nRestart\n\nYour Browser Fingerprint is inconsistent\n\nHow to Fix it?\n\nChrome 144.0.0.0 on Windows\n\nBrowser\n\nCheck Geo API\n\nTimezone spoofed\n\nLocation\n\nProxy detected\n\nProxy\n\nBest proxy providers\n\nMasking detected\n\nFingerprint\n\nBest antidetect browsers\n\nNo automated behavior detected\n\nBot check'
// Pixelscan while it scans (10-30, prism13 on the Windows 11 computer): its FAQ further down already says "fingerprint is consistent".
const PIXELSCAN_FAQ = '\n\nHow can I tell if my fingerprint is consistent across sessions using Pixelscan?\nRun the same profile through Pixelscan multiple times without changing settings. If key values like canvas hash, WebGL, and timezone stay the same, your fingerprint is consistent.'
const PIXELSCAN_SCANNING = 'Fingerprint Scan\nYour Browser Fingerprint is scanning…\nCollecting Data…\nBrowser\nCheck Geo API\nLocation\nProxy\nFingerprint\nBot check' + PIXELSCAN_FAQ
// Fingerprint.com playground, real Google Chrome on a cloud Windows Server 2022 (2026-11-07), cut down to the read parts.
const FPCOM = 'Browser Tampering\t\nNot detected\n\nSuspect Score\t\n17\nServer API Response\n{\nevent_id: "1794048085382.y2WCoQ"\nbot: "not_detected"\ndeveloper_tools: false\nip_blocklist: {\nemail_spam: false\nattack_source: false\ntor_node: false\n}\nproxy: true\nproxy_confidence: "medium"\nproxy_details: {\nproxy_type: "data_center"\nlast_seen_at: 1793602800000\nprovider: "DataImpulse data center proxies"\n}\nproxy_ml_score: 0.281\nincognito: false\nprivacy_settings: false\nsuspect_score: 17\ntampering: false\ntampering_confidence: "high"\ntampering_ml_score: 0.0899\ntampering_details: {\nanomaly_score: 0\nanti_detect_browser: false\n}\nvirtual_machine: true\nvirtual_machine_ml_score: 1\nvpn: false\nvpn_methods: {\ntimezone_mismatch: false\npublic_vpn: false\nos_mismatch: false\nrelay: false\nml_prediction: false\n}\nhigh_activity_device: false\nrare_device: false\nraw_device_attributes: {'
// whoer.net (11-07, v0.5.78 windows; addresses replaced): a US node an hour off, a Mexico proxy whose DNS is in Italy, a Hong Kong one.
const WHOER_EN = 'My IP: 203.0.113.9\nDraper / United States\nAccsBulk: Buy Social Media Accounts\nSecure internet\nISP:\nFiberState\nDNS\n198.51.100.6521  United States\nHostname:\nN/A\nOS:\nWin10.0\nBrowser:\nChrome 156.0 Check fingerprint\nProxy:\nNo\nAnonymizer:\nNo\nBlacklist:\nNo\nYour disguise: 90% Minor remarks regarding your anonymity and security\nTIME\nZone:\nAmerica/Denver\nLocal:\nSat Nov 7 2026 05:31:02 GMT-0700 (MST)\nSystem:\nSat Nov 07 2026 04:31:02 GMT-0800 (Pacific Standard Time)'
const WHOER_ES = 'Mi IP: 203.0.113.10\nCiudad de México / México\nPlataforma de cuentas\nInternet seguro\nISP:\nPodernet, S.A. de C.V.\nDNS\n198.51.100.78  Italia\nNombre de host:\nN/A\nOS:\nWin10.0\nNavegador:\nChrome 156.0 Comprobar fingerprint\nProxy:\nNo\nObtener proxy\nAnonimizador:\nNo\nLa lista negra:\nNo\nSu disfraz: 70% Observaciones moderadas de la seguridad y el anonimato\nTIEMPO\nZona:\nAmerica/Mexico_City\nLocal:\nSat Nov 7 2026 06:31:02 GMT-0600 (CST)\nSistema:\nSat Nov 07 2026 06:31:02 GMT-0600 (hora estándar central)'
const WHOER_ZH = '我的IP: 203.0.113.11\n香港\n安全上網\n提供商:\nBitsflowcloud\nDNS\n198.51.100.13  香港\n主机:\nN/A\n操作系统:\nWin10.0\n浏览器:\nChrome 155.0 检查浏览器指纹\n代理服务器:\n是\n获取代理服务器\n匿名服务:\n不\n黑色名单:\n不\n你的伪装: 100% 您使用可靠的或不使用匿名手段。'
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

  it('reads Fingerprint.com tampering scores and the flagged signals by its own thresholds', () => {
    const url = 'https://demo.fingerprint.com/playground'
    expect(parseDeepSite(url, 'Fingerprint Playground\nAnalyze my browser again')).toBeUndefined()
    expect(parseDeepSite(url, FPCOM)).toEqual({
      status: 'warn',
      score: '0.0899',
      findings: ['tampering: false', 'tampering_ml_score: 0.0899', 'anomaly_score: 0', 'suspect_score: 17', 'proxy: data_center (DataImpulse data center proxies)', 'virtual_machine: true']
    })
    const clean = FPCOM.replace('proxy: true', 'proxy: false').replace('virtual_machine: true', 'virtual_machine: false')
    expect(parseDeepSite(url, clean)?.status).toBe('ok')
    // Over Fingerprint's 0.8 (0.9721 is its docs' example; a Singapore residential IP gave 0.97 on 11-07): an anti-detect browser.
    const flagged = clean.replace('tampering: false', 'tampering: true').replace('tampering_ml_score: 0.0899', 'tampering_ml_score: 0.9721')
      .replace('anti_detect_browser: false', 'anti_detect_browser: true').replace('vpn: false', 'vpn: true').replace('timezone_mismatch: false', 'timezone_mismatch: true')
    expect(parseDeepSite(url, flagged)).toEqual({
      status: 'bad',
      score: '0.9721',
      findings: ['tampering: true', 'tampering_ml_score: 0.9721', 'anomaly_score: 0', 'suspect_score: 17', 'vpn: timezone_mismatch']
    })
    // Anomalous alone (above 0.5) is a verdict too.
    expect(parseDeepSite(url, clean.replace('anomaly_score: 0', 'anomaly_score: 0.62'))?.status).toBe('bad')
  })

  it('reads whoer: the score, the DNS country against the IP\'s, the clock, and yes/no rows in any page language', () => {
    expect(parseDeepSite('https://whoer.net/', 'My IP: 203.0.113.9\nDNS\nloading')).toBeUndefined()
    expect(parseDeepSite('https://whoer.net/', WHOER_EN)).toEqual({ status: 'warn', score: '90%', findings: ['DNS: United States', 'Time zone: IP GMT-0700 ≠ browser GMT-0800'] })
    expect(parseDeepSite('https://whoer.net/', WHOER_ES)).toEqual({ status: 'warn', score: '70%', findings: ['DNS: Italia ≠ IP: México'] })
    // A proxy row answered yes (here made up on the Chinese page).
    expect(parseDeepSite('https://whoer.net/', WHOER_ZH)).toEqual({ status: 'ok', score: '100%', findings: ['DNS: 香港', 'Proxy: 代理服务器 是'] })
    expect(knownDeepSite('https://whoer.net/')?.site).toBe('whoer')
  })

  it('shows the score lines of a site the user added, and waits while its score is still N/A', () => {
    expect(scoreLines(WHOER_ES)).toEqual(['Su disfraz: 70% Observaciones moderadas de la seguridad y el anonimato'])
    expect(scoreLines('Fraud Score: 12\nRisk level low\nTrust score 87 / 100\nA long paragraph about how we compute a score for 99% of visitors and why it matters for everyone who reads this page today.'))
      .toEqual(['Fraud Score: 12', 'Trust score 87 / 100'])
    expect(pageStillLoading('我的IP: 203.0.113.11\nDNS\nN/A\n你的伪装: N/A N/A')).toBe(true)
    expect(pageStillLoading('Mi IP: 203.0.113.10\nDNS\nNombre de host:\nN/A')).toBe(true)
    expect(pageStillLoading(WHOER_ES)).toBe(false)
  })

  it('knows a page is still filling in', () => {
    expect(pageStillLoading('IP\n---.---.---.---\n--/--\nBrowser fingerprint authenticity: 100%')).toBe(true)
    expect(pageStillLoading(IPHEY_LOADING)).toBe(true)
    expect(pageStillLoading(BROWSERSCAN)).toBe(false)
    expect(pageStillLoading(IPHEY)).toBe(false)
    // CreepJS before its hashes are done (10-30).
    expect(pageStillLoading('FP ID: Computing...\nFuzzy: 0000\n0 ms\nWebRTC')).toBe(true)
    expect(pageStillLoading(CREEPJS)).toBe(false)
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
    expect(DEFAULT_DEEP_CHECK_SITES.map((site) => site.id)).toEqual(['iphey', 'browserscan', 'pixelscan', 'creepjs', 'fpcom', 'whoer'])
  })
})
