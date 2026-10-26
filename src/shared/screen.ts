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
  { width: 2560, height: 1600, weight: 3 },
  { width: 3440, height: 1440, weight: 6 },
  { width: 3840, height: 2160, weight: 12 }
]

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

/** The resolutions a window on this computer can claim (see screenFloor). */
export function screenChoices(floor: ScreenSize | undefined): Array<ScreenSize & { weight: number }> {
  return SCREEN_CHOICES.filter((choice) => fits(choice, validHost(floor)))
}

/** A resolution picked by how common it is among those this computer can claim. */
export function randomScreen(floor: ScreenSize | undefined, random: () => number = Math.random): ScreenSize | undefined {
  const choices = screenChoices(floor)
  const total = choices.reduce((sum, choice) => sum + choice.weight, 0)
  let roll = random() * total
  for (const choice of choices) {
    roll -= choice.weight
    if (roll < 0) return { width: choice.width, height: choice.height }
  }
  return choices.at(-1)
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
