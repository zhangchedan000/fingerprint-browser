import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as httpServer, type Server as HttpServer } from 'node:http'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_TUNNEL_GROUP, mihomoConfig, validateTunnelSource } from './tunnel-config'
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
      mixedPort: 1000, autoPort: 1002, slotPorts: [1003, 1004], controllerPort: 1001, secret: 's',
      sources: [{ id: 'a', name: 'Mine', kind: 'links', content: 'vless://x' }, { id: 'b', name: 'Sub', kind: 'subscription', content: 'https://s.example' }]
    }) as Record<string, any>
    expect(config['bind-address']).toBe('127.0.0.1')
    expect(config['allow-lan']).toBe(false)
    expect(config['external-controller']).toBe('127.0.0.1:1001')
    expect(config.rules).toEqual(['MATCH,TUNNEL'])
    expect(config['proxy-groups'][0].use).toEqual(['source-a', 'source-b'])
    expect(config['proxy-groups'][0]).toMatchObject({ name: AUTO_TUNNEL_GROUP, type: 'url-test', interval: 300, tolerance: 50, lazy: false })
    expect(config['proxy-groups'][1]).toMatchObject({ name: 'TUNNEL', type: 'select', proxies: [AUTO_TUNNEL_GROUP] })
    expect(config['proxy-providers']['source-b']).toMatchObject({ type: 'http', url: 'https://s.example' })
    expect(config['proxy-providers']['source-a'].override['additional-prefix']).toBe('Mine · ')
    // Per-window ports: the fastest node, and node slots that reject until pointed at a node.
    expect(config['proxy-groups'][2]).toMatchObject({ name: 'TUNNEL-NODE-1', type: 'select', proxies: ['REJECT'], use: ['source-a', 'source-b'] })
    expect(config.listeners).toEqual([
      { name: 'auto', type: 'mixed', listen: '127.0.0.1', port: 1002, udp: false, proxy: AUTO_TUNNEL_GROUP },
      { name: 'node-1', type: 'mixed', listen: '127.0.0.1', port: 1003, udp: false, proxy: 'TUNNEL-NODE-1' },
      { name: 'node-2', type: 'mixed', listen: '127.0.0.1', port: 1004, udp: false, proxy: 'TUNNEL-NODE-2' }
    ])
  })
})

// The real core runs on CI (windows-build fetches it): TUNNEL_CORE_BIN=…/mihomo.exe
const core = process.env.TUNNEL_CORE_BIN ? resolve(process.env.TUNNEL_CORE_BIN) : ''

