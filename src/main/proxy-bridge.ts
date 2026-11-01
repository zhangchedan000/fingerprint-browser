import proxyChain from 'proxy-chain'
import { connect, createServer, isIP, type AddressInfo, type Server, type Socket } from 'node:net'
import { SocksClient } from 'socks'
import type { ProxyConfig, TunnelRoute } from '../shared/types'

export interface ProxyBridgeObserver {
  onFailure?: (error: unknown) => void
  onTraffic?: () => void
}

/**
 * The computer's own proxy (Clash, v2rayN… with “system proxy” on). In China a foreign proxy is
 * often unreachable directly, so when the system proxy is on, the connection to a window's proxy
 * goes through it first, the way the user's other programs reach the outside.
 */
export interface LocalProxy {
  type: 'http' | 'socks4' | 'socks5'
  host: string
  port: number
}

/**
 * How the connection to a window proxy goes out: route is the window's 网络加速 (undefined for
 * windows from before it existed). With route.enabled it must give the tunnel or throw — never
 * undefined, which would mean a direct connection from this computer's own IP.
 */
export type LocalProxyResolver = (host: string, port: number, route?: TunnelRoute) => Promise<LocalProxy | undefined>

let resolveLocalProxy: LocalProxyResolver | undefined

/** Set once by the main process (Electron's system proxy lookup); tests and tools leave it unset. */
export function setLocalProxyResolver(resolver?: LocalProxyResolver): void {
  resolveLocalProxy = resolver
}

/** First usable entry of a Chromium proxy rule such as "PROXY 127.0.0.1:7890; DIRECT". */
export function parseProxyRule(rule: string): LocalProxy | undefined {
  for (const entry of rule.split(';')) {
    if (/^\s*DIRECT\s*$/i.test(entry)) return undefined
    const match = /^\s*(PROXY|SOCKS5|SOCKS4|SOCKS)\s+(\[[^\]]+\]|[^\s:]+):(\d{1,5})\s*$/i.exec(entry)
    if (!match) continue
    const port = Number(match[3])
    if (port < 1 || port > 65535) continue
    const kind = match[1].toUpperCase()
    return {
      type: kind === 'PROXY' ? 'http' : kind === 'SOCKS5' ? 'socks5' : 'socks4',
      host: match[2].replace(/^\[|\]$/g, ''),
      port
    }
  }
  return undefined
}

/** Loopback and private addresses are reached directly, never through the system proxy. */
export function isLocalAddress(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost'
    || /^127\./.test(name)
    || /^10\./.test(name)
    || /^192\.168\./.test(name)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(name)
    || /^169\.254\./.test(name)
    || name === '::1'
    || /^f[cd][0-9a-f]{2}:/.test(name)
    || /^fe80:/.test(name)
}

