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

/**
 * What a detection site would show for this surface: a 16-character hash for Canvas, ClientRects
 * and fonts, a decimal sample sum for Audio (real Chrome lands around 124.04).
 */
export function noiseValue(seed: number, surface: NoiseSurface): string {
  const next = stream(seed, surface)
  if (surface === 'audio') {
    let digits = ''
    for (let i = 0; i < 11; i++) digits += Math.floor(next() * 10)
    return `124.04${3 + Math.floor(next() * 4)}${digits}`
  }
  let hash = ''
  for (let i = 0; i < 16; i++) hash += HEX[Math.floor(next() * 16)]
  return hash
}

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

/**
 * "7A:C5:6F:F2:C2:84": a random hardware address, the private MAC that current Windows and macOS
 * generate per network (first byte has the "locally administered" bit set and is unicast).
 */
export function macAddress(seed: number): string {
  const next = stream(seed, 'mac')
  const bytes = Array.from({ length: 6 }, () => Math.floor(next() * 256))
  bytes[0] = (bytes[0] & 0xfc) | 0x02
  return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(':')
}

export const DEVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/
export const MAC_ADDRESS_PATTERN = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/
