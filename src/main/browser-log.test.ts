import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeCrash, crashReason, isLaunchLogOf, launchLogArgs, launchLogFiles, logTail, pruneLaunchLogs, readLaunchLog } from './browser-log'
import { explainExit } from '../shared/exit-codes'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))) })
async function temp(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'fb-log-'))
  folders.push(folder)
  return folder
}

describe('launch logs', () => {
  it('asks the kernel to log into the window\'s runtime folder', () => {
    const files = launchLogFiles('/runtime', new Date('2026-10-18T02:53:00.123Z'))
    expect(files.chromeLog).toBe(join('/runtime', 'logs', 'browser-2026-10-18T02-53-00-123Z.log'))
    expect(launchLogArgs(files)).toEqual(['--enable-logging', '--v=0', `--log-file=${files.chromeLog}`])
    expect(isLaunchLogOf(files.folder, files.chromeLog)).toBe(true)
    expect(isLaunchLogOf(files.folder, join('/elsewhere', 'browser-x.log'))).toBe(false)
    expect(isLaunchLogOf(files.folder, join(files.folder, '..', 'secrets.json'))).toBe(false)
  })

  it('keeps only the newest launches', async () => {
    const folder = await temp()
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(folder, `browser-2026-10-0${index}.log`), 'x')
      await writeFile(join(folder, `browser-2026-10-0${index}.stderr.log`), 'x')
    }
    await pruneLaunchLogs(folder, 2)
    expect((await readdir(folder)).sort()).toEqual([
      'browser-2026-10-03.log', 'browser-2026-10-03.stderr.log', 'browser-2026-10-04.log', 'browser-2026-10-04.stderr.log'
    ])
  })

  it('finds why Chromium stopped and keeps the last lines', async () => {
    const runtime = await temp()
    const data = await temp()
    const files = launchLogFiles(runtime)
    await mkdir(files.folder, { recursive: true })
    await writeFile(files.chromeLog, [
      '[1:2:1018/105201.1:INFO:chrome_main.cc(1)] start',
      '[1:2:1018/105201.2:ERROR:gpu_init.cc(9)] passthrough is not supported',
      '[1:2:1018/105201.3:FATAL:screen.cc(42)] Check failed: width > 0.'
    ].join('\r\n'))
    await writeFile(files.stderrLog, 'stderr line\n')
    await mkdir(join(data, 'Crashpad', 'reports'), { recursive: true })
    const dump = join(data, 'Crashpad', 'reports', 'a.dmp')
    await writeFile(dump, 'MDMP')
    const old = join(data, 'Crashpad', 'reports', 'old.dmp')
    await writeFile(old, 'MDMP')
    await utimes(old, new Date(2020, 1, 1), new Date(2020, 1, 1))

    const analysis = await analyzeCrash(files, data, new Date(Date.now() - 60_000))
    expect(analysis.reason).toBe('[1:2:1018/105201.3:FATAL:screen.cc(42)] Check failed: width > 0.')
    expect(analysis.logTail.at(-1)).toBe('stderr line')
    expect(analysis.dumps).toEqual([dump])
    const log = await readLaunchLog(files.chromeLog)
    expect(log.files).toEqual([files.chromeLog, files.stderrLog])
    expect(log.text).toContain('----- stderr -----')
  })

  it('reads only the end of a large log', async () => {
    const folder = await temp()
    const path = join(folder, 'browser-big.log')
    await writeFile(path, Array.from({ length: 2000 }, (_, index) => `line ${index}`).join('\n'))
    const log = await readLaunchLog(path, 1000)
    expect(log.truncated).toBe(true)
    expect(log.text.startsWith('line ')).toBe(true)
    expect(log.text.endsWith('line 1999')).toBe(true)
  })

  it('reports nothing when the log has no reason', () => {
    expect(crashReason('[INFO] fine\n[INFO] still fine')).toBeUndefined()
    expect(logTail('a\n\nb\n', 1)).toEqual(['b'])
  })
})

describe('exit codes', () => {
  it('explains the Windows status the kernel exited with', () => {
    expect(explainExit(2147483651, null)).toMatchObject({ code: '0x80000003', title: '内核断言失败（CHECK）' })
    expect(explainExit(-1073741819, null)).toMatchObject({ code: '0xC0000005', title: '内存访问违规' })
    expect(explainExit(null, 'SIGTRAP').title).toBe('内核断言失败（CHECK）')
    expect(explainExit(23, null)).toMatchObject({ code: '23', title: '内核异常退出' })
  })
})
