import type { IpcMain } from 'electron'
import { monitorEventLoopDelay } from 'node:perf_hooks'

interface TimingLogger {
  info(message: string, details?: Record<string, unknown>): void
}

/** An action from the window list, editor, settings… that took at least this long is logged. */
export const SLOW_ACTION_MS = 800
/** The main process (which also answers the screens) blocked at least this long within a minute is logged. */
export const MAIN_STALL_MS = 200

/**
 * [计时] lines: every ipcMain.handle registered after this logs the actions that took long
 * (channel and milliseconds, never the arguments).
 */
export function instrumentIpc(ipcMain: IpcMain, logger: TimingLogger, slowMs = SLOW_ACTION_MS): void {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
    const startedAt = Date.now()
    try {
      return await listener(event, ...args)
    } finally {
      const ms = Date.now() - startedAt
      if (ms >= slowMs) logger.info('[计时] 操作较慢', { channel, ms })
    }
  })
}

/** [计时] the main process stalled (a long synchronous job): checked once a minute. */
export function watchMainStalls(logger: TimingLogger, stallMs = MAIN_STALL_MS, everyMs = 60_000): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  const timer = setInterval(() => {
    const max = Math.round(histogram.max / 1e6)
    if (max >= stallMs) logger.info('[计时] 主进程卡顿', { maxMs: max, p99Ms: Math.round(histogram.percentile(99) / 1e6) })
    histogram.reset()
  }, everyMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    histogram.disable()
  }
}
