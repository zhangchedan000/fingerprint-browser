/**
 * The built-in tunnel: a mihomo (Clash core) process that carries connections to foreign window
 * proxies out of the country encrypted, through a node the user configures — the way 紫鸟/稳卖
 * reach their IPs from any network, with no proxy app on the computer.
 *
 * Nodes come from sources the user adds by hand: pasted share links (vless://, vmess://, trojan://,
 * ss://, hysteria2://…, or Clash YAML) or a subscription URL. mihomo parses both formats itself.
 */

export type TunnelSourceKind = 'links' | 'subscription'

export interface TunnelSource {
  id: string
  name: string
  kind: TunnelSourceKind
  /** Share links / YAML, or the subscription URL. Encrypted at rest. */
  content: string
  updatedAt: string
}

export const TUNNEL_GROUP = 'TUNNEL'
export const AUTO_TUNNEL_GROUP = 'TUNNEL-AUTO'
export const DELAY_TEST_URL = 'https://www.gstatic.com/generate_204'

export function providerName(source: Pick<TunnelSource, 'id'>): string {
  return `source-${source.id}`
}

export function validateTunnelSource(input: { name?: unknown; kind?: unknown; content?: unknown }): { name: string; kind: TunnelSourceKind; content: string } {
  const kind = input.kind
  if (kind !== 'links' && kind !== 'subscription') throw new Error('节点来源类型无效')
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (!content) throw new Error(kind === 'links' ? '请粘贴节点链接' : '请填写订阅链接')
  if (content.length > 1_000_000) throw new Error('节点内容过长')
  if (kind === 'subscription') {
    let url: URL
    try {
      url = new URL(content)
    } catch {
      throw new Error('订阅链接格式无效')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('订阅链接必须以 http:// 或 https:// 开头')
  } else if (!/^\s*(?:[a-z][a-z0-9+.-]*:\/\/\S+|proxies\s*:|[A-Za-z0-9+/=\s]{16,}$)/im.test(content)) {
    throw new Error('没有识别到节点链接，请粘贴 vless://、vmess://、trojan://、ss:// 等链接或 Clash 配置')
  }
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim().slice(0, 40)
    : kind === 'subscription' ? new URL(content).hostname : '手动节点'
  return { name, kind, content }
}

export interface MihomoConfigInput {
  mixedPort: number
  controllerPort: number
  secret: string
  delayTestUrl?: string
  sources: Array<Pick<TunnelSource, 'id' | 'name' | 'kind' | 'content'>>
}

/** mihomo reads YAML; JSON is valid YAML, so the config is written as JSON. */
export function mihomoConfig(input: MihomoConfigInput): Record<string, unknown> {
  const providers: Record<string, unknown> = {}
  for (const source of input.sources) {
    const healthCheck = { enable: true, url: input.delayTestUrl ?? DELAY_TEST_URL, interval: 300, lazy: false }
    // Names of different sources may repeat; the prefix keeps every node addressable.
    const override = { 'additional-prefix': `${source.name} · ` }
    providers[providerName(source)] = source.kind === 'subscription'
      ? { type: 'http', url: source.content, path: `./providers/${source.id}.yaml`, interval: 86_400, 'health-check': healthCheck, override }
      : { type: 'file', path: `./providers/${source.id}.txt`, 'health-check': healthCheck, override }
  }
  return {
    'mixed-port': input.mixedPort,
    'bind-address': '127.0.0.1',
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'warning',
    ipv6: true,
    'unified-delay': true,
    'external-controller': `127.0.0.1:${input.controllerPort}`,
    secret: input.secret,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    'proxy-providers': providers,
    'proxy-groups': [
      { name: AUTO_TUNNEL_GROUP, type: 'url-test', use: Object.keys(providers), url: input.delayTestUrl ?? DELAY_TEST_URL, interval: 300, tolerance: 50, lazy: false },
      { name: TUNNEL_GROUP, type: 'select', proxies: [AUTO_TUNNEL_GROUP], use: Object.keys(providers) }
    ],
    rules: [`MATCH,${TUNNEL_GROUP}`]
  }
}
