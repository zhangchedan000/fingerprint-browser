import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, isIP } from 'node:net'
import { join } from 'node:path'
import type { TunnelNodeInfo, TunnelRoute, TunnelStatus } from '../shared/types'
import type { LocalProxy } from './proxy-bridge'
import { ProxyAgent, request } from 'undici'
import type { SecretCodec } from './secret-codec'
import {
  AUTO_TUNNEL_GROUP, DELAY_TEST_URL, NODE_SLOT_COUNT, PROBE_SLOT_COUNT, TUNNEL_GROUP, mihomoConfig, nodeSlotGroup, probeGroup, providerName,
  validateTunnelSource, type TunnelSource
} from './tunnel-config'

/** Answers {"ip": "…"} with the address the request came from. */
export const EXIT_IP_URL = 'https://api.ipify.org?format=json'

interface Logger {
  info(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

interface StoredTunnel {
  schemaVersion: 1
  enabled: boolean
  selected?: string
  sources: TunnelSource[]
  /** Each node's exit IP, as last looked up (kept across restarts; shown next to the node). */
  exitIps?: Record<string, { ip: string; checkedAt: string }>
}

const EMPTY: StoredTunnel = { schemaVersion: 1, enabled: false, sources: [] }

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as { port: number }).port
  await new Promise((resolve) => server.close(resolve))
  return port
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs the tunnel core (mihomo) with the user's nodes and answers which local port carries traffic. */
export class TunnelManager {
  private stored: StoredTunnel = { ...EMPTY, sources: [] }
  private child: ChildProcess | null = null
  private state: TunnelStatus['state'] = 'off'
  private error?: string
  private mixedPort = 0
  private autoPort = 0
  private slotPorts: number[] = []
  private probePorts: number[] = []
  private probing?: Promise<void>
  /** The node each slot (nodeSlotGroup) carries; kept across restarts and set again on start. */
  private slots: string[] = []
  private slotting: Promise<unknown> = Promise.resolve()
  private controller = ''
  private secret = ''
  private delays = new Map<string, number>()
  private stopping = false
  private restarts = 0

  constructor(
    private readonly vaultPath: string,
    private readonly codec: SecretCodec,
    private readonly binary: string,
    private readonly logger?: Logger,
    private readonly onChanged: (status: TunnelStatus) => void = () => undefined,
    private readonly delayTestUrl = DELAY_TEST_URL,
    private readonly exitIpUrl = EXIT_IP_URL
  ) {}

  private get file(): string {
    return join(this.vaultPath, 'tunnel.json')
  }

  private get runtimeDir(): string {
    return join(this.vaultPath, 'tunnel-runtime')
  }

  async initialize(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as StoredTunnel
      if (value.schemaVersion === 1 && Array.isArray(value.sources)) this.stored = value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger?.error('读取加速通道设置失败', error)
    }
    if (this.stored.enabled) await this.start().catch(() => undefined)
  }

  async available(): Promise<boolean> {
    return access(this.binary).then(() => true, () => false)
  }

  /** The local port that carries a connection out through the tunnel, while it runs. */
  localProxy(): LocalProxy | undefined {
    return this.state === 'running' ? { type: 'http', host: '127.0.0.1', port: this.mixedPort } : undefined
  }

  /**
   * The local port for a window set to 网络加速: the fastest node, or the node it is fixed to.
   * Throws when the tunnel is not running — such a window must not connect from this computer's IP.
   */
  async routeProxy(route: Pick<TunnelRoute, 'mode' | 'node'>): Promise<LocalProxy> {
    for (let waited = 0; this.state === 'starting' && waited < 30_000; waited += 250) await delay(250)
    if (this.state !== 'running') {
      throw new Error(this.state === 'error' && this.error ? `获取不到代理 IP（网络加速出错：${this.error}）` : '获取不到代理 IP（网络加速未开启）')
    }
    if (route.mode !== 'manual' || !route.node) return { type: 'http', host: '127.0.0.1', port: this.autoPort }
    return { type: 'http', host: '127.0.0.1', port: this.slotPorts[await this.slotFor(route.node)] }
  }

  /** The slot that carries `node`, pointing a free one at it the first time it is asked for. */
  private slotFor(node: string): Promise<number> {
    const next = this.slotting.then(async () => {
      const known = this.slots.indexOf(node)
      if (known >= 0) return known
      if (!(await this.groupNames()).includes(node)) throw new Error(`获取不到代理 IP（加速节点「${node}」已不存在，请在代理设置里重新选择）`)
      const index = this.slots.includes('') ? this.slots.indexOf('') : this.slots.length
      if (index >= NODE_SLOT_COUNT) throw new Error(`同时固定使用的加速节点不能超过 ${NODE_SLOT_COUNT} 个`)
      await this.api('PUT', `/proxies/${encodeURIComponent(nodeSlotGroup(index))}`, { name: node })
      this.slots[index] = node
      return index
    })
    this.slotting = next.catch(() => undefined)
    return next
  }

