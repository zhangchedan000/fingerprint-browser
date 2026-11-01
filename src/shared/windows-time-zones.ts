import { COUNTRY_ZONES, PRIMARY_ZONES, WINDOWS_ZONES, ZONE_ALIASES, ZONE_RENAMES, type WindowsZoneRow } from './windows-time-zones-data'

/**
 * Time zones as a Windows computer has them. Windows only knows its own zones ("Eastern Standard
 * Time"); Chrome turns the zone into an IANA id with ICU's CLDR windowsZones table, by the
 * computer's country. So a window can only report ids some Windows zone maps to, and an id an IP
 * lookup returns (America/Detroit) becomes the one Windows Chrome reports there (America/New_York).
 */

export interface WindowsZone {
  windows: string
  iana: string
  offsetMinutes: number
  /** As Windows lists it, e.g. "(UTC-05:00) Eastern Time (US & Canada)". */
  label: string
}

const byWindowsId = new Map(WINDOWS_ZONES.map((row) => [row[0], row]))

function zoneOf(row: WindowsZoneRow, iana: string, uiLocale: string): WindowsZone {
  return { windows: row[0], iana, offsetMinutes: row[2], label: uiLocale.toLowerCase().startsWith('zh') ? row[4] : row[3] }
}

/** The Windows zone an IANA id belongs to, and the country CLDR files it under. */
function windowsZoneOf(iana: string): { windows: string; country?: string } | undefined {
  const id = ZONE_RENAMES[iana] ?? iana
  const alias = ZONE_ALIASES[id]
  if (alias) return { windows: alias[0], country: alias[1] }
  const world = WINDOWS_ZONES.find((row) => row[1] === id)
  return world ? { windows: world[0] } : undefined
}

/**
 * The id Chrome on a Windows computer in `country` reports for the zone `iana` falls in, or
 * undefined when no Windows zone covers it.
 */
export function windowsReportedZone(iana: string, country?: string): string | undefined {
  const zone = windowsZoneOf(iana)
  if (!zone) return undefined
  const local = (code: string | undefined) => code ? COUNTRY_ZONES[code.toUpperCase()]?.find(([windows]) => windows === zone.windows)?.[1] : undefined
  return local(country) ?? local(zone.country) ?? byWindowsId.get(zone.windows)?.[1]
}

/** Every Windows zone, west to east, with the world id CLDR gives it. */
export function allWindowsZones(uiLocale: string): WindowsZone[] {
  return WINDOWS_ZONES.map((row) => zoneOf(row, row[1], uiLocale))
}

/** The Windows zones of a country, with the ids Chrome reports there, west to east. */
export function countryWindowsZones(country: string, uiLocale: string): WindowsZone[] {
  return (COUNTRY_ZONES[country.toUpperCase()] ?? [])
    .map(([windows, iana]) => byWindowsId.get(windows) && zoneOf(byWindowsId.get(windows)!, iana, uiLocale))
    .filter((zone): zone is WindowsZone => Boolean(zone))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes)
}

/**
 * Where the capital is, for countries with several zones and no CLDR primary zone (the zone a
 * computer there most often has).
 */
const CAPITAL_ZONES: Readonly<Record<string, string>> = {
  US: 'America/New_York', CA: 'America/Toronto', AU: 'Australia/Sydney', BR: 'America/Sao_Paulo',
  RU: 'Europe/Moscow', MX: 'America/Mexico_City', ID: 'Asia/Jakarta', KZ: 'Asia/Qyzylorda',
  GL: 'America/Godthab', PG: 'Pacific/Port_Moresby', FM: 'Pacific/Ponape', MN: 'Asia/Ulaanbaatar',
  CD: 'Africa/Kinshasa', PF: 'Pacific/Tahiti', KI: 'Pacific/Tarawa', GB: 'Europe/London'
}

/** The zone a window in this country starts with. */
export function defaultCountryZone(country: string): string | undefined {
  const code = country.toUpperCase()
  const zones = COUNTRY_ZONES[code]
  if (!zones?.length) return undefined
  const preferred = PRIMARY_ZONES[code] ?? CAPITAL_ZONES[code]
  if (preferred && zones.some(([, iana]) => iana === preferred)) return preferred
  return zones[0][1]
}

/** Countries a Windows computer can be set to, with at least one zone. */
export function windowsCountries(): string[] {
  return Object.keys(COUNTRY_ZONES).filter((code) => /^[A-Z]{2}$/.test(code) && code !== 'AQ')
}

/** "(UTC-05:00) Eastern Time (US & Canada) · America/New_York", or the id alone if Windows has no such zone. */
export function windowsZoneLabel(iana: string, uiLocale: string, country?: string): string {
  const zone = windowsZoneOf(iana)
  const row = zone && byWindowsId.get(zone.windows)
  if (!row) return iana
  return `${zoneOf(row, iana, uiLocale).label} · ${windowsReportedZone(iana, country) ?? iana}`
}
