import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from './defaults'
import { checkedSettingsKey, noiseStillMatches } from './fingerprint-check-key'

describe('which check results still hold', () => {
  it('keeps Canvas, AudioContext and ClientRects values across country, language and proxy changes', () => {
    const fp = defaultFingerprint(42)
    const key = checkedSettingsKey(fp, '156.0.8078.47', 'direct')
    const elsewhere = { ...fp, region: 'MX', timezone: 'America/Mexico_City', language: 'es-419', screenWidth: 2560 }
    expect(checkedSettingsKey(elsewhere, '156.0.8078.47', 'library:p1')).not.toBe(key)
    expect(noiseStillMatches(key, elsewhere, '156.0.8078.47')).toBe(true)
  })

  it('does not once the seed, GPU, kernel or a spoofing switch changes', () => {
    const fp = defaultFingerprint(42)
    const key = checkedSettingsKey(fp, '156.0.8078.47', 'direct')
    expect(noiseStillMatches(key, { ...fp, seed: 43 }, '156.0.8078.47')).toBe(false)
    expect(noiseStillMatches(key, { ...fp, gpu: 'NVIDIA GeForce RTX 4090|x' }, '156.0.8078.47')).toBe(false)
    expect(noiseStillMatches(key, fp, '155.0.8059.84')).toBe(false)
    expect(noiseStillMatches(key, { ...fp, disabledSpoofing: ['canvas'] }, '156.0.8078.47')).toBe(false)
    expect(noiseStillMatches('not json', fp, '156.0.8078.47')).toBe(false)
  })
})