  async status(): Promise<TunnelStatus> {
    const proxies = this.state === 'running' ? await this.proxyState().catch(() => ({} as ProxyState)) : {}
    const choice = proxies[TUNNEL_GROUP]?.now
    return {
      available: await this.available(),
      enabled: this.stored.enabled,
      state: this.state,
      error: this.error,
      sources: this.stored.sources.map(({ id, name, kind, updatedAt }) => ({ id, name, kind, updatedAt })),
      nodes: this.state === 'running' ? await this.nodes(proxies).catch(() => []) : [],
      selected: this.stored.selected ?? (choice === AUTO_TUNNEL_GROUP ? proxies[AUTO_TUNNEL_GROUP]?.now : choice),
      selectionMode: this.stored.selected ? 'manual' : 'auto'
    }
  }

  async setEnabled(enabled: boolean): Promise<TunnelStatus> {
    if (enabled && !await this.available()) throw new Error('当前版本没有附带加速通道组件，请安装最新版指纹浏览器')
    if (enabled && !this.stored.sources.length) throw new Error('请先添加节点')
    await this.save({ ...this.stored, enabled })
    if (enabled) await this.restart()
    else await this.stop()
    return this.notify()
  }

  async addSource(input: { name?: unknown; kind?: unknown; content?: unknown }): Promise<TunnelStatus> {
    const source = validateTunnelSource(input)
    const record: TunnelSource = { id: randomUUID().slice(0, 8), ...source, content: this.codec.encode(source.content), updatedAt: new Date().toISOString() }
    await this.replaceSources({ ...this.stored, sources: [...this.stored.sources, record] })
    return this.notify()
  }

  /** Secrets are only sent to the editor on an explicit edit request, never in status events. */
  source(id: string): TunnelSource {
    const source = this.stored.sources.find((item) => item.id === id)
    if (!source) throw new Error('节点来源不存在')
    return { ...source, content: this.codec.decode(source.content) }
  }

  async updateSource(id: string, input: { name?: unknown; kind?: unknown; content?: unknown }): Promise<TunnelStatus> {
    const previous = this.source(id)
    const value = validateTunnelSource(input)
    const record: TunnelSource = { id, ...value, content: this.codec.encode(value.content), updatedAt: new Date().toISOString() }
    const prefix = `${previous.name} · `
    const selected = this.stored.selected?.startsWith(prefix)
      ? `${record.name} · ${this.stored.selected.slice(prefix.length)}` : this.stored.selected
    await this.replaceSources({ ...this.stored, selected, sources: this.stored.sources.map((item) => item.id === id ? record : item) })
    return this.notify()
  }

  /** A bad edit must not replace a working saved configuration. */
  private async replaceSources(next: StoredTunnel): Promise<void> {
    const previous = this.stored
    await this.save(next)
    if (!next.enabled) return
    try { await this.restart() }
    catch (error) {
      await this.save(previous)
      await this.restart().catch(() => undefined)
      throw error
    }
  }

  async removeSource(id: string): Promise<TunnelStatus> {
    const source = this.source(id)
    const sources = this.stored.sources.filter((source) => source.id !== id)
    const selected = this.stored.selected?.startsWith(`${source.name} · `) ? undefined : this.stored.selected
    await this.save({ ...this.stored, selected, sources, enabled: this.stored.enabled && sources.length > 0 })
    if (this.stored.enabled) await this.restart()
    else await this.stop()
    return this.notify()
  }

  async select(name: string): Promise<TunnelStatus> {
    if (typeof name !== 'string' || !name) throw new Error('请选择节点')
    if (this.state !== 'running') throw new Error('加速通道未运行')
    if (!(await this.groupNames()).includes(name)) throw new Error('节点不存在，请刷新列表')
    await this.api('PUT', `/proxies/${encodeURIComponent(TUNNEL_GROUP)}`, { name })
    await this.save({ ...this.stored, selected: name })
    return this.notify()
  }

  async autoSelect(): Promise<TunnelStatus> {
    if (this.state === 'running') await this.api('PUT', `/proxies/${encodeURIComponent(TUNNEL_GROUP)}`, { name: AUTO_TUNNEL_GROUP })
    await this.save({ ...this.stored, selected: undefined })
    if (this.stored.enabled && this.state !== 'running') await this.restart()
    if (this.state === 'running') return this.testDelays()
    return this.notify()
  }

