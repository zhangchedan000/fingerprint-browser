/**
 * How the launcher starts a kernel (windows, Cookie maintenance, fingerprint checks).
 *
 * On Windows, Node puts every child it spawns into the launcher's job object unless the child is
 * detached. A browser started inside that job lost its Google sign-in within seconds whenever the
 * window's login state was opened on another computer (Win10, a fresh Windows Sandbox), while the
 * same data, fingerprint, proxy and kernel kept it when the browser ran outside the job (tested
 * 2026-11-02: 4 of 4 kept outside, 6 of 6 lost inside; see 当前进度.md). So kernels start detached.
 * The launcher still tracks each one by its process and stops it itself.
 */
export function kernelSpawnOptions(platform: NodeJS.Platform = process.platform): { detached?: true } {
  return platform === 'win32' ? { detached: true } : {}
}
