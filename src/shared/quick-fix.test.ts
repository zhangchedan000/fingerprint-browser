import { describe, expect, it } from 'vitest'
import { screenSuitsGpu } from './hardware-match'
import { gpuChoices } from './hardware-profiles'
import { localeForCountry } from './network-identity'
import { fittingCountryZone, ipZoneFix, ipZoneMismatch, ipZoneOnComputer, languageFitsCountry, usualScreenFor, zoneInCountry } from './quick-fix'
import { screenChoices } from './screen'
import { COUNTRY_ZONES } from './windows-time-zones-data'
import { countryWindowsZones, windowsCountries } from './windows-time-zones'

/** The one-click fixes must leave nothing to point out and set values a real computer has. */
describe('one-click fix values', () => {
  const countries = windowsCountries()

  it('gives every country a zone of its own, the usual one (the capital, never the westmost)', () => {
    expect(countries.length).toBeGreaterThan(200)
    for (const country of countries) {
      const zone = fittingCountryZone(country)
      // A zone the editor lists for the country: the 时区不在这个国家 note is gone once it is set.
      expect(countryWindowsZones(country, 'en').map((item) => item.iana), country).toContain(zone)
    }
    expect(fittingCountryZone('US')).toBe('America/New_York')
    expect(fittingCountryZone('CA')).toBe('America/Toronto')
    expect(fittingCountryZone('AU')).toBe('Australia/Sydney')
    expect(fittingCountryZone('BR')).toBe('America/Sao_Paulo')
    expect(fittingCountryZone('RU')).toBe('Europe/Moscow')
    expect(fittingCountryZone('MX')).toBe('America/Mexico_City')
  })

  it('keeps the IP\'s own zone when the IP is in the country, as that country\'s Windows reports it', () => {
    for (const country of countries) {
      for (const [, zone] of COUNTRY_ZONES[country]) {
        expect(fittingCountryZone(country, zone), `${country} ${zone}`).toBe(zone)
      }
    }
    // An IP elsewhere: the country's usual zone, not the IP's.
    expect(fittingCountryZone('US', 'Europe/Berlin')).toBe('America/New_York')
  })

  it('turns an IP database zone into the one Chrome on Windows reports, inside the IP\'s country', () => {
    expect(ipZoneOnComputer('America/Detroit', 'US', 'windows')).toBe('America/New_York')
    expect(ipZoneOnComputer('America/Chicago', 'US', 'windows')).toBe('America/Chicago')
    expect(ipZoneOnComputer('Asia/Calcutta', 'IN', 'windows')).toBe(fittingCountryZone('IN'))
    expect(ipZoneOnComputer('America/Detroit', 'US', 'macos')).toBe('America/Detroit')
    // Every id the IP databases give (IANA), in every country it belongs to: a zone that country's Windows has.
    const unknown: string[] = []
    for (const country of countries) {
      for (const [, zone] of COUNTRY_ZONES[country]) {
        const shown = ipZoneOnComputer(zone, country, 'windows')
        if (!zoneInCountry(shown, country)) unknown.push(`${country} ${zone} → ${shown}`)
      }
    }
    expect(unknown).toEqual([])
    // Of every IANA id, only Antarctica/Troll has no Windows zone: no fix is offered for it.
    const uncovered = Intl.supportedValuesOf('timeZone').filter((zone) => !ipZoneFix(zone, undefined, 'windows'))
    expect(uncovered).toEqual(['Antarctica/Troll'])
    expect(ipZoneFix('America/Detroit', 'US', 'windows')).toBe('America/New_York')
    expect(ipZoneFix('America/Detroit', 'US', 'macos')).toBe('America/Detroit')
  })

  it('sets a language people in the country use, so the 语言和国家对不上 note is gone', () => {
    let checked = 0
    for (const country of countries) {
      const usual = localeForCountry(country)
      if (!usual) continue
      checked += 1
      expect(languageFitsCountry(usual.language, country), `${country} ${usual.language}`).toBe(true)
    }
    expect(checked).toBeGreaterThan(150)
    expect(languageFitsCountry('fr-CA', 'CA')).toBe(true)
    expect(languageFitsCountry('ja-JP', 'US')).toBe(false)
  })

  it('offers only sizes the card usually has, from the sizes the editor lists', () => {
    for (const platform of ['windows', 'macos'] as const) {
      for (const gpu of gpuChoices(platform)) {
        for (const scale of [1, 1.25, 1.5, 2]) {
          const choices = screenChoices(undefined, scale)
          const usual = usualScreenFor(gpu.model, choices)
          if (!usual) continue
          expect(choices).toContain(usual)
          expect(screenSuitsGpu(gpu.model, usual.physical), `${gpu.model} @${scale}`).toBe(true)
        }
      }
    }
  })
})

describe('time zone against the IP in the same country', () => {
  const ip = (timezone: string, countryCode = 'US') => ({ ok: true, timezone, countryCode })

  it('points out a Washington IP for a Central-time window, with the zone to set', () => {
    // A user's API window: made with a Texas IP, its new IP is in Kennewick, WA.
    expect(ipZoneMismatch('America/Chicago', 'US', ip('America/Los_Angeles'), 'windows')).toBe('America/Los_Angeles')
  })

  it('is quiet when Windows reports both as one zone (Detroit is New York there)', () => {
    expect(ipZoneMismatch('America/New_York', 'US', ip('America/Detroit'), 'windows')).toBeUndefined()
    expect(ipZoneMismatch('America/Chicago', 'US', ip('America/Chicago'), 'windows')).toBeUndefined()
  })

  it('leaves another country, a failed check and disagreeing databases to their own warnings', () => {
    expect(ipZoneMismatch('America/Chicago', 'US', ip('Europe/Berlin', 'DE'), 'windows')).toBeUndefined()
    expect(ipZoneMismatch('America/Chicago', 'US', { ok: false }, 'windows')).toBeUndefined()
    expect(ipZoneMismatch('America/Chicago', 'US', { ...ip('America/Los_Angeles'), geoConfidence: 'conflict' }, 'windows')).toBeUndefined()
    expect(ipZoneMismatch(undefined, 'US', ip('America/Los_Angeles'), 'windows')).toBeUndefined()
  })

  it('the zone it names is one the fix can set', () => {
    for (const [country, zones] of Object.entries(COUNTRY_ZONES)) {
      for (const [, iana] of zones) {
        const named = ipZoneMismatch('Etc/UTC', country, ip(iana, country), 'windows')
        if (named) expect(ipZoneFix(iana, country, 'windows')).toBe(named)
      }
    }
  })
})
