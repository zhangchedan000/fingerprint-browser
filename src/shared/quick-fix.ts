import { localeForCountry } from './network-identity'
import { screenIsCommon, type ScreenChoice } from './screen'
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

/**
 * The IP's zone (as this computer reports it) when the IP is in the window's country but its clock
 * is another zone's — a Washington IP for a Central-time window. Undefined when they agree, when
 * the IP is in another country (that has its own warning) or when the databases disagree with no
 * zone for the window's country. When the databases named several countries, the zone the ones
 * naming the window's country gave counts (11-07: a Los Angeles IP left a window on New York unwarned).
 */
export function ipZoneMismatch(
  windowZone: string | undefined,
  region: string | undefined,
  check: { ok: boolean; timezone?: string; countryCode?: string; geoConfidence?: string; rotating?: boolean; countryVotes?: Array<{ countryCode: string; timezone?: string }> } | null | undefined,
  platform: string
): string | undefined {
  if (!windowZone || !region || !check?.ok || !check.timezone || !check.countryCode) return undefined
  // The check's own country; else another the databases named (picked in the editor), never a rotating IP's.
  const own = check.geoConfidence !== 'conflict' && check.countryCode.toUpperCase() === region.toUpperCase()
    ? { countryCode: check.countryCode, timezone: check.timezone }
    : check.rotating ? undefined : check.countryVotes?.find((vote) => vote.countryCode.toUpperCase() === region.toUpperCase() && vote.timezone)
  if (!own?.timezone) return undefined
  const ipZone = ipZoneOnComputer(own.timezone, own.countryCode, platform)
  return ipZone !== ipZoneOnComputer(windowZone, region, platform) ? ipZone : undefined
}

/**
 * Whether the checked IP is in this country by the check, or by one of the databases that named
 * another one (a country switched to in the editor). A rotating proxy's other answers do not count.
 */
export function ipNamesCountry(check: { countryCode?: string; rotating?: boolean; countryVotes?: Array<{ countryCode: string }> } | null | undefined, country: string): boolean {
  if (!check?.countryCode) return false
  const code = country.toUpperCase()
  return check.countryCode.toUpperCase() === code || (!check.rotating && Boolean(check.countryVotes?.some((vote) => vote.countryCode.toUpperCase() === code)))
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

/** A size most computers have (screenIsCommon), from the sizes offered (the first such). */
export function usualScreenFor(choices: ScreenChoice[]): ScreenChoice | undefined {
  return choices.find((choice) => screenIsCommon(choice.physical))
}
