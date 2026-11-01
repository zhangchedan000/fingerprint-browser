import { connect, type Socket } from 'node:net'
import type { ProxyConfig, TunnelRoute } from '../shared/types'
import { connectThrough, localProxyFor } from './proxy-bridge'

/**
 * Proxies from a provider's extraction API ("API 提取"): the URL answers with one proxy per line,
 * e.g. "45.12.34.56:8080" or "45.12.34.56:8080:user:pass". Each window launch takes a fresh one;
 * how long it lives is the provider's business. Providers seldom say whether the port speaks
 * SOCKS5 or HTTP, so it is asked directly.
 */
export interface ApiProxyEndpoint {
  protocol: 'socks5' | 'http'
  host: string
  port: number
  username: string
  password: string
}

/** The first proxy in an extraction API's answer (text, or the common JSON shapes). */
export function parseApiProxyAnswer(text: string): Omit<ApiProxyEndpoint, 'protocol'> {
  const body = text.trim()
  let line = body.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? ''
  if (body.startsWith('{') || body.startsWith('[')) {
    // {"data":[{"ip":"1.2.3.4","port":8080}]} and similar.
    const json = JSON.parse(body) as unknown
    const first = (value: unknown): Record<string, unknown> | undefined => {
      if (Array.isArray(value)) return first(value[0])
      if (!value || typeof value !== 'object') return undefined
      const record = value as Record<string, unknown>
      if ((record.ip || record.host) && record.port) return record
      for (const key of ['data', 'list', 'proxies', 'result']) {
        const found = first(record[key])
        if (found) return found
      }
      return undefined
    }
    const found = first(json)
    if (!found) throw new Error(`API 返回内容里没有代理：${body.slice(0, 120)}`)
    line = [found.ip ?? found.host, found.port, found.user ?? found.username ?? '', found.pass ?? found.password ?? ''].join(':')
  }
  const [host, port, username = '', ...rest] = line.replace(/^\w+:\/\//, '').split(':')
  const portNumber = Number(port)
  if (!host || !/^[\w.-]+$/.test(host) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    // Providers answer errors as plain text ("白名单未添加", "余额不足"): show it as it is.
    throw new Error(`API 没有返回可用的代理：${body.slice(0, 120) || '空内容'}`)
  }
  return { host, port: portNumber, username, password: rest.join(':') }
}

/**
 * A connection to the proxy the way the window reaches it: through 网络加速 when the window uses
 * it (some providers refuse connections from mainland China), otherwise directly.
 */
async function openSocket(host: string, port: number, timeoutMs: number, route?: TunnelRoute): Promise<Socket> {
  const via = await localProxyFor({ protocol: 'socks5', host, port, username: '', password: '', ...(route ? { tunnel: route } : {}) })
  if (via) {
    const socket = await connectThrough(via, host, port)
    socket.resume()
    return socket
  }
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接代理超时')) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

/** The first bytes the server answers to `hello`, or undefined when it says nothing in time. */
async function firstAnswer(host: string, port: number, hello: Buffer, route?: TunnelRoute, timeoutMs = 6000): Promise<Buffer | undefined> {
  const socket = await openSocket(host, port, timeoutMs, route)
  try {
    return await new Promise<Buffer | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs)
      socket.once('data', (data: Buffer) => { clearTimeout(timer); resolve(data) })
      socket.once('close', () => { clearTimeout(timer); resolve(undefined) })
      socket.once('error', () => { clearTimeout(timer); resolve(undefined) })
      socket.write(hello)
    })
  } finally {
    socket.destroy()
  }
}

/**
 * What a proxy said when it turned the connection away, e.g. "HTTP/1.1 403 Forbidden … msg: forbidden
 * ip=… not supported" (the provider refuses this computer's IP): the body, else the status line.
 */
export function proxyRefusal(answer: Buffer | undefined): string | undefined {
  const text = answer?.toString('latin1') ?? ''
  const status = /^HTTP\/1\.[01] (\d{3})[^\r\n]*/.exec(text)
  if (!status || Number(status[1]) < 400) return undefined
  const body = text.split(/\r?\n\r?\n/).slice(1).join(' ').replace(/\s+/g, ' ').trim()
  return (body || status[0].trim()).slice(0, 160)
}

/** SOCKS5 when the port answers a SOCKS5 greeting, HTTP when it answers a CONNECT. */
export async function detectProxyProtocol(endpoint: Omit<ApiProxyEndpoint, 'protocol'>, route?: TunnelRoute): Promise<'socks5' | 'http'> {
  const methods = endpoint.username ? [0x00, 0x02] : [0x00]
  const socks = await firstAnswer(endpoint.host, endpoint.port, Buffer.from([0x05, methods.length, ...methods]), route).catch((error: Error) => {
    // 网络加速 not running and the like already say what is wrong.
    if (error.message.startsWith('获取不到代理 IP') || error.message.includes('网络加速')) throw error
    throw new Error(`连不上 API 给的代理 ${endpoint.host}:${endpoint.port}（${error.message}）`)
  })
  if (socks && socks[0] === 0x05 && socks.length >= 2 && socks[1] !== 0xff) return 'socks5'
  const auth = endpoint.username ? `Proxy-Authorization: Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}\r\n` : ''
  const http = await firstAnswer(endpoint.host, endpoint.port, Buffer.from(`CONNECT www.google.com:443 HTTP/1.1\r\nHost: www.google.com:443\r\n${auth}\r\n`), route).catch(() => undefined)
  if (http && /^HTTP\/1\.[01] /.test(http.toString('latin1')) && !proxyRefusal(http)) return 'http'
  const refusal = proxyRefusal(socks) ?? proxyRefusal(http)
  // A refusal that is not about the account is the provider turning this computer's IP away.
  if (refusal && /\b407\b|auth/i.test(refusal)) throw new Error(`API 给的代理 ${endpoint.host}:${endpoint.port} 拒绝了连接：${refusal}`)
  if (refusal) throw new Error(`API 给的代理 ${endpoint.host}:${endpoint.port} 拒绝了连接：${refusal}。多半是 IP 白名单没加：请把这台电脑的公网 IP 加到服务商白名单（开着网络加速时，是加速节点的 IP）`)
  throw new Error(`API 给的代理 ${endpoint.host}:${endpoint.port} 既不是 SOCKS5 也不是 HTTP 代理`)
}

/**
 * Asks the extraction API for a proxy and works out its protocol, reaching the proxy the way the
 * window will (route: its 网络加速).
 */
export async function resolveApiProxy(apiUrl: string, route?: TunnelRoute, fetchImpl: typeof fetch = fetch): Promise<ApiProxyEndpoint> {
  const response = await fetchImpl(apiUrl, { redirect: 'follow', signal: AbortSignal.timeout(20_000) }).catch((error: Error) => {
    throw new Error(`请求代理 API 失败：${error.message}`)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`代理 API 返回 HTTP ${response.status}：${text.trim().slice(0, 120)}`)
  const endpoint = parseApiProxyAnswer(text)
  return { ...endpoint, protocol: await detectProxyProtocol(endpoint, route) }
}

/** The proxy a window uses this time: an API proxy's fresh endpoint, other proxies as they are. */
export async function withApiEndpoint<T extends ProxyConfig>(config: T): Promise<T> {
  if (!config.apiUrl) return config
  return { ...config, ...await resolveApiProxy(config.apiUrl, config.tunnel) }
}
