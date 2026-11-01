import { createConnection, createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { closeProxyBridge, connectThrough, isLocalAddress, localProxyFor, openProxyBridge, parseProxyRule, setLocalProxyResolver } from './proxy-bridge'
import { proxyFailureReason } from './proxy-tester'
import type { ProxyConfig } from '../shared/types'

const proxy = (host: string, protocol: ProxyConfig['protocol'] = 'socks5'): ProxyConfig =>
  ({ protocol, host, port: 7085, username: 'u', password: 'p' }) as ProxyConfig

afterEach(() => setLocalProxyResolver(undefined))

describe('local (system) proxy', () => {
  it('reads Chromium proxy rules', () => {
    expect(parseProxyRule('DIRECT')).toBeUndefined()
    expect(parseProxyRule('PROXY 127.0.0.1:7890')).toEqual({ type: 'http', host: '127.0.0.1', port: 7890 })
    expect(parseProxyRule('SOCKS5 127.0.0.1:7891; DIRECT')).toEqual({ type: 'socks5', host: '127.0.0.1', port: 7891 })
    expect(parseProxyRule('HTTPS proxy.example:443;PROXY [::1]:8080')).toEqual({ type: 'http', host: '::1', port: 8080 })
  })

  it('never routes local or private proxies, HTTPS proxies or the local proxy itself through it', async () => {
    setLocalProxyResolver(async () => ({ type: 'http', host: '127.0.0.1', port: 7890 }))
    for (const host of ['127.0.0.1', '192.168.1.5', '10.0.0.2', '172.20.1.1', 'localhost']) expect(isLocalAddress(host)).toBe(true)
    expect(isLocalAddress('45.170.253.113')).toBe(false)
    expect(await localProxyFor(proxy('192.168.1.5'))).toBeUndefined()
    expect(await localProxyFor(proxy('45.170.253.113', 'https'))).toBeUndefined()
    expect(await localProxyFor(proxy('45.170.253.113'))).toEqual({ type: 'http', host: '127.0.0.1', port: 7890 })
  })

  it('opens a CONNECT tunnel through an HTTP local proxy', async () => {
    const servers: Server[] = []
    const listen = (server: Server) => new Promise<number>((resolve) => {
      servers.push(server)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    const echoPort = await listen(createServer((socket) => socket.pipe(socket)))
    let asked = ''
    const localPort = await listen(createServer((client) => {
      client.once('data', (chunk) => {
        asked = chunk.toString().split('\r\n')[0]
        const upstream = createConnection(echoPort, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n')
          client.pipe(upstream).pipe(client)
        })
      })
    }))
    const socket = await connectThrough({ type: 'http', host: '127.0.0.1', port: localPort }, 'example.com', 7085)
    const reply = new Promise<string>((resolve) => socket.once('data', (data) => resolve(data.toString())))
    socket.resume()
    socket.write('ping')
    expect(await reply).toBe('ping')
    expect(asked).toBe('CONNECT example.com:7085 HTTP/1.1')
    socket.destroy()
    for (const server of servers) server.close()
  })

  it('explains a failed check in plain words', () => {
    expect(proxyFailureReason('Proxy response (597) !== 200 when HTTP Tunneling', false)).toBe('代理认证失败，请检查用户名和密码')
    expect(proxyFailureReason('Proxy response (595) !== 200 when HTTP Tunneling', false)).toContain('Clash')
    expect(proxyFailureReason('Proxy response (595) !== 200 when HTTP Tunneling', true)).toContain('已经过本机代理')
    expect(proxyFailureReason('Proxy response (594) !== 200', false)).toContain('拒绝连接')
    expect(proxyFailureReason('something else', false)).toBeUndefined()
  })

  it('lets a SOCKS5 proxy resolve site names, also for plain http:// pages', async () => {
    const asked: string[] = []
    const socks = createServer((client) => {
      client.on('error', () => undefined)
      client.once('data', () => {
        client.write(Buffer.from([5, 0]))
        client.once('data', (request) => {
          asked.push(request[3] === 3 ? `name ${request.subarray(5, 5 + request[4]).toString()}` : `address type ${request[3]}`)
          client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]))
        })
      })
    })
    await new Promise<void>((resolve) => socks.listen(0, '127.0.0.1', () => resolve()))
    const bridge = await openProxyBridge({ protocol: 'socks5', host: '127.0.0.1', port: (socks.address() as { port: number }).port, username: '', password: '' } as ProxyConfig)
    const { request } = await import('node:http')
    const target = new URL(bridge!)
    await new Promise<void>((resolve) => {
      const req = request({ host: target.hostname, port: Number(target.port), path: 'http://site-name.invalid/', headers: { host: 'site-name.invalid' } }, (res) => { res.resume(); res.on('end', resolve) })
      req.on('error', () => resolve())
      req.end()
    })
    await closeProxyBridge(bridge)
    socks.close()
    expect(asked).toEqual(['name site-name.invalid'])
  })
})
