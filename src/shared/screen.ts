import type { FingerprintConfig } from './types'
import { kernelVendor } from './kernel-id'

/**
 * Prism kernels report the window's resolution as screen.width/height, availWidth/availHeight and
 * the CSS device-width media query. A window wider than its screen gives the claim away, so a
 * kernel that cannot keep its window inside the claimed screen (before prism5, see
 * EngineStatus.windowScreen) may only claim a screen at least as large as the real one. Other
 * kernels always show the real screen.
 */
export function kernelSpoofsScreen(kernelVersion: string | null | undefined): boolean {
  return kernelVendor(kernelVersion) === 'prism'
}

export interface ScreenSize { width: number; height: number }

/** Common desktop resolutions, with a rough share used when a window gets a random one. */
export const SCREEN_CHOICES: ReadonlyArray<ScreenSize & { weight: number }> = [
  { width: 1920, height: 1080, weight: 40 },
  { width: 1920, height: 1200, weight: 4 },
  { width: 2560, height: 1080, weight: 3 },
  { width: 2560, height: 1440, weight: 22 },
  { width: 3440, height: 1440, weight: 6 },
  { width: 3840, height: 2160, weight: 12 }
]

/**
 * A monitor's size in CSS pixels at a Windows display scale, as Chrome on Windows reports it:
 * gfx::ScaleToEnclosingRect(bounds, 1.0f / scale), float math rounded up (ui/display/win/screen_win.cc).
 * 2560 × 1440 at 150% is 1707 × 960.
 */
export function cssScreenSize(physical: ScreenSize, scale = 1): ScreenSize {
  if (!(scale > 0) || scale === 1) return { width: physical.width, height: physical.height }
  const inverse = Math.fround(1 / Math.fround(scale))
  return {
    width: Math.ceil(Math.fround(physical.width * inverse)),
    height: Math.ceil(Math.fround(physical.height * inverse))
  }
}

/**
 * Windows runs a 4K monitor at 150% by default, so Chrome on one reports 2560 × 1440 at
 * devicePixelRatio 1.5. A window claiming 3840 × 2160 (CSS pixels, chosen on a computer at 100%)
 * is shown that way: the kernel is told 2560 × 1440 and the 150% scale (--force-device-scale-factor).
 */
export function scaledScreen(claimed: ScreenSize): { screen: ScreenSize; scale?: number } {
  if (claimed.width === 3840 && claimed.height === 2160) return { screen: cssScreenSize(claimed, 1.5), scale: 1.5 }
  return { screen: claimed }
}

function fits(size: ScreenSize, host: ScreenSize | undefined): boolean {
  return !host || (size.width >= host.width && size.height >= host.height)
}

function validHost(host: ScreenSize | undefined): ScreenSize | undefined {
  return host && Number.isInteger(host.width) && Number.isInteger(host.height) && host.width > 0 && host.height > 0 ? host : undefined
}

/**
 * The real screen a claim has to cover, or undefined when the kernel keeps its window inside the
 * claimed screen and any size will do.
 */
export function screenFloor(host: ScreenSize | undefined, windowScreen: boolean | undefined): ScreenSize | undefined {
  return windowScreen ? undefined : host
}

/** What a monitor of this size is called: its common name and shape. */
export function screenKind(physical: ScreenSize): { name?: string; ratio: string; ultrawide: boolean } {
  const ratio = physical.width / physical.height
  const shape = Math.abs(ratio - 16 / 9) < 0.02 ? '16:9' : Math.abs(ratio - 16 / 10) < 0.02 ? '16:10' : ratio > 2.3 ? '21:9' : `${physical.width}:${physical.height}`
  const name = physical.height >= 2160 ? '4K' : physical.height >= 1440 ? '2K' : physical.height >= 1080 && shape === '16:9' ? '1080p' : undefined
  return { name, ratio: shape, ultrawide: ratio > 2.3 }
}

export type ScreenChoice = ScreenSize & { weight: number; physical: ScreenSize }

/**
 * The resolutions a window on this computer can claim (see screenFloor), in CSS pixels. The
 * window keeps this computer's display scale (devicePixelRatio is real), so a common monitor
 * appears the way it would at that scale.
 */
export function screenChoices(floor: ScreenSize | undefined, scale = 1): ScreenChoice[] {
  return SCREEN_CHOICES
    .map((choice) => ({ ...cssScreenSize(choice, scale), weight: choice.weight, physical: { width: choice.width, height: choice.height } }))
    .filter((choice) => fits(choice, validHost(floor)))
}

/** A resolution picked by how common it is among those this computer can claim. */
export function randomScreen(floor: ScreenSize | undefined, random: () => number = Math.random, scale = 1): ScreenSize | undefined {
  const choices = screenChoices(floor, scale)
  const total = choices.reduce((sum, choice) => sum + choice.weight, 0)
  let roll = random() * total
  for (const choice of choices) {
    roll -= choice.weight
    if (roll < 0) return { width: choice.width, height: choice.height }
  }
  const last = choices.at(-1)
  return last && { width: last.width, height: last.height }
}

/** The screen a page sees: the window's own size when the kernel can show it and it fits, otherwise the real one. */
export function effectiveScreen(
  fp: Pick<FingerprintConfig, 'screenSource' | 'screenWidth' | 'screenHeight'>,
  kernelVersion: string | null | undefined,
  host: ScreenSize | undefined,
  windowScreen = false
): ScreenSize {
  const real = validHost(host)
  const own = { width: fp.screenWidth, height: fp.screenHeight }
  if (!real) return own
  if (!kernelSpoofsScreen(kernelVersion) || fp.screenSource === 'host') return real
  if (!windowScreen && !fits(own, real)) return real
  return own
}

/** The screen and scale the kernel is told: the claimed screen, a 4K one of the window's own at 150% (scaledScreen). */
export function launchedScreen(
  fp: Pick<FingerprintConfig, 'screenSource' | 'screenWidth' | 'screenHeight'>,
  kernelVersion: string | null | undefined,
  host: ScreenSize | undefined,
  windowScreen = false
): { screen: ScreenSize; scale?: number } {
  const claimed = effectiveScreen(fp, kernelVersion, host, windowScreen)
  const own = kernelSpoofsScreen(kernelVersion) && fp.screenSource !== 'host' &&
    claimed.width === fp.screenWidth && claimed.height === fp.screenHeight
  return own ? scaledScreen(claimed) : { screen: claimed }
}
