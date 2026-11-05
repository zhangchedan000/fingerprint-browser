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
      { name: 'auto', type: 'mixed', listen: '127.0.0.1', port: 1002, udp: true, proxy: AUTO_TUNNEL_GROUP },
      { name: 'node-1', type: 'mixed', listen: '127.0.0.1', port: 1003, udp: true, proxy: 'TUNNEL-NODE-1' },
      { name: 'node-2', type: 'mixed', listen: '127.0.0.1', port: 1004, udp: true, proxy: 'TUNNEL-NODE-2' }
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

describe('node sources travel with a window', () => {
  it('gives the source of a fixed node, all for auto, and adds missing ones by name elsewhere', async () => {
    const roots = [await mkdtemp(join(tmpdir(), 'fb-tunnel-a-')), await mkdtemp(join(tmpdir(), 'fb-tunnel-b-'))]
    try {
      const a = new TunnelManager(roots[0], identitySecretCodec, '/nonexistent/mihomo')
      await a.initialize()
      await a.addSource({ name: 'US', kind: 'links', content: 'proxies:\n  - {name: v, type: socks5, server: 127.0.0.1, port: 1080}\n' })
      await a.addSource({ name: 'JP', kind: 'subscription', content: 'https://sub.example.com/token' })
      expect(a.sourcesFor({ enabled: true, mode: 'manual', node: 'US · v' }).map((source) => source.name)).toEqual(['US'])
      expect(a.sourcesFor({ enabled: true, mode: 'auto' }).map((source) => source.name)).toEqual(['US', 'JP'])
      expect(a.sourcesFor({ enabled: false, mode: 'auto' })).toEqual([])

      const b = new TunnelManager(roots[1], identitySecretCodec, '/nonexistent/mihomo')
      await b.initialize()
      await b.addSource({ name: 'JP', kind: 'links', content: 'proxies:\n  - {name: own, type: socks5, server: 127.0.0.1, port: 1081}\n' })
      await b.adoptSources([...a.sourcesFor({ enabled: true, mode: 'auto' }), { name: 'bad', kind: 'links', content: '' }])
      const status = await b.status()
      expect(status.sources.map((source) => source.name)).toEqual(['JP', 'US'])
      // B's own JP stays as it was.
      expect(b.source(status.sources[0].id).content).toContain('own')

      // The account's sources changed on A last: B becomes the same (JP replaced, US kept, none extra).
      expect(await b.mirrorSources(a.sourcesFor({ enabled: true, mode: 'auto' }))).toBe(true)
      const mirrored = await b.status()
      expect(mirrored.sources.map((source) => source.name)).toEqual(['US', 'JP'])
      expect(b.source(mirrored.sources[1].id).content).toBe('https://sub.example.com/token')
      expect(await b.mirrorSources(a.sourcesFor({ enabled: true, mode: 'auto' }))).toBe(false)
      expect(await b.mirrorSources([])).toBe(true)
      expect((await b.status()).sources).toEqual([])
    } finally {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
    }
  })
})

