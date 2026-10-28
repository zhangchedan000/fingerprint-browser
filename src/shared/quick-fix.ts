import { localeForCountry } from './network-identity'
import { screenSuitsGpu } from './hardware-match'
import type { ScreenChoice } from './screen'
import { COUNTRY_ZONES } from './windows-time-zones-data'
import { defaultCountryZone, windowsReportedZone } from './windows-time-zones'

/**
 * The values the editor's one-click fixes set. Each must leave nothing to point out afterwards and
 * be a value a real computer has; quick-fix.test.ts goes through every country, zone and card.
 */

const samePrimary = (first: string, second: string) => first.split('-')[0].toLowerCase() === second.split('-')[0].toLowerCase()

/**
 * The zone an IP's time zone is on a Windows computer in that country: Chrome there reports the
 * id of the Windows zone (an IP in Detroit is America/New_York). Other systems keep the IP's id.
 */
export function ipZoneOnComputer(ipZone: string, country: string | undefined, platform: string): string {
  return (platform === 'windows' ? windowsReportedZone(ipZone, country) : undefined) ?? ipZone
}

/**
 * The zone a fix sets for an IP's zone: as the computer reports it, or none when no Windows zone
 * covers it (Antarctica/Troll is the one IANA id without) — a value no real Windows has is never set.
 */
export function ipZoneFix(ipZone: string, country: string | undefined, platform: string): string | undefined {
  return platform === 'windows' ? windowsReportedZone(ipZone, country) : ipZone
}

/** Whether a Windows computer in this country can have this zone. */
export function zoneInCountry(zone: string, country: string): boolean {
  return (COUNTRY_ZONES[country.toUpperCase()] ?? []).some(([, iana]) => iana === zone)
}

/**
 * The zone for a window in `country`: the IP's own when the IP is in that country, else the zone
 * a computer there most often has (the capital's, e.g. New York for the US, never the list's first).
 */
export function fittingCountryZone(country: string, ipZone?: string): string | undefined {
  const fromIp = ipZone ? windowsReportedZone(ipZone, country) : undefined
  if (fromIp && zoneInCountry(fromIp, country)) return fromIp
  return defaultCountryZone(country)
}

/** Whether a browser language is one people in this country use (its main language, or a variant for it). */
export function languageFitsCountry(language: string, country: string): boolean {
  const usual = localeForCountry(country)
  if (!usual || !language) return true
  return samePrimary(language, usual.language) || language.split('-')[1]?.toUpperCase() === country.toUpperCase()
}

/** A size desktops with this card usually have, from the sizes offered (the first such). */
export function usualScreenFor(gpuModel: string, choices: ScreenChoice[]): ScreenChoice | undefined {
  return choices.find((choice) => screenSuitsGpu(gpuModel, choice.physical))
}
