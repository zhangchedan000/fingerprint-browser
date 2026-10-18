import type { FingerprintConfig } from './types'

/**
 * The downloadable kernels cannot change what pages read as the screen size, so every window
 * uses the computer's real screen. Turn this on once the kernel carries the screen patches
 * (004/005); the per-window resolution choice in the editor comes back with it.
 */
export const SCREEN_SPOOFING_SUPPORTED = false

/** Where a window's screen size comes from, after what the kernel can do. */
export function effectiveScreenSource(fp: Pick<FingerprintConfig, 'screenSource'>): 'profile' | 'host' {
  return SCREEN_SPOOFING_SUPPORTED ? fp.screenSource ?? 'profile' : 'host'
}
