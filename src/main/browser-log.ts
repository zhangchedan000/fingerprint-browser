import { createWriteStream, type WriteStream } from 'node:fs'
import { open, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Readable } from 'node:stream'

/** Launch logs kept per window; older ones are deleted when a new launch starts. */
const KEEP_LAUNCH_LOGS = 10
/** How much of a log the crash panel reads (the end of the file). */
const MAX_LOG_READ_BYTES = 512 * 1024
const TAIL_LINES = 80
const MAX_LINE_LENGTH = 600

export interface LaunchLogFiles {
  folder: string
  /** Chromium's own log (--enable-logging --log-file). */
  chromeLog: string
  /** Whatever the kernel wrote to stderr. */
  stderrLog: string
}

export function launchLogFiles(runtimePath: string, at = new Date()): LaunchLogFiles {
  const folder = join(runtimePath, 'logs')
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  return {
    folder,
    chromeLog: join(folder, `browser-${stamp}.log`),
    stderrLog: join(folder, `browser-${stamp}.stderr.log`)
  }
}

/** Arguments that make the kernel write its log to our file. */
export function launchLogArgs(files: LaunchLogFiles): string[] {
  return ['--enable-logging', '--v=0', `--log-file=${files.chromeLog}`]
}

/** Deletes all but the newest launch logs. */
export async function pruneLaunchLogs(folder: string, keep = KEEP_LAUNCH_LOGS): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[])
  const launches = [...new Set(names
    .map((name) => name.match(/^(browser-.+?)(?:\.stderr)?\.log$/)?.[1])
    .filter((name): name is string => Boolean(name)))].sort()
  const stale = launches.slice(0, Math.max(0, launches.length - keep))
  await Promise.allSettled(stale.flatMap((prefix) => [
    rm(join(folder, `${prefix}.log`), { force: true }),
    rm(join(folder, `${prefix}.stderr.log`), { force: true })
  ]))
}

/** Copies a child stream into a file. Returns the file stream so the caller can close it. */
export function captureStream(stream: Readable | null | undefined, path: string): WriteStream | undefined {
  if (!stream) return undefined
  const file = createWriteStream(path, { flags: 'a', mode: 0o600 })
  file.on('error', () => undefined)
  stream.on('error', () => undefined)
  stream.pipe(file)
  return file
}

async function readEnd(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    let text = buffer.toString('utf8')
    if (size > length) text = text.slice(text.indexOf('\n') + 1)
    return { text, truncated: size > length }
  } finally {
    await handle.close()
  }
}

export interface LaunchLogText {
  text: string
  truncated: boolean
  files: string[]
}

/** Both logs of one launch, Chromium's first. Missing files are skipped. */
export async function readLaunchLog(chromeLog: string, maxBytes = MAX_LOG_READ_BYTES): Promise<LaunchLogText> {
  const stderrLog = chromeLog.replace(/\.log$/, '.stderr.log')
  const parts: string[] = []
  const files: string[] = []
  let truncated = false
  for (const path of [chromeLog, stderrLog]) {
    const part = await readEnd(path, maxBytes).catch(() => undefined)
    if (!part || !part.text.trim()) continue
    truncated ||= part.truncated
    files.push(path)
    parts.push(path === stderrLog ? `----- stderr -----\n${part.text}` : part.text)
  }
  return { text: parts.join('\n'), truncated, files }
}

/**
 * Lines that name why Chromium stopped itself. Official builds often drop the CHECK message,
 * so FATAL lines and the last errors before the exit are kept too.
 */
const FATAL_PATTERNS = [
  /Check failed[^\n]*/i,
  /NOTREACHED[^\n]*/,
  /\bFATAL:[^\n]*/,
  /Fatal error[^\n]*/i,
  /GPU process exited unexpectedly[^\n]*/i,
  /GPU process isn't usable[^\n]*/i,
  /Renderer process crashed[^\n]*/i
]

export function crashReason(log: string): string | undefined {
  const lines = log.split(/\r?\n/)
  for (const pattern of FATAL_PATTERNS) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = lines[index].match(pattern)
      if (match) return clip(lines[index].trim())
    }
  }
  return undefined
}

function clip(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line
}

export function logTail(log: string, lines = TAIL_LINES): string[] {
  return log.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).map(clip)
}

/** Crash dumps Crashpad wrote under the window's data folder since the launch. */
export async function crashDumpsSince(userDataDir: string, since: Date): Promise<string[]> {
  const root = join(userDataDir, 'Crashpad')
  const names = await readdir(root, { recursive: true }).catch(() => [] as string[])
  const dumps: string[] = []
  for (const name of names) {
    if (!String(name).toLowerCase().endsWith('.dmp')) continue
    const path = join(root, String(name))
    const info = await stat(path).catch(() => undefined)
    if (info && info.mtimeMs >= since.getTime() - 1000) dumps.push(path)
  }
  return dumps.sort()
}

export interface CrashAnalysis {
  reason?: string
  logTail: string[]
  dumps: string[]
}

export async function analyzeCrash(files: LaunchLogFiles, userDataDir: string, launchedAt: Date): Promise<CrashAnalysis> {
  const { text } = await readLaunchLog(files.chromeLog).catch(() => ({ text: '' }))
  return {
    reason: crashReason(text),
    logTail: logTail(text),
    dumps: await crashDumpsSince(userDataDir, launchedAt)
  }
}

/** True for a log file this window wrote; anything else must not be read through IPC. */
export function isLaunchLogOf(folder: string, path: string): boolean {
  return join(folder, basename(path)) === path && /^browser-[\w-]+\.log$/.test(basename(path))
}
