import { describe, expect, it } from 'vitest'
import { effectiveScreen, randomScreen, screenChoices, screenFloor } from './screen'

const host = { width: 2560, height: 1440 }
const fp = (width: number, height: number, screenSource?: 'host' | 'profile') => ({ screenWidth: width, screenHeight: height, screenSource })

describe('window screen size', () => {
  it('offers only resolutions at least as large as the real screen', () => {
    expect(screenChoices(host).map((s) => `${s.width}x${s.height}`)).toEqual(['2560x1440', '2560x1600', '3440x1440', '3840x2160'])
    expect(screenChoices({ width: 1920, height: 1080 })).toHaveLength(7)
  })

  it('shows a larger screen on Prism kernels and the real one otherwise', () => {
    expect(effectiveScreen(fp(3840, 2160), 'prism-156.0.8078.47', host)).toEqual({ width: 3840, height: 2160 })
    expect(effectiveScreen(fp(3840, 2160), '144.0.7559.132', host)).toEqual(host)
    expect(effectiveScreen(fp(3840, 2160, 'host'), 'prism-156.0.8078.47', host)).toEqual(host)
  })

  it('claims a smaller screen only on kernels that keep the window inside it', () => {
    expect(effectiveScreen(fp(1920, 1080), 'prism-156.0.8078.47', host, true)).toEqual({ width: 1920, height: 1080 })
    expect(effectiveScreen(fp(1920, 1080), '144.0.7559.132', host, true)).toEqual(host)
    expect(screenChoices(screenFloor(host, true))).toHaveLength(7)
    expect(screenFloor(host, false)).toEqual(host)
  })

  it('never claims a screen smaller than the real one on older kernels', () => {
    expect(effectiveScreen(fp(1440, 900), 'prism-156.0.8078.47', host)).toEqual(host)
    expect(effectiveScreen(fp(3840, 1080), 'prism-156.0.8078.47', host)).toEqual(host)
  })

  it('picks by share among the sizes that fit', () => {
    expect(randomScreen(host, () => 0)).toEqual({ width: 2560, height: 1440 })
    expect(randomScreen(host, () => 0.999)).toEqual({ width: 3840, height: 2160 })
  })
})
