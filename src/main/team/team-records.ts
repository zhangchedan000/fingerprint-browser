import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FingerprintCheckStore } from '../fingerprint-check'
import type { ProfileStore } from '../profile-store'
import type { FingerprintCheckReport, ProxyCheckSummary } from '../../shared/types'

/**
 * A window's check records, so the next computer shows what this one found: the proxy check, the
 * fingerprint check, the deep check (with its screenshots) and the IP 评分. They travel inside the
 * login state archive (team-archive.ts, RECORDS_FILE).
 */
export interface CheckRecords {
  proxyCheck?: ProxyCheckSummary
  fingerprintCheck?: FingerprintCheckReport
  deepCheck?: unknown
  ipSites?: unknown
}

/** The files a window keeps its last deep check and IP 评分 in (ipc.ts writes them). */
const RUNTIME_FILES = { deepCheck: 'deep-check.json', ipSites: 'ip-sites.json' } as const

async function readJson(path: string): Promise<unknown> {
  return readFile(path, 'utf8').then((text) => JSON.parse(text) as unknown).catch(() => undefined)
}

export async function collectCheckRecords(profiles: ProfileStore, checks: FingerprintCheckStore, id: string): Promise<CheckRecords> {
  const runtime = profiles.profileRuntimePath(id)
  const [fingerprintCheck, deepCheck, ipSites] = await Promise.all([
    checks.get(id),
    readJson(join(runtime, RUNTIME_FILES.deepCheck)),
    readJson(join(runtime, RUNTIME_FILES.ipSites))
  ])
  const proxyCheck = profiles.get(id).proxyCheck
  return {
    ...(proxyCheck ? { proxyCheck } : {}),
    ...(fingerprintCheck ? { fingerprintCheck } : {}),
    ...(deepCheck ? { deepCheck } : {}),
    ...(ipSites ? { ipSites } : {})
  }
}

/** Puts records that came with a window's login state in place (what is not in them stays as it is). */
export async function applyCheckRecords(profiles: ProfileStore, checks: FingerprintCheckStore, id: string, input: unknown): Promise<void> {
  if (!input || typeof input !== 'object') return
  const records = input as CheckRecords
  const runtime = profiles.profileRuntimePath(id)
  await mkdir(runtime, { recursive: true })
  for (const key of ['deepCheck', 'ipSites'] as const) {
    if (records[key] && typeof records[key] === 'object') {
      await writeFile(join(runtime, RUNTIME_FILES[key]), JSON.stringify(records[key]), { mode: 0o600 })
    }
  }
  if (records.fingerprintCheck && typeof records.fingerprintCheck === 'object' && typeof records.fingerprintCheck.checkedAt === 'string') {
    await checks.set(id, records.fingerprintCheck)
  }
  if (records.proxyCheck) await profiles.restoreProxyCheck(id, records.proxyCheck)
}
