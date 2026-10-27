import { describe, expect, it } from 'vitest'
import { hostSystem } from './host-hardware'

describe('host system', () => {
  it('tells Windows 11 from Windows 10 by build number', () => {
    expect(hostSystem('windows', '10.0.26200')).toEqual({ platform: 'windows', name: 'Windows 11', build: '26200' })
    expect(hostSystem('windows', '10.0.22000')).toMatchObject({ name: 'Windows 11' })
    expect(hostSystem('windows', '10.0.19045')).toMatchObject({ name: 'Windows 10', build: '19045' })
  })
})
