import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProxyProtocol, parseApiProxyAnswer } from './api-proxy'

describe('extraction API proxies', () => {
  it('reads the first proxy of the common answers', () => {
    expect(parseApiProxyAnswer('45.12.34.56:8080\r\n45.12.34.57:8081\r\n')).toEqual({ host: '45.12.34.56', port: 8080, username: '', password: '' })
    expect(parseApiProxyAnswer('45.12.34.56:8080:user:p:ss')).toEqual({ host: '45.12.34.56', port: 8080, username: 'user', password: 'p:ss' })
    expect(parseApiProxyAnswer('socks5://gate.example.com:1080')).toMatchObject({ host: 'gate.example.com', port: 1080 })
    expect(parseApiProxyAnswer('{"code":0,"data":[{"ip":"1.2.3.4","port":3000}]}')).toMatchObject({ host: '1.2.3.4', port: 3000 })
    expect(() => parseApiProxyAnswer('白名单未添加')).toThrow('白名单未添加')
  })

  const servers: Server[] = []
  afterEach(() => { for (const server of servers.splice(0)) server.close() })
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
})