/** A TCP connection to host:port opened through the local proxy. */
export async function connectThrough(via: LocalProxy, host: string, port: number): Promise<Socket> {
  if (via.type !== 'http') {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: via.host, port: via.port, type: via.type === 'socks4' ? 4 : 5 },
      command: 'connect',
      destination: { host, port },
      timeout: 15_000
    })
    return socket
  }
  return new Promise((resolve, reject) => {
    const target = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`
    const socket = connect(via.port, via.host)
    let head = Buffer.alloc(0)
    const fail = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) {
        if (head.length > 16_384) fail(new Error('local proxy sent an invalid response'))
        return
      }
      socket.off('data', onData)
      socket.off('error', fail)
      socket.setTimeout(0)
      socket.pause()
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'))?.[1])
      if (status !== 200) {
        fail(new Error(`local proxy refused the tunnel (HTTP ${status || '?'})`))
        return
      }
      const rest = head.subarray(end + 4)
      if (rest.length) socket.unshift(rest)
      resolve(socket)
    }
    socket.setTimeout(15_000, () => fail(new Error('local proxy timed out')))
    socket.once('error', fail)
    socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    socket.on('data', onData)
  })
}

/** A local port that forwards every connection to host:port through the local proxy. */
async function openTunnel(route: () => Promise<LocalProxy>, host: string, port: number, observer: ProxyBridgeObserver): Promise<Server> {
  const server = createServer((client) => {
    client.pause()
    client.on('error', () => undefined)
    // Looked up for every connection: a restarted tunnel listens on new local ports.
    route().then((via) => connectThrough(via, host, port)).then((remote) => {
      remote.on('error', () => client.destroy())
      client.on('error', () => remote.destroy())
      remote.on('close', () => client.destroy())
      client.on('close', () => remote.destroy())
      client.pipe(remote)
      remote.pipe(client)
      client.resume()
      remote.resume()
    }, (error: unknown) => {
      observer.onFailure?.(error)
      client.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return server
}

interface Bridge {
  server: proxyChain.Server
  tunnel?: Server
}

const bridges = new Map<string, Bridge>()

export function upstreamProxyUrl(proxy: ProxyConfig): string | undefined {
  if (proxy.protocol === 'direct') return undefined
  const credentials = proxy.username || proxy.password
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : ''
  const host = isIP(proxy.host) === 6 ? `[${proxy.host}]` : proxy.host
  // socks5h: the proxy resolves site names. With plain socks5, proxy-chain resolves http:// sites
  // on this computer first, and in China that answer is often poisoned (google.com never loads).
  const protocol = proxy.protocol === 'socks5' ? 'socks5h' : proxy.protocol
  return `${protocol}://${credentials}${host}:${proxy.port}`
}

/** Proxies that a check reached only directly: later connections skip the local proxy too. */
const directOnly = new Set<string>()
const proxyKey = (proxy: Pick<ProxyConfig, 'host' | 'port'>) => `${proxy.host.toLowerCase()}:${proxy.port}`

export function rememberDirectRoute(proxy: Pick<ProxyConfig, 'host' | 'port'>, direct: boolean): void {
  if (direct) directOnly.add(proxyKey(proxy))
  else directOnly.delete(proxyKey(proxy))
}

/**
 * The local proxy a connection to this window proxy would go through, if any. A proxy set to
 * 网络加速 gets the tunnel or an error, never a quiet direct connection.
 */
export async function localProxyFor(proxy: ProxyConfig): Promise<LocalProxy | undefined> {
  const accelerated = proxy.tunnel?.enabled === true && proxy.protocol !== 'direct' && Boolean(proxy.port) && !isLocalAddress(proxy.host)
  if (accelerated) {
    // An HTTPS proxy checks its certificate against its own name, which a forwarded port would break.
    if (proxy.protocol === 'https') throw new Error('HTTPS 代理暂不支持网络加速，请关闭这个窗口的网络加速，或改用 HTTP / SOCKS5')
    if (!resolveLocalProxy) throw new Error('获取不到代理 IP（网络加速未开启）')
    return resolveLocalProxy(proxy.host, proxy.port!, proxy.tunnel)
  }
  if (directOnly.has(proxyKey(proxy))) return undefined
  if (proxy.protocol === 'direct' || proxy.protocol === 'https' || !proxy.port || isLocalAddress(proxy.host) || !resolveLocalProxy) return undefined
  const via = await resolveLocalProxy(proxy.host, proxy.port, proxy.tunnel).catch(() => undefined)
  if (!via || (via.host === proxy.host && via.port === proxy.port)) return undefined
  return via
}

export async function openProxyBridge(proxy: ProxyConfig, observer: ProxyBridgeObserver = {}, options: { direct?: boolean } = {}): Promise<string | undefined> {
  if (proxy.protocol === 'direct') return undefined
  const via = options.direct ? undefined : await localProxyFor(proxy)
  const tunnel = via && proxy.port
    // 网络加速: a connection the tunnel cannot take fails rather than going out directly.
    ? await openTunnel(async () => proxy.tunnel?.enabled ? (await localProxyFor(proxy))! : await localProxyFor(proxy).catch(() => undefined) ?? via, proxy.host, proxy.port, observer)
    : undefined
  const target = tunnel ? { ...proxy, host: '127.0.0.1', port: (tunnel.address() as AddressInfo).port } : proxy
  const upstream = upstreamProxyUrl(target)!
  const server = new proxyChain.Server({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: () => ({ upstreamProxyUrl: upstream })
  })
  server.on('requestFailed', ({ error }: { error: unknown }) => observer.onFailure?.(error))
  server.on('connectionClosed', ({ stats }: { stats?: proxyChain.ConnectionStats }) => {
    const transferred = (stats?.trgRxBytes ?? 0) + (stats?.trgTxBytes ?? 0)
    if (transferred > 0) observer.onTraffic?.()
  })
  try {
    await server.listen()
  } catch (error) {
    tunnel?.close()
    throw error
  }
  const url = `http://127.0.0.1:${server.port}`
  bridges.set(url, { server, tunnel })
  return url
}

export async function closeProxyBridge(url?: string): Promise<void> {
  if (!url) return
  const bridge = bridges.get(url)
  bridges.delete(url)
  await bridge?.server.close(true).catch(() => undefined)
  bridge?.tunnel?.close()
}
