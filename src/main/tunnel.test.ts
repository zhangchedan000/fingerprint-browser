import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mihomoConfig, validateTunnelSource } from './tunnel-config'
import { TunnelManager } from './tunnel-manager'
import { connectThrough } from './proxy-bridge'
import { identitySecretCodec } from './secret-codec'

describe('tunnel sources', () => {
  it('accepts share links, Clash YAML and subscription URLs', () => {
    expect(validateTunnelSource({ kind: 'links', content: 'vless://uuid@example.com:443?security=reality#JP' }).name).toBe('手动节点')
    expect(validateTunnelSource({ kind: 'links', content: 'proxies:\n  - {name: a, type: ss, server: x, port: 1}' }).kind).toBe('links')
    expect(validateTunnelSource({ kind: 'subscription', content: 'https://sub.example.com/api?token=1' }).name).toBe('sub.example.com')
    expect(() => validateTunnelSource({ kind: 'links', content: 'hello' })).toThrow('没有识别到节点链接')
    expect(() => validateTunnelSource({ kind: 'subscription', content: 'ftp://x' })).toThrow('http://')
    expect(() => validateTunnelSource({ kind: 'other', content: 'x' })).toThrow()
  })

  it('builds a config that sends everything through the chosen node, on loopback only', () => {
    const config = mihomoConfig({
      mixedPort: 1000, controllerPort: 1001, secret: 's',
      sources: [{ id: 'a', name: 'Mine', kind: 'links', content: 'vless://x' }, { id: 'b', name: 'Sub', kind: 'subscription', content: 'https://s.example' }]
    }) as Record<string, any>
    expect(config['bind-address']).toBe('127.0.0.1')
    expect(config['allow-lan']).toBe(false)
    expect(config['external-controller']).toBe('127.0.0.1:1001')
    expect(config.rules).toEqual(['MATCH,TUNNEL'])
    expect(config['proxy-groups'][0].use).toEqual(['source-a', 'source-b'])
    expect(config['proxy-providers']['source-b']).toMatchObject({ type: 'http', url: 'https://s.example' })
    expect(config['proxy-providers']['source-a'].override['additional-prefix']).toBe('Mine · ')
  })
})

// The real core runs on CI (windows-build fetches it): TUNNEL_CORE_BIN=…/mihomo.exe
const core = process.env.TUNNEL_CORE_BIN ? resolve(process.env.TUNNEL_CORE_BIN) : ''

describe.skipIf(!core)('tunnel core (mihomo)', () => {
  const servers: Server[] = []
  let vault = ''
  let tunnel: TunnelManager | undefined
  const listen = (server: Server) => new Promise<number>((done) => {
    servers.push(server)
    server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port))
  })
  afterEach(async () => {
    await tunnel?.stop()
    for (const server of servers.splice(0)) server.close()
    if (vault) await rm(vault, { recursive: true, force: true })
  })

  it('carries a connection through the configured node', async () => {
    vault = await mkdtemp(join(tmpdir(), 'tunnel-'))
    const echo = await listen(createServer((socket) => socket.pipe(socket)))
    // A SOCKS5 "node" (an airport or the user's own server) that records where it was asked to go.
    const asked: string[] = []
    const node = await listen(createServer((client) => {
      client.on('error', () => undefined)
      client.once('data', () => {
        client.write(Buffer.from([5, 0]))
        client.once('data', (request) => {
          const host = request[3] === 1 ? [...request.subarray(4, 8)].join('.') : request.subarray(5, 5 + request[4]).toString()
          const port = request.readUInt16BE(request.length - 2)
          asked.push(`${host}:${port}`)
          const upstream = createConnection(port, host, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            client.pipe(upstream).pipe(client)
          })
          upstream.on('error', () => client.destroy())
        })
      })
    }))
    tunnel = new TunnelManager(vault, identitySecretCodec, core)
    await tunnel.addSource({ name: 'Test', kind: 'links', content: `proxies:\n  - {name: n1, type: socks5, server: 127.0.0.1, port: ${node}, udp: false}\n  - {name: n2, type: socks5, server: 127.0.0.1, port: ${node}, udp: false}\n` })
    const status = await tunnel.setEnabled(true)
    expect(status.state).toBe('running')
    expect(status.nodes.map((item) => item.name)).toEqual(['Test · n1', 'Test · n2'])
    expect((await tunnel.select('Test · n2')).selected).toBe('Test · n2')

    const via = tunnel.localProxy()!
    const socket = await connectThrough(via, '127.0.0.1', echo)
    const reply = new Promise<string>((done) => socket.once('data', (data) => done(data.toString())))
    socket.resume()
    socket.write('through the tunnel')
    expect(await reply).toBe('through the tunnel')
    socket.destroy()
    expect(asked).toContain(`127.0.0.1:${echo}`)

    // Saved encrypted-at-rest form (identity codec here) and the choice survive a restart.
    const saved = JSON.parse(await readFile(join(vault, 'tunnel.json'), 'utf8'))
    expect(saved.selected).toBe('Test · n2')
    await tunnel.stop()
    tunnel = new TunnelManager(vault, identitySecretCodec, core)
    await tunnel.initialize()
    expect((await tunnel.status()).state).toBe('running')
    expect((await tunnel.status()).selected).toBe('Test · n2')
  }, 60_000)

  it('reports a source with no usable node', async () => {
    vault = await mkdtemp(join(tmpdir(), 'tunnel-'))
    tunnel = new TunnelManager(vault, identitySecretCodec, core)
    await tunnel.addSource({ kind: 'links', content: 'proxies:\n  - {name: bad, type: nonsense, server: x, port: 1}\n' })
    await expect(tunnel.setEnabled(true)).rejects.toThrow()
    expect((await tunnel.status()).state).toBe('error')
  }, 60_000)
})
