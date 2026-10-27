import { gpuTier, type GpuTier } from './hardware-match'
import macVendors from './mac-vendors.json'
import type { BrowserPlatform } from './types'

/**
 * Realistic-looking values shown in the window editor. Each is fixed per window: derived from the
 * fingerprint seed until the user shuffles it (then stored), so the same window always shows the
 * same value and different windows differ.
 */

/** A small deterministic generator, so a seed always gives the same value. */
function stream(seed: number, salt: string): () => number {
  let state = (0x811c9dc5 ^ (seed >>> 0)) >>> 0
  for (const char of salt) state = Math.imul(state ^ char.charCodeAt(0), 0x01000193) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000
  }
}

const HEX = '0123456789abcdef'

export type NoiseSurface = 'canvas' | 'audio' | 'clientrects' | 'font'

const WINDOWS_NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const FIRST_NAMES = ['Emily', 'James', 'Olivia', 'Michael', 'Sophia', 'David', 'Emma', 'Daniel', 'Ava', 'Ryan',
  'Chloe', 'Kevin', 'Grace', 'Jason', 'Lily', 'Eric', 'Hannah', 'Brian', 'Mia', 'Alex', 'Lucas', 'Zoe', 'Ethan', 'Nora']
const MAC_MODELS = ['MacBook-Pro', 'MacBook-Air', 'iMac', 'Mac-mini']

/** "DESKTOP-0WCUDDJ" on Windows (the format Windows setup gives), "Emily-MacBook-Pro" on macOS. */
export function deviceName(seed: number, platform: BrowserPlatform): string {
  const next = stream(seed, `device-name-${platform}`)
  if (platform === 'windows') {
    let suffix = ''
    for (let i = 0; i < 7; i++) suffix += WINDOWS_NAME_CHARS[Math.floor(next() * WINDOWS_NAME_CHARS.length)]
    return `DESKTOP-${suffix}`
  }
  const name = FIRST_NAMES[Math.floor(next() * FIRST_NAMES.length)]
  const model = MAC_MODELS[Math.floor(next() * MAC_MODELS.length)]
  return `${name}s-${model}`
}

type MacVendor = keyof typeof macVendors.vendors

/** How the vendor of a MAC is shown next to it. Killer cards carry Rivet Networks' OUI. */
const VENDOR_NAMES: Record<MacVendor, string> = {
  Intel: 'Intel', Realtek: 'Realtek', ASUS: 'ASUS', MSI: 'MSI', GIGABYTE: 'GIGABYTE', ASRock: 'ASRock',
  Killer: 'Killer', Apple: 'Apple'
}

/**
 * Who made a desktop's wired network adapter, by GPU class: an onboard port carries the
 * motherboard maker's OUI (ASUS, MSI, GIGABYTE, ASRock), a separate card its chip maker's
 * (Realtek on cheap ones, Intel 2.5G, Killer on gaming boards). Weights, not data: which of
 * these real makers a window gets.
 */
const WINDOWS_VENDORS: Record<GpuTier, Array<[MacVendor, number]>> = {
  entry: [['ASUS', 3], ['MSI', 3], ['GIGABYTE', 3], ['ASRock', 2], ['Realtek', 2], ['Intel', 1]],
  mid: [['ASUS', 3], ['MSI', 3], ['GIGABYTE', 3], ['ASRock', 2], ['Realtek', 1], ['Intel', 2]],
  high: [['ASUS', 3], ['MSI', 3], ['GIGABYTE', 3], ['ASRock', 1], ['Intel', 3], ['Killer', 1]],
  top: [['ASUS', 3], ['MSI', 3], ['GIGABYTE', 2], ['ASRock', 1], ['Intel', 3], ['Killer', 2]]
}

const OUI_VENDOR = new Map<string, MacVendor>(
  (Object.entries(macVendors.vendors) as Array<[MacVendor, string[]]>).flatMap(([vendor, ouis]) => ouis.map((oui) => [oui, vendor] as const))
)

const macBytes = (mac: string) => mac.trim().split(/[:-]/).map((part) => parseInt(part, 16))

/**
 * A hardware address as the system shows it: "00-1B-21-3A-5C-7E" on Windows (ipconfig, getmac,
 * the adapter's details), "a4:83:e7:12:34:56" on macOS (System Settings).
 */
export function formatMac(mac: string, platform: BrowserPlatform): string {
  const hex = macBytes(mac).map((byte) => byte.toString(16).padStart(2, '0'))
  return platform === 'macos' ? hex.join(':') : hex.join('-').toUpperCase()
}

/**
 * A wired adapter's address: a real maker's OUI from the IEEE registry (mac-vendors.json; Apple on
 * macOS, on Windows a maker that suits the GPU class) and three bytes of its own per window.
 */
export function macAddress(seed: number, platform: BrowserPlatform = 'windows', gpuModel?: string): string {
  const next = stream(seed, 'mac-oui')
  const choices = platform === 'macos' ? [['Apple', 1] as [MacVendor, number]] : WINDOWS_VENDORS[gpuTier(gpuModel ?? '')]
  let pick = next() * choices.reduce((sum, [, weight]) => sum + weight, 0)
  const vendor = choices.find(([, weight]) => (pick -= weight) < 0)?.[0] ?? choices[0][0]
  const ouis = macVendors.vendors[vendor]
  const oui = ouis[Math.floor(next() * ouis.length)]
  const tail = Array.from({ length: 3 }, () => Math.floor(next() * 256).toString(16).padStart(2, '0')).join('')
  return formatMac((oui + tail).match(/../g)!.join(':'), platform)
}

/** The maker a MAC's OUI is registered to, when it is one of ours. */
export function macVendor(mac: string): string | undefined {
  const oui = macBytes(mac).slice(0, 3).map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
  const vendor = OUI_VENDOR.get(oui)
  return vendor && VENDOR_NAMES[vendor]
}

/**
 * Whether the address is a random one (the "locally administered" bit), as earlier launchers
 * generated: no adapter maker's, so the window shows a real maker's address instead.
 */
export function isRandomMac(mac: string): boolean {
  return (macBytes(mac)[0] & 0x02) === 0x02
}

export const DEVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/
export const MAC_ADDRESS_PATTERN = /^[0-9A-Fa-f]{2}(?:([:-])[0-9A-Fa-f]{2})(?:\1[0-9A-Fa-f]{2}){4}$/
