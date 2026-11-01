import { createConnection, createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProxyProtocol, parseApiProxyAnswer, proxyRefusal } from './api-proxy'
import { setLocalProxyResolver } from './proxy-bridge'

describe('extraction API proxies', () => {
  it('reads the first proxy of the common answers', () => {
    expect(parseApiProxyAnswer('45.12.34.56:8080\r\n45.12.34.57:8081\r\n')).toEqual({ host: '45.12.34.56', port: 8080, username: '', password: '' })
    expect(parseApiProxyAnswer('45.12.34.56:8080:user:p:ss')).toEqual({ host: '45.12.34.56', port: 8080, username: 'user', password: 'p:ss' })
    expect(parseApiProxyAnswer('socks5://gate.example.com:1080')).toMatchObject({ host: 'gate.example.com', port: 1080 })
    expect(parseApiProxyAnswer('{"code":0,"data":[{"ip":"1.2.3.4","port":3000}]}')).toMatchObject({ host: '1.2.3.4', port: 3000 })
    expect(() => parseApiProxyAnswer('白名单未添加')).toThrow('白名单未添加')
  })

  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
    setLocalProxyResolver(undefined)
  })
  const listen = (answer: (data: Buffer) => Buffer | string) => new Promise<number>((resolve) => {
    const server = createServer((socket) => socket.once('data', (data) => socket.end(answer(data))))
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })

  it('tells SOCKS5 from HTTP by asking the port', async () => {
    const socks = await listen(() => Buffer.from([0x05, 0x00]))
    expect(await detectProxyProtocol({ host: '127.0.0.1', port: socks, username: '', password: '' })).toBe('socks5')
    const http = await listen((data) => data[0] === 0x05 ? Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n') : 'HTTP/1.1 200 Connection established\r\n\r\n')
    expect(await detectProxyProtocol({ host: '127.0.0.1', port: http, username: '', password: '' })).toBe('http')
  })

  it('shows why a provider turned the connection away', async () => {
    const refused = 'HTTP/1.1 403 Forbidden \nContent-Type: text/plain; charset=utf-8\nProxy-Authenticate: Basic realm="proxy"\n\nmsg: forbidden ip=223.88.164.164 not supported'
    expect(proxyRefusal(Buffer.from(refused))).toBe('msg: forbidden ip=223.88.164.164 not supported')
    expect(proxyRefusal(Buffer.from('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'))).toBe('HTTP/1.1 407 Proxy Authentication Required')
    expect(proxyRefusal(Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'))).toBeUndefined()
    const port = await listen(() => refused)
    await expect(detectProxyProtocol({ host: '127.0.0.1', port, username: '', password: '' })).rejects.toThrow('拒绝了连接：msg: forbidden ip=223.88.164.164 not supported。多半是 IP 白名单没加')
  })

  it('asks through 网络加速 when the window uses it, and never directly when that is off', async () => {
    const socks = await listen(() => Buffer.from([0x05, 0x00]))
    // A stand-in for the tunnel's local port: takes any CONNECT to the SOCKS5 server above.
    const asked: string[] = []
    const tunnel = createServer((client) => client.once('data', (data) => {
      asked.push(data.toString().split(' ')[1])
      const upstream = createConnection(socks, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        client.pipe(upstream).pipe(client)
      })
    }))
    servers.push(tunnel)
    const tunnelPort = await new Promise<number>((resolve) => tunnel.listen(0, '127.0.0.1', () => resolve((tunnel.address() as { port: number }).port)))
    const endpoint = { host: '203.0.113.5', port: 31002, username: '', password: '' }
    const route = { enabled: true, mode: 'manual' as const, node: 'US' }
    let running = true
    setLocalProxyResolver(async (_host, _port, wanted) => {
      if (!wanted?.enabled) return undefined
      if (!running) throw new Error('获取不到代理 IP（网络加速未开启）')
      return { type: 'http', host: '127.0.0.1', port: tunnelPort }
    })
    expect(await detectProxyProtocol(endpoint, route)).toBe('socks5')
    expect(asked).toEqual(['203.0.113.5:31002'])
    running = false
    await expect(detectProxyProtocol(endpoint, route)).rejects.toThrow('获取不到代理 IP（网络加速未开启）')
  })
})