describe.skipIf(!core)('tunnel core (mihomo)', () => {
  const servers: Server[] = []
  let vault = ''
  let tunnel: TunnelManager | undefined
  const listenHttp = (server: HttpServer) => new Promise<number>((done) => {
    servers.push(server as unknown as Server)
    server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port))
  })
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

  it('gives each window its own node: fixed nodes on their own ports, auto on the fastest', async () => {
    vault = await mkdtemp(join(tmpdir(), 'tunnel-route-'))
    const echo = await listen(createServer((socket) => socket.pipe(socket)))
    // Two SOCKS5 "nodes" that record which of them carried a connection.
    const carried: string[] = []
    const socksNode = (label: string) => createServer((client) => {
      client.on('error', () => undefined)
      client.once('data', () => {
        client.write(Buffer.from([5, 0]))
        client.once('data', (request) => {
          const port = request.readUInt16BE(request.length - 2)
          if (port === echo) carried.push(label)
          const upstream = createConnection(port, '127.0.0.1', () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            client.pipe(upstream).pipe(client)
          })
          upstream.on('error', () => client.destroy())
        })
      })
    })
    const a = await listen(socksNode('a'))
    const b = await listen(socksNode('b'))
    // Stands in for api.ipify.org: answers with the address the request came from.
    const whoami = await listenHttp(httpServer((request, response) => response.end(JSON.stringify({ ip: request.socket.remoteAddress?.replace(/^::ffff:/, '') }))))
    tunnel = new TunnelManager(vault, identitySecretCodec, core, undefined, undefined, undefined, `http://127.0.0.1:${whoami}/`)
    await tunnel.addSource({ name: 'T', kind: 'links', content: `proxies:\n  - {name: a, type: socks5, server: 127.0.0.1, port: ${a}, udp: false}\n  - {name: b, type: socks5, server: 127.0.0.1, port: ${b}, udp: false}\n` })
    await expect(tunnel.routeProxy({ mode: 'auto' })).rejects.toThrow('网络加速未开启')
    await tunnel.setEnabled(true)
    await tunnel.select('T · a')
    const roundTrip = async (via: Awaited<ReturnType<TunnelManager['routeProxy']>>) => {
      const socket = await connectThrough(via, '127.0.0.1', echo)
      const reply = new Promise<string>((done) => socket.once('data', (data) => done(data.toString())))
      socket.resume()
      socket.write('hello')
      expect(await reply).toBe('hello')
      socket.destroy()
    }
    // The settings page fixed node a; a window fixed to b still goes out through b, and back.
    const viaB = await tunnel.routeProxy({ mode: 'manual', node: 'T · b' })
    await roundTrip(viaB)
    expect(carried.pop()).toBe('b')
    const viaA = await tunnel.routeProxy({ mode: 'manual', node: 'T · a' })
    expect(viaA.port).not.toBe(viaB.port)
    await roundTrip(viaA)
    expect(carried.pop()).toBe('a')
    expect((await tunnel.routeProxy({ mode: 'manual', node: 'T · b' })).port).toBe(viaB.port)
    await roundTrip(await tunnel.routeProxy({ mode: 'auto' }))
    expect(['a', 'b']).toContain(carried.pop())
    await expect(tunnel.routeProxy({ mode: 'manual', node: 'T · gone' })).rejects.toThrow('已不存在')
    // Each node's exit IP is looked up through its own probe port and kept.
    await tunnel.lookUpExitIps()
    const withIps = await tunnel.status()
    expect(withIps.nodes.map((node) => node.exitIp)).toEqual(['127.0.0.1', '127.0.0.1'])
    expect(JSON.parse(await readFile(join(vault, 'tunnel.json'), 'utf8')).exitIps['T · b'].ip).toBe('127.0.0.1')
    await tunnel.stop()
    await expect(tunnel.routeProxy({ mode: 'manual', node: 'T · b' })).rejects.toThrow('网络加速未开启')
  }, 60_000)

  it('reports a source with no usable node', async () => {
    vault = await mkdtemp(join(tmpdir(), 'tunnel-'))
    tunnel = new TunnelManager(vault, identitySecretCodec, core)
    await tunnel.addSource({ kind: 'links', content: 'proxies:\n  - {name: bad, type: nonsense, server: x, port: 1}\n' })
    await expect(tunnel.setEnabled(true)).rejects.toThrow()
    expect((await tunnel.status()).state).toBe('error')
  }, 60_000)

  it('selects the fastest healthy node, preserves manual choice, edits and rolls back invalid edits', async () => {
    vault = await mkdtemp(join(tmpdir(), 'tunnel-auto-'))
    // Local HTTP proxies answer the health-check URL with controlled delays; no Internet needed.
    const proxy = (latency: number) => createServer((socket) => {
      socket.on('error', () => undefined)
      socket.once('data', () => {
        setTimeout(() => {
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
          socket.once('data', () => socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n'))
        }, latency)
      })
    })
    const fast = await listen(proxy(10))
    const slow = await listen(proxy(200))
    const content = `proxies:\n  - {name: fast, type: http, server: 127.0.0.1, port: ${fast}}\n  - {name: slow, type: http, server: 127.0.0.1, port: ${slow}}\n  - {name: dead, type: http, server: 127.0.0.1, port: 1}\n`
    const healthUrl = 'http://health.example.test/generate_204'
    const make = () => new TunnelManager(vault, identitySecretCodec, core, undefined, undefined, healthUrl)
    tunnel = make()
    const added = await tunnel.addSource({ name: 'Local', kind: 'links', content })
    const id = added.sources[0].id
    expect(added.selectionMode).toBe('auto')
    expect(JSON.stringify(added)).not.toContain(content)
    await tunnel.setEnabled(true)
    const automatic = await tunnel.testDelays()
    expect(automatic.selectionMode).toBe('auto')
    expect(automatic.selected).toBe('Local · fast')
    expect(automatic.nodes.find((node) => node.name === 'Local · dead')?.delay).toBe(0)
    expect(automatic.nodes.every((node) => node.sourceId === id)).toBe(true)
    await tunnel.select('Local · slow')
    expect((await tunnel.testDelays()).selected).toBe('Local · slow')
    await tunnel.stop()
    tunnel = make()
    await tunnel.initialize()
    expect(await tunnel.status()).toMatchObject({ selectionMode: 'manual', selected: 'Local · slow' })
    await expect(tunnel.select('does not exist')).rejects.toThrow('节点不存在')
    expect((await tunnel.status()).selected).toBe('Local · slow')
    await tunnel.updateSource(id, { name: 'Edited', kind: 'links', content })
    expect(tunnel.source(id)).toMatchObject({ name: 'Edited', content: content.trim() })
    expect(await tunnel.status()).toMatchObject({ selectionMode: 'manual', selected: 'Edited · slow' })
    await expect(tunnel.updateSource(id, { name: 'Broken', kind: 'links', content: 'proxies:\n  - {name: invalid, type: nonsense, server: x, port: 1}' })).rejects.toThrow()
    expect(tunnel.source(id).name).toBe('Edited')
    expect(await tunnel.status()).toMatchObject({ state: 'running', selected: 'Edited · slow' })
    expect(await tunnel.autoSelect()).toMatchObject({ selectionMode: 'auto', selected: 'Edited · fast' })
    await tunnel.stop()
    tunnel = make()
    await tunnel.initialize()
    expect((await tunnel.testDelays()).selectionMode).toBe('auto')
    expect((await tunnel.status()).selected).toBe('Edited · fast')
  }, 60_000)
})