  /** Measures every node through itself to Google; the result is shown next to each node. */
  async testDelays(): Promise<TunnelStatus> {
    if (this.state !== 'running') throw new Error('加速通道未运行')
    const result = await this.api('GET', `/group/${encodeURIComponent(AUTO_TUNNEL_GROUP)}/delay?url=${encodeURIComponent(this.delayTestUrl)}&timeout=5000`) as Record<string, number>
    for (const node of await this.nodes()) this.delays.set(node.name, result[node.name] ?? 0)
    void this.lookUpExitIps().catch((error) => this.logger?.error('查询节点出口 IP 失败', error))
    return this.notify()
  }

  /**
   * Looks up the IP each node goes out from (what proxy whitelists need), a few nodes at a time
   * through the probe ports. Runs after start and after 测速; one run at a time.
   */
  lookUpExitIps(): Promise<void> {
    this.probing ??= this.probeAll().finally(() => { this.probing = undefined })
    return this.probing
  }

  private async probeAll(): Promise<void> {
    if (this.state !== 'running') return
    const nodes = await this.groupNames().catch(() => [] as string[])
    const found: Record<string, { ip: string; checkedAt: string }> = {}
    let next = 0
    await Promise.all(this.probePorts.map(async (port, index) => {
      while (next < nodes.length && this.state === 'running') {
        const node = nodes[next++]
        try {
          await this.api('PUT', `/proxies/${encodeURIComponent(probeGroup(index))}`, { name: node })
          const agent = new ProxyAgent(`http://127.0.0.1:${port}`)
          try {
            const response = await request(this.exitIpUrl, { dispatcher: agent, headersTimeout: 8000, bodyTimeout: 8000, signal: AbortSignal.timeout(10_000) })
            const data = await response.body.json() as { ip?: unknown }
            if (response.statusCode === 200 && typeof data.ip === 'string' && isIP(data.ip)) found[node] = { ip: data.ip, checkedAt: new Date().toISOString() }
          } finally {
            await agent.destroy().catch(() => undefined)
          }
        } catch {
          // A node that does not answer keeps the IP it had.
        }
      }
    }))
    if (!Object.keys(found).length || this.state !== 'running') return
    const kept = Object.fromEntries(Object.entries(this.stored.exitIps ?? {}).filter(([name]) => nodes.includes(name)))
    await this.save({ ...this.stored, exitIps: { ...kept, ...found } })
    void this.notify()
  }

