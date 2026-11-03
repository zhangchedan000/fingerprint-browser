/**
 * Windows on a prism21 kernel, as launched by v0.5.59 + 656089a (the last launcher that still knew
 * older kernels): prism21-launch-args.json holds the arguments they got then, which must not change.
 */
export interface Prism21Case {
  name: string
  engine: string
  fingerprint?: Record<string, unknown>
  profile?: Record<string, unknown>
  options?: Record<string, unknown>
  /** A Windows window of the default Windows hardware template. */
  windows?: boolean
}

const HOST = { hostScreen: { width: 2560, height: 1440, scaleFactor: 1.25, taskbarHeight: 48 }, hostHardwareConcurrency: 24, hostPlatformVersion: '19.0.0' }

const CASES: Prism21Case[] = [
  { name: '156 default direct', engine: 'prism-156.0.8078.47', options: HOST },
  { name: '155 default direct', engine: 'prism-155.0.8059.84', windows: true, options: HOST },
  { name: '156 proxy socks', engine: 'prism-156.0.8078.47', options: { ...HOST, proxyUrl: 'socks5://127.0.0.1:41234', proxyIdentity: { ok: true, ip: '8.8.4.4', countryCode: 'US', timezone: 'America/New_York', latitude: 40.7, longitude: -74, checkedAt: '2026-11-03T00:00:00Z', latencyMs: 100 } } },
  { name: '156 relay', engine: 'prism-156.0.8078.47', fingerprint: { webrtcPolicy: 'proxy_only' }, options: { ...HOST, proxyUrl: 'http://127.0.0.1:41235', webrtcRelayPort: 50123 } },
  { name: '156 replace no relay', engine: 'prism-156.0.8078.47', fingerprint: { webrtcPolicy: 'proxy_only' }, options: { ...HOST, proxyUrl: 'http://127.0.0.1:41235', proxyIdentity: { ok: true, ip: '8.8.4.4', checkedAt: '2026-11-03T00:00:00Z', latencyMs: 100 } } },
  { name: '156 webrtc disabled', engine: 'prism-156.0.8078.47', fingerprint: { webrtcPolicy: 'disabled' }, options: HOST },
  { name: '156 webrtc privacy', engine: 'prism-156.0.8078.47', fingerprint: { webrtcPolicy: 'privacy' }, options: HOST },
  { name: '156 device binding', engine: 'prism-156.0.8078.47', windows: true, fingerprint: { deviceBinding: 'on', portScanProtection: false }, options: HOST },
  { name: '156 win10 gpu', engine: 'prism-156.0.8078.47', windows: true, fingerprint: { gpu: 'NVIDIA GeForce RTX 3080 Ti|0x00002208', platformVersion: '10.0.0', deviceMemory: 32 }, options: HOST },
  { name: '155 4k custom window', engine: 'prism-155.0.8059.84', fingerprint: { screenWidth: 3840, screenHeight: 2160 }, profile: { window: { mode: 'custom', width: 1280, height: 800, x: 40, y: 30 }, startupMode: 'restore' }, options: { ...HOST, firstOpen: false, extensionPaths: ['/ext/a'], remoteDebuggingPort: 9333 } },
  { name: '156 host fonts and real audio', engine: 'prism-156.0.8078.47', fingerprint: { fontSource: 'host', disabledSpoofing: ['audio', 'clientrects', 'font'] }, options: HOST },
  { name: '156 custom media and keyboard', engine: 'prism-156.0.8078.47', fingerprint: { mediaLocale: 'ja-JP', voicesLocale: 'ja-JP', keyboardLayout: 'ja', language: 'ja-JP' }, options: { ...HOST, extraUrls: ['https://extra.example/'] } },
  { name: '156 build suffix', engine: 'prism-156.0.8078.47-202611040830', options: HOST }
]

/** A fixed seed (new windows get a random one), so every case gets the same arguments each run. */
export const PRISM21_CASES: Prism21Case[] = CASES.map((item) => ({ ...item, fingerprint: { seed: 987654321, ...item.fingerprint } }))
