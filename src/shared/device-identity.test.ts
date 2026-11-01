import { describe, expect, it } from 'vitest'
import { DEVICE_NAME_PATTERN, deviceName, formatMac, isRandomMac, MAC_ADDRESS_PATTERN, macAddress, macVendor } from './device-identity'
import macVendors from './mac-vendors.json'

describe('realistic per-window values', () => {
  it('names computers the way Windows and macOS do', () => {
    expect(deviceName(7, 'windows')).toMatch(/^DESKTOP-[A-Z0-9]{7}$/)
    expect(deviceName(7, 'macos')).toMatch(/^[A-Z][a-z]+s-(MacBook-Pro|MacBook-Air|iMac|Mac-mini)$/)
    for (let seed = 0; seed < 200; seed++) {
      expect(deviceName(seed, 'windows')).toMatch(DEVICE_NAME_PATTERN)
      expect(deviceName(seed, 'macos')).toMatch(DEVICE_NAME_PATTERN)
    }
  })

  it('gives each window an adapter address of a real maker, written as the system writes it', () => {
    const seen = new Set<string>()
    const ouis = new Set(Object.values(macVendors.vendors).flat())
    for (let seed = 0; seed < 500; seed++) {
      const mac = macAddress(seed, 'windows', 'NVIDIA GeForce RTX 4090')
      expect(mac).toMatch(/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/)
      expect(mac).toMatch(MAC_ADDRESS_PATTERN)
      expect(ouis.has(mac.slice(0, 8).replace(/-/g, ''))).toBe(true)
      expect(isRandomMac(mac)).toBe(false)
      expect(['ASUS', 'MSI', 'GIGABYTE', 'ASRock', 'Intel', 'Killer']).toContain(macVendor(mac))
      seen.add(mac)
    }
    expect(seen.size).toBe(500)
    expect(macAddress(3, 'windows')).toBe(macAddress(3, 'windows'))
    const mac = macAddress(3, 'macos')
    expect(mac).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/)
    expect(macVendor(mac)).toBe('Apple')
  })

  it('reads the maker and format of any address', () => {
    expect(macVendor('00-1B-21-3A-5C-7E')).toBe('Intel')
    expect(macVendor('00:e0:4c:01:02:03')).toBe('Realtek')
    expect(formatMac('00:e0:4c:01:02:03', 'windows')).toBe('00-E0-4C-01-02-03')
    expect(formatMac('00-E0-4C-01-02-03', 'macos')).toBe('00:e0:4c:01:02:03')
    expect(isRandomMac('9E:4A:55:31:D4:BB')).toBe(true)
    expect(MAC_ADDRESS_PATTERN.test('00-1B-21:3A-5C-7E')).toBe(false)
  })
})