  /** Downloads every subscription again. */
  async refreshSubscriptions(): Promise<TunnelStatus> {
    if (this.state !== 'running') throw new Error('加速通道未运行')
    for (const source of this.stored.sources.filter((item) => item.kind === 'subscription')) {
      await this.api('PUT', `/providers/proxies/${encodeURIComponent(providerName(source))}`)
    }
    return this.notify()
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.stopping = true
    if (child && child.exitCode === null) {
      child.kill()
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    this.stopping = false
    this.state = 'off'
    this.error = undefined
  }

  private async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  private async start(): Promise<void> {
    if (!this.stored.sources.length || !await this.available()) return
    this.state = 'starting'
    this.error = undefined
    void this.notify()
    try {
      await rm(this.runtimeDir, { recursive: true, force: true })
      await mkdir(join(this.runtimeDir, 'providers'), { recursive: true })
      const sources = this.stored.sources.map((source) => ({ ...source, content: this.codec.decode(source.content) }))
      for (const source of sources) {
        if (source.kind === 'links') await writeFile(join(this.runtimeDir, 'providers', `${source.id}.txt`), source.content, { mode: 0o600 })
      }
      this.mixedPort = await freePort()
      this.autoPort = await freePort()
      this.slotPorts = []
      for (let index = 0; index < NODE_SLOT_COUNT; index++) this.slotPorts.push(await freePort())
      this.probePorts = []
      for (let index = 0; index < PROBE_SLOT_COUNT; index++) this.probePorts.push(await freePort())
      const controllerPort = await freePort()
      this.secret = randomBytes(16).toString('hex')
      this.controller = `http://127.0.0.1:${controllerPort}`
      const config = mihomoConfig({ mixedPort: this.mixedPort, autoPort: this.autoPort, slotPorts: this.slotPorts, probePorts: this.probePorts, controllerPort, secret: this.secret, sources, delayTestUrl: this.delayTestUrl })
      await writeFile(join(this.runtimeDir, 'config.yaml'), JSON.stringify(config, null, 2), { mode: 0o600 })

      let output = ''
      const child = spawn(this.binary, ['-d', this.runtimeDir, '-f', join(this.runtimeDir, 'config.yaml')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      const collect = (chunk: Buffer) => { output = `${output}${chunk}`.slice(-4000) }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.once('exit', (code) => {
        if (this.child !== child || this.stopping) return
        this.child = null
        this.state = 'error'
        this.error = `加速通道意外退出（code=${code ?? '-'}）`
        this.logger?.error('加速通道意外退出', { code, output: output.slice(-1500) })
        void this.notify()
        if (this.restarts++ < 3) void delay(2000).then(() => this.stored.enabled && !this.child ? this.start() : undefined).catch(() => undefined)
      })

      for (let attempt = 0; ; attempt++) {
        if (child.exitCode !== null) throw new Error(`加速通道启动失败：${lastLine(output) || `code=${child.exitCode}`}`)
        // The controller can answer before the groups are loaded; wait for the group itself.
        if (await this.api('GET', `/proxies/${encodeURIComponent(TUNNEL_GROUP)}`).then(() => true, () => false)) break
        if (attempt > 100) throw new Error('加速通道启动超时')
        await delay(100)
      }
      const names = (await this.groupNames())
      if (!names.length) throw new Error('没有可用节点：请检查节点链接或订阅是否正确')
      if (this.stored.selected && !names.includes(this.stored.selected)) throw new Error('固定节点已不存在，请切换自动选择或编辑节点来源')
      const selected = this.stored.selected ?? AUTO_TUNNEL_GROUP
      await this.api('PUT', `/proxies/${encodeURIComponent(TUNNEL_GROUP)}`, { name: selected })
      // Windows fixed to a node keep their slot; a node gone after an edit leaves its slot empty (REJECT).
      this.slots = this.slots.map((node) => names.includes(node) ? node : '')
      for (const [index, node] of this.slots.entries()) {
        if (node) await this.api('PUT', `/proxies/${encodeURIComponent(nodeSlotGroup(index))}`, { name: node })
      }
      this.delays.clear()
      this.state = 'running'
      this.restarts = 0
      this.logger?.info('加速通道已启动', { nodes: names.length, selected })
      void this.lookUpExitIps().catch((error) => this.logger?.error('查询节点出口 IP 失败', error))
    } catch (error) {
      this.logger?.error('加速通道启动失败', error)
      await this.stop()
      this.state = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      void this.notify()
    }
  }

  private async groupNames(): Promise<string[]> {
    const group = await this.api('GET', `/proxies/${encodeURIComponent(TUNNEL_GROUP)}`) as { all?: string[] }
    return (group.all ?? []).filter((name) => name !== 'COMPATIBLE' && name !== AUTO_TUNNEL_GROUP)
  }

  private async proxyState(): Promise<ProxyState> {
    return (await this.api('GET', '/proxies') as { proxies?: ProxyState }).proxies ?? {}
  }

  private async nodes(snapshot?: ProxyState): Promise<TunnelNodeInfo[]> {
    const proxies = snapshot ?? await this.proxyState()
    const providers = (await this.api('GET', '/providers/proxies') as { providers?: Record<string, { proxies?: Array<{ name: string; type?: string; history?: Array<{ delay: number }> }> }> }).providers ?? {}
    const owners = new Map<string, string>()
    const descriptions: ProxyState = { ...proxies }
    for (const source of this.stored.sources) {
      for (const proxy of providers[providerName(source)]?.proxies ?? []) {
        owners.set(proxy.name, source.id)
        descriptions[proxy.name] = proxy
      }
    }
    return (proxies[TUNNEL_GROUP]?.all ?? []).filter((name) => name !== 'COMPATIBLE' && name !== AUTO_TUNNEL_GROUP).map((name) => ({
      name, type: descriptions[name]?.type ?? '', sourceId: owners.get(name),
      delay: descriptions[name]?.history?.at(-1)?.delay ?? this.delays.get(name),
      exitIp: this.stored.exitIps?.[name]?.ip
    }))
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.controller}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.secret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(path.includes('/delay') ? 15_000 : 5000)
    })
    if (!response.ok && response.status !== 204) throw new Error(`加速通道接口返回 HTTP ${response.status}`)
    const text = await response.text()
    return text ? JSON.parse(text) : {}
  }

  private async save(next: StoredTunnel): Promise<void> {
    await mkdir(this.vaultPath, { recursive: true })
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
    await rename(temporary, this.file)
    this.stored = next
  }

  private async notify(): Promise<TunnelStatus> {
    const status = await this.status()
    this.onChanged(status)
    return status
  }

}

type ProxyState = Record<string, { type?: string; now?: string; all?: string[]; history?: Array<{ delay: number }> }>

function lastLine(output: string): string {
  return output.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) ?? ''
}
