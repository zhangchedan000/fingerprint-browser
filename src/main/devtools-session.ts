import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A short-lived DevTools connection to a browser this app started itself (Cookie maintenance,
 * fingerprint checks). One implementation, shared by every caller.
 */
interface DevToolsPage {
  type: string
  webSocketDebuggerUrl?: string
}

export class CdpClient {
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (!message.id) return
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(`CDP: ${message.error.message}`))
      else request.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) request.reject(new Error('浏览器调试会话意外断开'))
      this.pending.clear()
    })
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('连接浏览器调试会话超时'))
      }, 10_000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CdpClient(socket))
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('无法连接浏览器调试会话'))
      }, { once: true })
    })
  }

  send<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`浏览器调试操作超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

export async function waitForPage(userDataPath: string, timeoutMs = 10_000): Promise<{ port: number; websocket: string }> {
  const activePort = join(userDataPath, 'DevToolsActivePort')
  for (let attempt = 0; attempt < timeoutMs / 100; attempt += 1) {
    try {
      const [portText] = (await readFile(activePort, 'utf8')).split(/\r?\n/)
      const port = Number(portText)
      if (!Number.isInteger(port) || port < 1) throw new Error('invalid port')
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        const pages = await response.json() as DevToolsPage[]
        const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
        if (page?.webSocketDebuggerUrl) return { port, websocket: page.webSocketDebuggerUrl }
      }
    } catch {
      // Chromium may still be starting or may not have written the complete port file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('启动浏览器调试会话超时')
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3000))
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