describe.skipIf(!core)('subscription nodes as window exits (订阅)', () => {
  const servers: Server[] = []
  const managers: TunnelManager[] = []
  const vaults: string[] = []
  const listen = (server: Server) => new Promise<number>((done) => {
    servers.push(server)
    server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port))
  })
  /** A SOCKS5 node that records where it was asked to go. */
  const socksNode = async (asked: string[]) => listen(createServer((client) => {
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
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.stop()
    for (const server of servers.splice(0)) server.close()
    for (const vault of vaults.splice(0)) await rm(vault, { recursive: true, force: true })
  })
  const roundTrip = async (via: { type: 'http' | 'socks4' | 'socks5'; host: string; port: number }, echo: number, text: string) => {
    const attempt = (async () => {
      const socket = await connectThrough(via, '127.0.0.1', echo)
      const reply = new Promise<string>((done) => socket.once('data', (data) => done(data.toString())))
      socket.resume()
      socket.write(text)
      const answer = await reply
      socket.destroy()
      return answer
    })()
    return Promise.race([attempt, new Promise<string>((_, fail) => setTimeout(() => fail(new Error(`no answer: ${text}`)), 15_000))])
  }

  it('goes out from the chosen node: directly, through 网络加速 自动 or a fixed acceleration node, UDP nodes too; never a node that is gone', async () => {
    const echo = await listen(createServer((socket) => socket.pipe(socket)))
    const exitAsked: string[] = []
    const accelA: string[] = []
    const accelB: string[] = []
    const exitNode = await socksNode(exitAsked)
    const accelNodeA = await socksNode(accelA)
    const accelNodeB = await socksNode(accelB)
    for (let index = 0; index < 3; index++) vaults.push(await mkdtemp(join(tmpdir(), 'subscription-')))
    // A Hysteria2 node (QUIC over UDP): a third core serving it on this computer, self-signed.
    const { execFileSync, spawn } = await import('node:child_process')
    const { writeFile } = await import('node:fs/promises')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=hy2.test',
      '-keyout', join(vaults[2], 'key.pem'), '-out', join(vaults[2], 'cert.pem')], { stdio: 'ignore' })
    const hy2Port = await new Promise<number>((done) => { const probe = createServer().listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => done(port)) }) })
    await writeFile(join(vaults[2], 'config.yaml'), JSON.stringify({
      'log-level': 'warning', mode: 'rule', rules: ['MATCH,DIRECT'],
      listeners: [{ name: 'hy2-in', type: 'hysteria2', listen: '127.0.0.1', port: hy2Port, users: { tester: 'secret-pass' }, certificate: join(vaults[2], 'cert.pem'), 'private-key': join(vaults[2], 'key.pem') }]
    }))
    const hy2 = spawn(core, ['-d', vaults[2], '-f', join(vaults[2], 'config.yaml')], { stdio: 'ignore' })
    servers.push({ close: () => hy2.kill() } as unknown as Server)
    await new Promise((done) => setTimeout(done, 1500))

    // 网络加速 (its own core) with two acceleration nodes; a window's route is 自动 or one of them.
    const accel = new TunnelManager(vaults[0], identitySecretCodec, core)
    managers.push(accel)
    await accel.addSource({ name: 'Accel', kind: 'links', content: `proxies:\n  - {name: a1, type: socks5, server: 127.0.0.1, port: ${accelNodeA}, udp: true}\n  - {name: b1, type: direct, udp: true}\n  - {name: c1, type: socks5, server: 127.0.0.1, port: ${accelNodeA}}\n` })
    expect((await accel.setEnabled(true)).state).toBe('running')
    // Whether each acceleration node forwards UDP, as the core reports it (the editor warns about c1 for a UDP node).
    expect(Object.fromEntries((await accel.status()).nodes.map((node) => [node.name, node.udp]))).toEqual({ 'Accel · a1': true, 'Accel · b1': true, 'Accel · c1': false })
    const subscriptions = new TunnelManager(vaults[1], identitySecretCodec, core, undefined, undefined, undefined, undefined, {
      slotCount: 8, alwaysOn: true, chainRoute: async (route) => (await accel.routeProxy(route)).port
    })
    managers.push(subscriptions)
    const status = await subscriptions.addSource({ name: '机场', kind: 'links', content: [
      'proxies:',
      `  - {name: 香港 01, type: socks5, server: 127.0.0.1, port: ${exitNode}, udp: false}`,
      `  - {name: 日本 HY2, type: hysteria2, server: 127.0.0.1, port: ${hy2Port}, password: secret-pass, sni: hy2.test, skip-cert-verify: true}`,
      ''
    ].join('\n') })
    expect(status.enabled).toBe(true)
    await expect(subscriptions.addSource({ name: '机场', kind: 'links', content: 'proxies:\n  - {name: x, type: socks5, server: 127.0.0.1, port: 1, udp: false}\n' })).rejects.toThrow('同名')

    // Directly from the node.
    const direct = await subscriptions.nodeProxy({ source: '机场', node: '香港 01' })
    expect(await roundTrip(direct, echo, 'from the node')).toBe('from the node')
    expect(exitAsked).toContain(`127.0.0.1:${echo}`)
    expect((await subscriptions.status()).nodes.map((node) => node.name)).toEqual(['机场 · 香港 01', '机场 · 日本 HY2'])
    // No speed test goes through 网络加速: the acceleration nodes have not been asked for the subscription node.
    expect(accelA).not.toContain(`127.0.0.1:${exitNode}`)

    // Through 网络加速 fixed to a1: the acceleration node a1 carries the connection to the subscription node.
    const viaA = await subscriptions.nodeProxy({ source: '机场', node: '香港 01' }, { enabled: true, mode: 'manual', node: 'Accel · a1' })
    expect(viaA.port).not.toBe(direct.port)
    expect(await roundTrip(viaA, echo, 'through a1')).toBe('through a1')
    expect(accelA).toContain(`127.0.0.1:${exitNode}`)
    // The window already on the node directly keeps working after the route was added (the core was reloaded, not replaced).
    expect(await roundTrip(direct, echo, 'still direct')).toBe('still direct')

    // Through 网络加速 自动, and fixed to b1 (another route, another port).
    const viaAuto = await subscriptions.nodeProxy({ source: '机场', node: '香港 01' }, { enabled: true, mode: 'auto' })
    expect(await roundTrip(viaAuto, echo, 'through auto')).toBe('through auto')
    const asked = accelA.length
    const viaB = await subscriptions.nodeProxy({ source: '机场', node: '香港 01' }, { enabled: true, mode: 'manual', node: 'Accel · b1' })
    expect(new Set([direct.port, viaA.port, viaAuto.port, viaB.port]).size).toBe(4)
    expect(await roundTrip(viaB, echo, 'through b1')).toBe('through b1')
    expect(accelA.slice(asked)).not.toContain(`127.0.0.1:${exitNode}`)

    // A Hysteria2 node (UDP): directly, and through 网络加速 fixed to b1 (UDP through the acceleration core).
    const hyDirect = await subscriptions.nodeProxy({ source: '机场', node: '日本 HY2' })
    expect(await roundTrip(hyDirect, echo, 'hy2 direct')).toBe('hy2 direct')
    const hyViaB = await subscriptions.nodeProxy({ source: '机场', node: '日本 HY2' }, { enabled: true, mode: 'manual', node: 'Accel · b1' })
    expect(await roundTrip(hyViaB, echo, 'hy2 through acceleration')).toBe('hy2 through acceleration')
    // Through an acceleration node without UDP the Hysteria2 node cannot connect: it fails, it does not go around 网络加速.
    // (Two windows opening on the same new route at once: both get their node once the route is added.)
    const [hyViaC, hkViaC] = await Promise.all([
      subscriptions.nodeProxy({ source: '机场', node: '日本 HY2' }, { enabled: true, mode: 'manual', node: 'Accel · c1' }),
      subscriptions.nodeProxy({ source: '机场', node: '香港 01' }, { enabled: true, mode: 'manual', node: 'Accel · c1' })
    ])
    await expect(roundTrip(hyViaC, echo, 'hy2 through c1')).rejects.toThrow()
    expect(await roundTrip(hkViaC, echo, 'tcp through c1')).toBe('tcp through c1')

    await expect(subscriptions.nodeProxy({ source: '机场', node: '不存在' })).rejects.toThrow('没有节点')
    await expect(subscriptions.nodeProxy({ source: '别的订阅', node: '香港 01' })).rejects.toThrow('已不存在')
    // Through 网络加速 when it cannot run: an error, never a direct connection.
    await accel.stop()
    await expect(subscriptions.nodeProxy({ source: '机场', node: '香港 01' }, { enabled: true, mode: 'manual', node: 'Accel · a1' })).rejects.toThrow()
  }, 120_000)

  it('a subscription link: the first start waits for its download; a link that gives no nodes is not added', async () => {
    const echo = await listen(createServer((socket) => socket.pipe(socket)))
    const exitAsked: string[] = []
    const accelA: string[] = []
    const exitNode = await socksNode(exitAsked)
    const accelNodeA = await socksNode(accelA)
    // The subscription answers a moment later (a real one is downloaded first); the other one has nothing.
    let refused = false
    const subscription = httpServer((request, response) => {
      if (refused) return void response.writeHead(403).end('Forbidden')
      if (request.url !== '/sub?token=t') return void response.writeHead(404).end('no')
      setTimeout(() => response.writeHead(200, { 'content-type': 'text/plain' })
        .end(`proxies:\n  - {name: 新加坡 01, type: socks5, server: 127.0.0.1, port: ${exitNode}, udp: false}\n`), 1500)
    })
    servers.push(subscription as unknown as Server)
    const web = await new Promise<number>((done) => subscription.listen(0, '127.0.0.1', () => done((subscription.address() as { port: number }).port)))
    for (let index = 0; index < 2; index++) vaults.push(await mkdtemp(join(tmpdir(), 'subscription-')))
    const accel = new TunnelManager(vaults[0], identitySecretCodec, core)
    managers.push(accel)
    await accel.addSource({ name: 'Accel', kind: 'links', content: `proxies:\n  - {name: a1, type: socks5, server: 127.0.0.1, port: ${accelNodeA}, udp: true}\n` })
    await accel.setEnabled(true)
    const subscriptions = new TunnelManager(vaults[1], identitySecretCodec, core, undefined, undefined, undefined, undefined, {
      slotCount: 4, alwaysOn: true, chainRoute: async (route) => (await accel.routeProxy(route)).port
    })
    managers.push(subscriptions)

    // 获取节点 first: what the link gives, nothing saved, nothing left behind.
    const preview = await subscriptions.previewSource({ name: 'EM', kind: 'subscription', content: `http://127.0.0.1:${web}/sub?token=t` })
    expect(preview).toEqual({ name: 'EM', nodes: [{ name: '新加坡 01', type: 'Socks5', udp: false }] })
    expect((await subscriptions.previewSource({ kind: 'links', content: `proxies:\n  - {name: x1, type: socks5, server: 127.0.0.1, port: 1, udp: true}\n` })).nodes.map((node) => node.name)).toEqual(['x1'])
    const failedAt = Date.now()
    await expect(subscriptions.previewSource({ name: '坏的', kind: 'subscription', content: `http://127.0.0.1:${web}/wrong` })).rejects.toThrow('没有取到节点')
    expect(Date.now() - failedAt).toBeLessThan(8000)
    expect((await subscriptions.status()).sources).toEqual([])
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(vaults[1]).catch(() => [])).filter((name) => name.startsWith('preview-'))).toEqual([])

    const status = await subscriptions.addSource({ name: 'EM', kind: 'subscription', content: `http://127.0.0.1:${web}/sub?token=t` })
    expect(status.state).toBe('running')
    expect(status.nodes.map((node) => node.name)).toEqual(['EM · 新加坡 01'])
    const direct = await subscriptions.nodeProxy({ source: 'EM', node: '新加坡 01' })
    expect(await roundTrip(direct, echo, 'from the subscription')).toBe('from the subscription')
    // Through 网络加速: the copy reads the downloaded subscription (no second download).
    const viaA = await subscriptions.nodeProxy({ source: 'EM', node: '新加坡 01' }, { enabled: true, mode: 'manual', node: 'Accel · a1' })
    expect(await roundTrip(viaA, echo, 'subscription through a1')).toBe('subscription through a1')
    expect(accelA).toContain(`127.0.0.1:${exitNode}`)

    // 刷新 while running downloads again; a stopped core (a link that failed) is started again by it.
    expect((await subscriptions.refreshSubscriptions()).state).toBe('running')
    await subscriptions.stop()
    expect((await subscriptions.refreshSubscriptions()).state).toBe('running')
    // The airport refuses the link for a while (403): the core starts from the last download, windows keep their node,
    // also through 网络加速.
    refused = true
    await subscriptions.stop()
    const cached = await subscriptions.refreshSubscriptions()
    expect(cached.state).toBe('running')
    expect(cached.nodes.map((node) => node.name)).toEqual(['EM · 新加坡 01'])
    expect(await roundTrip(await subscriptions.nodeProxy({ source: 'EM', node: '新加坡 01' }, { enabled: true, mode: 'manual', node: 'Accel · a1' }), echo, 'cached through a1')).toBe('cached through a1')
    refused = false

    // A link that gives no nodes: refused with the reason, the subscriptions as they were, still running.
    const refusedAt = Date.now()
    await expect(subscriptions.addSource({ name: '坏的', kind: 'subscription', content: `http://127.0.0.1:${web}/wrong` })).rejects.toThrow('取到节点')
    // (The core said the download failed: no waiting out the 20 seconds; the reason is in the message.)
    expect(Date.now() - refusedAt).toBeLessThan(12_000)
    await expect(subscriptions.addSource({ name: '坏的', kind: 'subscription', content: `http://127.0.0.1:${web}/wrong` })).rejects.toThrow('404')
    const after = await subscriptions.status()
    expect(after.sources.map((source) => source.name)).toEqual(['EM'])
    expect(after.state).toBe('running')
    expect(await roundTrip(await subscriptions.nodeProxy({ source: 'EM', node: '新加坡 01' }), echo, 'still there')).toBe('still there')
  }, 120_000)
})
