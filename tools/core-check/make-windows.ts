/**
 * Windows for the core check (tools/core-check/README.md): made the way the launcher makes new
 * windows (random seed, the Windows NVIDIA template, country, zone, languages and position from
 * the proxy's check, the fingerprint fixed at save) and launched with the launcher's own
 * buildLaunchArgs for the user's computer (Windows 11, 24 threads, 2560 x 1440, prism11 156).
 *
 *   npx tsx tools/core-check/make-windows.ts <out.json>
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileStore } from '../../src/main/profile-store'
import { buildLaunchArgs } from '../../src/main/launch-args'
import { defaultProfileDraft } from '../../src/shared/defaults'
import { applyHardwareProfile } from '../../src/shared/hardware-profiles'
import { fixedIdentityForCheck } from '../../src/shared/network-identity'
import type { ProxyCheckSummary } from '../../src/shared/types'

const out = process.argv[2] ?? 'core-windows.json'
// The proxies' exits as a check would report them (documentation addresses, real places).
const exits: Array<{ name: string; check: ProxyCheckSummary }> = [
  ['US-1', '203.0.113.11', 'US', 'United States', 'America/Chicago', 32.73, -97.32],
  ['US-2', '203.0.113.12', 'US', 'United States', 'America/Los_Angeles', 46.21, -119.16],
  ['US-3', '203.0.113.13', 'US', 'United States', 'America/New_York', 40.71, -74.01],
  ['GB-1', '198.51.100.21', 'GB', 'United Kingdom', 'Europe/London', 51.51, -0.13],
  ['DE-1', '198.51.100.22', 'DE', 'Germany', 'Europe/Berlin', 52.52, 13.4],
  ['JP-1', '198.51.100.23', 'JP', 'Japan', 'Asia/Tokyo', 35.68, 139.69]
].map(([name, ip, countryCode, country, timezone, latitude, longitude]) => ({
  name: name as string,
  check: { ok: true, latencyMs: 120, ip: ip as string, countryCode: countryCode as string, country: country as string, timezone: timezone as string, latitude: latitude as number, longitude: longitude as number, accuracyMeters: 25000, geoConfidence: 'consensus', checkedAt: new Date().toISOString() } as ProxyCheckSummary
}))

const vault = await mkdtemp(join(tmpdir(), 'core-check-'))
try {
  const profiles = new ProfileStore(vault)
  await profiles.initialize()
  const windows = []
  for (const [index, { name, check }] of exits.entries()) {
    const draft = defaultProfileDraft(index + 1)
    // As on a Windows computer: the Windows platform and its NVIDIA template, then the IP's identity.
    const windowsFp = applyHardwareProfile({ ...draft.fingerprint, platform: 'windows', platformVersion: '19.0.0' }, 'windows-seeded-nvidia', { refreshSeededGpu: true })
    const fingerprint = { ...windowsFp, ...fixedIdentityForCheck(windowsFp, check, { followUiLocale: true }) }
    const profile = await profiles.create({ ...draft, name, fingerprint })
    const args = buildLaunchArgs({ ...profile, proxyCheck: check }, {
      userDataDir: 'USER_DATA_DIR',
      engineVersion: 'prism-156.0.8078.47',
      fingerprintKernel: true,
      hostHardwareConcurrency: 24,
      hostPlatformVersion: '19.0.0',
      proxyIdentity: check,
      hostScreen: { width: 2560, height: 1440, taskbarHeight: 48 },
      windowScreen: true,
      webrtcRelaySupported: true,
      languageFonts: true,
      seededAudioRects: true,
      firstOpen: true
    })
    const fp = profile.fingerprint
    windows.push({
      name,
      // Start pages and the window position belong to the test, not the fingerprint.
      args: args.filter((arg) => arg.startsWith('--') && !arg.startsWith('--user-data-dir') && !arg.startsWith('--window-position') && !arg.startsWith('--window-size')),
      expected: {
        timezone: fp.timezone, language: fp.language, acceptLanguages: fp.acceptLanguages, region: fp.region,
        hardwareConcurrency: fp.hardwareConcurrency, deviceMemory: fp.deviceMemory, screen: `${fp.screenWidth}x${fp.screenHeight}`,
        gpu: fp.gpu, platformVersion: fp.platformVersion, seed: fp.seed, location: fp.location
      }
    })
  }
  await writeFile(out, JSON.stringify({ madeAt: new Date().toISOString(), host: 'Windows 11, 24 threads, 2560x1440, RTX 3080 Ti, prism-156.0.8078.47', windows }, null, 1))
  console.log(`${windows.length} windows -> ${out}`)
} finally {
  await rm(vault, { recursive: true, force: true })
}
