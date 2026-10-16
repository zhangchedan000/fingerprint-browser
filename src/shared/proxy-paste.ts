import type { ProxyProtocol } from './types'

export interface PastedProxy {
  /** Present only when the text names a scheme; otherwise the caller keeps its current protocol. */
  protocol?: Exclude<ProxyProtocol, 'direct'>
  host: string
  port: number
  username: string
  password: string
}

const SCHEMES: Record<string, Exclude<ProxyProtocol, 'direct'>> = {
  http: 'http',
  https: 'https',
  socks5: 'socks5',
  socks5h: 'socks5',
  socks: 'socks5'
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) throw new Error('代理端口必须在 1–65535 之间')
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error('代理端口必须在 1–65535 之间')
  return port
}

function splitHostPort(value: string): { host: string; port: number } {
  const bracketed = value.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketed) return { host: bracketed[1], port: parsePort(bracketed[2]) }
  const index = value.lastIndexOf(':')
  if (index <= 0) throw new Error('无法识别代理格式，请使用 host:port:user:pass 或 socks5://user:pass@host:port')
  return { host: value.slice(0, index), port: parsePort(value.slice(index + 1)) }
}

/**
 * Parses the proxy formats sellers usually paste:
 *   socks5://user:pass@host:port · http://host:port · user:pass@host:port
 *   host:port · host:port:user:pass
 */
export function parsePastedProxy(input: string): PastedProxy {
  let text = input.trim()
  if (!text) throw new Error('请粘贴代理信息')
  if (/\s/.test(text)) throw new Error('一次只能粘贴一条代理')
  let protocol: PastedProxy['protocol']
  const scheme = text.match(/^([a-z0-9]+):\/\//i)
  if (scheme) {
    protocol = SCHEMES[scheme[1].toLowerCase()]
    if (!protocol) throw new Error('不支持的代理协议')
    text = text.slice(scheme[0].length).replace(/\/+$/, '')
  }

  let username = ''
  let password = ''
  let hostPort = text
  const at = text.lastIndexOf('@')
  if (at >= 0) {
    const credentials = text.slice(0, at)
    hostPort = text.slice(at + 1)
    const colon = credentials.indexOf(':')
    username = decodeURIComponent(colon >= 0 ? credentials.slice(0, colon) : credentials)
    password = decodeURIComponent(colon >= 0 ? credentials.slice(colon + 1) : '')
  } else if (!text.startsWith('[')) {
    const parts = text.split(':')
    if (parts.length === 4) {
      return { protocol, host: parts[0], port: parsePort(parts[1]), username: parts[2], password: parts[3] }
    }
    if (parts.length > 4) {
      // host:port:user:pass where the password itself contains colons
      return { protocol, host: parts[0], port: parsePort(parts[1]), username: parts[2], password: parts.slice(3).join(':') }
    }
  }
  const { host, port } = splitHostPort(hostPort)
  if (!host) throw new Error('代理地址不能为空')
  return { protocol, host, port, username, password }
}
