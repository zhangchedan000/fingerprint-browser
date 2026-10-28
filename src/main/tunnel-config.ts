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
/**
 * Windows set to a node of their own each get one of these: a select group on its own local port.
 * Node names come from the providers only once mihomo runs, so the groups are made empty (REJECT,
 * never a wrong node) and pointed at a node when a window first needs it.
 */
export const NODE_SLOT_COUNT = 16
export const nodeSlotGroup = (index: number) => `TUNNEL-NODE-${index + 1}`
/** Ports used only to look up each node's exit IP, a few nodes at a time. */
export const PROBE_SLOT_COUNT = 4
export const probeGroup = (index: number) => `TUNNEL-PROBE-${index + 1}`
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
  /** Local port that always uses the fastest node (a window set to 自动选择最低延迟). */
  autoPort: number
  /** One local port per node slot (nodeSlotGroup). */
  slotPorts: number[]
  /** One local port per exit-IP probe (probeGroup). */
  probePorts?: number[]
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
  const listener = (name: string, port: number, proxy: string) => ({ name, type: 'mixed', listen: '127.0.0.1', port, udp: false, proxy })
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
      { name: TUNNEL_GROUP, type: 'select', proxies: [AUTO_TUNNEL_GROUP], use: Object.keys(providers) },
      ...input.slotPorts.map((_, index) => ({ name: nodeSlotGroup(index), type: 'select', proxies: ['REJECT'], use: Object.keys(providers) })),
      ...(input.probePorts ?? []).map((_, index) => ({ name: probeGroup(index), type: 'select', proxies: ['REJECT'], use: Object.keys(providers) }))
    ],
    listeners: [
      listener('auto', input.autoPort, AUTO_TUNNEL_GROUP),
      ...input.slotPorts.map((port, index) => listener(`node-${index + 1}`, port, nodeSlotGroup(index))),
      ...(input.probePorts ?? []).map((port, index) => listener(`probe-${index + 1}`, port, probeGroup(index)))
    ],
    rules: [`MATCH,${TUNNEL_GROUP}`]
  }
}
