import { describe, expect, it } from 'vitest'
import { countryWindowsZones, defaultCountryZone, windowsReportedZone, windowsZoneLabel } from './windows-time-zones'

describe('Windows time zones', () => {
  it('reports the id Windows Chrome reports for the zone and country', () => {
    expect(windowsReportedZone('America/Detroit', 'US')).toBe('America/New_York')
    expect(windowsReportedZone('America/New_York', 'CA')).toBe('America/Toronto')
    expect(windowsReportedZone('Asia/Kolkata', 'IN')).toBe('Asia/Calcutta')
    expect(windowsReportedZone('Europe/Kyiv')).toBe('Europe/Kiev')
    expect(windowsReportedZone('Asia/Chongqing', 'CN')).toBe('Asia/Shanghai')
    expect(windowsReportedZone('Asia/Hong_Kong', 'HK')).toBe('Asia/Hong_Kong')
    expect(windowsReportedZone('Mars/Olympus')).toBeUndefined()
  })

  it('starts a country on its primary zone or its capital', () => {
    expect(defaultCountryZone('US')).toBe('America/New_York')
    expect(defaultCountryZone('CN')).toBe('Asia/Shanghai')
    expect(defaultCountryZone('JP')).toBe('Asia/Tokyo')
    expect(defaultCountryZone('RU')).toBe('Europe/Moscow')
    expect(defaultCountryZone('ZZ')).toBeUndefined()
  })

  it('names zones the way Windows lists them', () => {
    expect(windowsZoneLabel('America/New_York', 'en')).toBe('(UTC-05:00) Eastern Time (US & Canada) · America/New_York')
    expect(windowsZoneLabel('Asia/Shanghai', 'zh-CN')).toBe('(UTC+08:00) 北京，重庆，香港特别行政区，乌鲁木齐 · Asia/Shanghai')
    const us = countryWindowsZones('US', 'en')
    expect(us[0].iana).toBe('America/Adak')
    expect(us.map((zone) => zone.iana)).toContain('America/Phoenix')
  })
})
