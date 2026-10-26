import { describe, expect, it } from 'vitest'
import { DEVICE_NAME_PATTERN, deviceName, MAC_ADDRESS_PATTERN, macAddress, noiseValue } from './device-identity'

describe('realistic per-window values', () => {
  it('looks like what detection sites show, fixed per seed and different between seeds', () => {
    expect(noiseValue(1, 'canvas')).toMatch(/^[0-9a-f]{16}$/)
    expect(noiseValue(1, 'audio')).toMatch(/^124\.04[3-6]\d{11}$/)
    expect(noiseValue(1, 'canvas')).toBe(noiseValue(1, 'canvas'))
    expect(noiseValue(1, 'canvas')).not.toBe(noiseValue(2, 'canvas'))
    expect(noiseValue(1, 'canvas')).not.toBe(noiseValue(1, 'clientrects'))
  })

  it('names computers the way Windows and macOS do', () => {
    expect(deviceName(7, 'windows')).toMatch(/^DESKTOP-[A-Z0-9]{7}$/)
    expect(deviceName(7, 'macos')).toMatch(/^[A-Z][a-z]+s-(MacBook-Pro|MacBook-Air|iMac|Mac-mini)$/)
    for (let seed = 0; seed < 200; seed++) {
      expect(deviceName(seed, 'windows')).toMatch(DEVICE_NAME_PATTERN)
      expect(deviceName(seed, 'macos')).toMatch(DEVICE_NAME_PATTERN)
    }
  })

  it('makes random hardware addresses like 7A:C5:6F:F2:C2:84', () => {
    const seen = new Set<string>()
    for (let seed = 0; seed < 500; seed++) {
      const mac = macAddress(seed)
      expect(mac).toMatch(MAC_ADDRESS_PATTERN)
      expect(mac).toBe(mac.toUpperCase())
      const first = parseInt(mac.slice(0, 2), 16)
      expect(first & 0x02).toBe(0x02) // locally administered
      expect(first & 0x01).toBe(0) // unicast
      seen.add(mac)
    }
    expect(seen.size).toBe(500)
  })
})
