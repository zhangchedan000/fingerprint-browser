import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { TunnelNodeInfo, TunnelStatus } from '../shared/types'
import type { LocalProxy } from './proxy-bridge'
import type { SecretCodec } from './secret-codec'
import { DELAY_TEST_URL, TUNNEL_GROUP, mihomoConfig, providerName, validateTunnelSource, type TunnelSource } from './tunnel-config'

interface Logger {
  info(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

interface StoredTunnel {
  schemaVersion: 1
  enabled: boolean
  selected?: string
  sources: TunnelSource[]
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
  private stored: StoredTunnel = EMPTY
  private child: ChildProcess | null = null
  private state: TunnelStatus['state'] = 'off'
  private error?: string
  private mixedPort = 0
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
    private readonly onChanged: (status: TunnelStatus) => void = () => undefined
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

  async status(): Promise<TunnelStatus> {
    return {
      available: await this.available(),
      enabled: this.stored.enabled,
      state: this.state,
      error: this.error,
      sources: this.stored.sources.map(({ id, name, kind, updatedAt }) => ({ id, name, kind, updatedAt })),
      nodes: this.state === 'running' ? await this.nodes().catch(() => []) : [],
      selected: this.stored.selected
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
    await this.save({ ...this.stored, sources: [...this.stored.sources, record] })
    if (this.stored.enabled) await this.restart()
    return this.notify()
  }

  async removeSource(id: string): Promise<TunnelStatus> {
    const sources = this.stored.sources.filter((source) => source.id !== id)
    await this.save({ ...this.stored, sources, enabled: this.stored.enabled && sources.length > 0 })
    if (this.stored.enabled) await this.restart()
    else await this.stop()
    return this.notify()
  }

  async select(name: string): Promise<TunnelStatus> {
    if (typeof name !== 'string' || !name) throw new Error('请选择节点')
    if (this.state === 'running') await this.api('PUT', `/proxies/${encodeURIComponent(TUNNEL_GROUP)}`, { name })
    await this.save({ ...this.stored, selected: name })
    return this.notify()
  }

  /** Measures every node through itself to Google; the result is shown next to each node. */
  async testDelays(): Promise<TunnelStatus> {
    if (this.state !== 'running') throw new Error('加速通道未运行')
    const result = await this.api('GET', `/group/${encodeURIComponent(TUNNEL_GROUP)}/delay?url=${encodeURIComponent(DELAY_TEST_URL)}&timeout=5000`)
      .catch(() => ({})) as Record<string, number>
    for (const node of await this.nodes()) this.delays.set(node.name, result[node.name] ?? 0)
    return this.notify()
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
      const controllerPort = await freePort()
      this.secret = randomBytes(16).toString('hex')
      this.controller = `http://127.0.0.1:${controllerPort}`
      const config = mihomoConfig({ mixedPort: this.mixedPort, controllerPort, secret: this.secret, sources })
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
        if (await this.api('GET', '/version').then(() => true, () => false)) break
        if (attempt > 100) throw new Error('加速通道启动超时')
        await delay(100)
      }
      const names = (await this.groupNames())
      if (!names.length) throw new Error('没有可用节点：请检查节点链接或订阅是否正确')
      const selected = this.stored.selected && names.includes(this.stored.selected) ? this.stored.selected : names[0]
      await this.api('PUT', `/proxies/${encodeURIComponent(TUNNEL_GROUP)}`, { name: selected })
      if (selected !== this.stored.selected) await this.save({ ...this.stored, selected })
      this.state = 'running'
      this.restarts = 0
      this.logger?.info('加速通道已启动', { nodes: names.length, selected })
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
    return (group.all ?? []).filter((name) => name !== 'COMPATIBLE')
  }

  private async nodes(): Promise<TunnelNodeInfo[]> {
    const proxies = (await this.api('GET', '/proxies') as { proxies?: Record<string, { type?: string }> }).proxies ?? {}
    return (await this.groupNames()).map((name) => ({ name, type: proxies[name]?.type ?? '', delay: this.delays.get(name) }))
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

function lastLine(output: string): string {
  return output.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) ?? ''
}
