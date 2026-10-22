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
  socks: 'socks5',
  sock5: 'socks5',
  s5: 'socks5'
}

/** Placeholder of every quick paste box: the common seller formats. */
export const PASTE_PLACEHOLDER = 'host:port:user:pass / socks5://user:pass@host:port / 地址：… 端口：… 用户名：… 密码：…'

const FORMAT_HELP = '无法识别代理格式，请使用 host:port:user:pass 或 socks5://user:pass@host:port'

/** Labels sellers put in front of each value ("客户端地址：", "Port:", "密码="), longest first. */
const LABELS: Array<[RegExp, keyof Omit<PastedProxy, 'protocol'> | 'protocol']> = [
  [/^(?:ip\s*地址|hostname|host|server|address|addr|ip|主机名|主机|服务器|地址|域名)$/i, 'host'],
  [/^(?:port|端口号?)$/i, 'port'],
  [/^(?:username|user|login|account|用户名|用户|账号|帐号|账户|帐户)$/i, 'username'],
  [/^(?:password|passwd|pass|pwd|密码)$/i, 'password'],
  [/^(?:protocol|scheme|type|协议|类型)$/i, 'protocol']
]
// Not inside a URL or a colon list (socks5://user:pass@…, 1.2.3.4:80:user:pass); Chinese prefixes are fine.
const LABEL_PATTERN = /(?<![A-Za-z0-9_./@:-])(ip\s*地址|hostname|host|server|address|addr|ip|主机名|主机|服务器|地址|域名|port|端口号?|username|user|login|account|用户名|用户|账号|帐号|账户|帐户|password|passwd|pass|pwd|密码|protocol|scheme|type|协议|类型)\s*[:=]\s*/gi

/** Full-width punctuation, invisible characters and wrapping quotes that chat apps add. */
function normalize(input: string): string {
  return input
    .replace(/[​-‍﻿]/g, '')
    .replace(/：/g, ':').replace(/＝/g, '=').replace(/，/g, ',').replace(/｜/g, '|').replace(/／/g, '/').replace(/＠/g, '@')
    .replace(/　/g, ' ')
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .trim()
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) throw new Error('代理端口必须在 1–65535 之间')
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error('代理端口必须在 1–65535 之间')
  return port
}

function parseScheme(value: string): Exclude<ProxyProtocol, 'direct'> {
  const protocol = SCHEMES[value.toLowerCase()]
  if (!protocol) throw new Error('不支持的代理协议')
  return protocol
}

/** An IPv4 address, a bracketed or bare IPv6 address, localhost or a dotted domain name. */
function looksLikeHost(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
    || /^\[?[0-9a-f]*:[0-9a-f:]+\]?$/i.test(value)
    || /^localhost$/i.test(value)
    || /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(value)
}

function isPort(value: string | undefined): boolean {
  return value !== undefined && /^\d{1,5}$/.test(value)
}

function splitHostPort(value: string): { host: string; port: number } {
  const bracketed = value.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketed) return { host: bracketed[1], port: parsePort(bracketed[2]) }
  const index = value.lastIndexOf(':')
  if (index <= 0) throw new Error(FORMAT_HELP)
  return { host: value.slice(0, index), port: parsePort(value.slice(index + 1)) }
}

function splitCredentials(value: string): { username: string; password: string } {
  const colon = value.indexOf(':')
  return {
    username: decodeURIComponent(colon >= 0 ? value.slice(0, colon) : value),
    password: decodeURIComponent(colon >= 0 ? value.slice(colon + 1) : '')
  }
}

/** "客户端地址：1.2.3.4 客户端端口：1080 用户名：u 密码：p", on one line or many. */
function parseLabeled(text: string): PastedProxy | undefined {
  const matches = [...text.matchAll(LABEL_PATTERN)]
  if (!matches.length) return undefined
  const fields: Partial<Record<string, string>> = {}
  matches.forEach((match, index) => {
    const field = LABELS.find(([pattern]) => pattern.test(match[1]))?.[1]
    const start = match.index! + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index! : text.length
    // The value ends at the first space or line break; a following label's prefix ("客户端") is not part of it.
    const value = text.slice(start, end).trim().split(/[\s,;|]+/)[0] ?? ''
    if (field && value && fields[field] === undefined) fields[field] = value
  })
  if (!fields.host) return undefined
  // A full proxy URL or host:port can sit behind a single "地址：" label.
  if (!fields.port && !fields.username && /[:@]/.test(fields.host)) {
    const inner = parsePastedProxy(fields.host)
    return { ...inner, protocol: inner.protocol ?? (fields.protocol ? parseScheme(fields.protocol.replace(/:\/\/$/, '')) : undefined) }
  }
  let host = fields.host.replace(/^[a-z0-9]+:\/\//i, '')
  let port = fields.port
  if (!port) {
    const split = splitHostPort(host)
    host = split.host
    port = String(split.port)
  }
  return {
    protocol: fields.protocol ? parseScheme(fields.protocol.replace(/:\/\/$/, '')) : undefined,
    host: host.replace(/^\[|\]$/g, ''),
    port: parsePort(port),
    username: fields.username ?? '',
    password: fields.password ?? ''
  }
}

/** host port [user pass] or user pass host port, in whatever order the separators gave. */
function parseFields(parts: string[], protocol: PastedProxy['protocol']): PastedProxy {
  if (parts.length >= 2 && looksLikeHost(parts[0]) && isPort(parts[1])) {
    return { protocol, host: parts[0].replace(/^\[|\]$/g, ''), port: parsePort(parts[1]), username: parts[2] ?? '', password: parts.slice(3).join(':') }
  }
  const last = parts.length - 1
  if (parts.length >= 3 && isPort(parts[last]) && looksLikeHost(parts[last - 1])) {
    return { protocol, host: parts[last - 1], port: parsePort(parts[last]), username: parts[0], password: parts.slice(1, last - 1).join(':') }
  }
  if (parts.length >= 2 && isPort(parts[1])) {
    return { protocol, host: parts[0], port: parsePort(parts[1]), username: parts[2] ?? '', password: parts.slice(3).join(':') }
  }
  const port = parts.find((part, index) => index > 0 && /^\d+$/.test(part))
  if (port && !isPort(port)) parsePort(port)
  throw new Error(FORMAT_HELP)
}

/**
 * Parses the proxy formats sellers usually paste:
 *   socks5://user:pass@host:port · http://host:port · user:pass@host:port · host:port@user:pass
 *   host:port · host:port:user:pass · user:pass:host:port · host|port|user|pass (also , tab or space)
 *   "地址：host 端口：port 用户名：user 密码：pass" with any prefix, on one line or several
 */
export function parsePastedProxy(input: string): PastedProxy {
  let text = normalize(input)
  if (!text) throw new Error('请粘贴代理信息')

  const labeled = parseLabeled(text)
  if (labeled) {
    if (!labeled.host) throw new Error('代理地址不能为空')
    return labeled
  }

  let protocol: PastedProxy['protocol']
  const scheme = text.match(/^([a-z0-9]+):\/\//i)
  if (scheme) {
    protocol = parseScheme(scheme[1])
    text = text.slice(scheme[0].length).replace(/\/+$/, '')
  }

  if (/\s/.test(text) || /[|,]/.test(text)) {
    const parts = text.split(/[\s|,]+/).filter(Boolean)
    // Several complete proxies ("a:1 b:2") belong in the batch import, not in one form.
    if (parts.filter((part) => /:\d+/.test(part) || part.includes('@')).length > 1) throw new Error('一次只能粘贴一条代理')
    if (parts.length === 1) text = parts[0]
    else return parseFields(parts.flatMap((part) => part.includes('@') || part.startsWith('[') ? [part] : part.split(':')), protocol)
  }

  const at = text.lastIndexOf('@')
  if (at >= 0) {
    const left = text.slice(0, at)
    const right = text.slice(at + 1)
    const rightIsHost = /^(?:\[[^\]]+\]|[^:]+):\d+$/.test(right) && looksLikeHost(right.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''))
    const leftIsHost = /^(?:\[[^\]]+\]|[^:]+):\d+$/.test(left) && looksLikeHost(left.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''))
    // host:port@user:pass, which some shops use, is the mirror of the URL form.
    const [credentials, hostPort] = !rightIsHost && leftIsHost ? [right, left] : [left, right]
    const { host, port } = splitHostPort(hostPort)
    if (!host) throw new Error('代理地址不能为空')
    return { protocol, host, port, ...splitCredentials(credentials) }
  }

  if (!text.startsWith('[')) {
    const parts = text.split(':')
    if (parts.length >= 3) return parseFields(parts, protocol)
  }
  const { host, port } = splitHostPort(text)
  if (!host) throw new Error('代理地址不能为空')
  return { protocol, host, port, username: '', password: '' }
}

/**
 * Splits a batch paste into one text per proxy: a line each, except that labeled blocks
 * ("地址：…" on several lines) stay together until the next address label starts a new one.
 */
export function splitPastedProxies(input: string): Array<{ line: number; text: string }> {
  const lines = input.split(/\r?\n/).map((raw, index) => ({ line: index + 1, text: normalize(raw) }))
    .filter(({ text }) => text && !text.startsWith('#'))
  const entries: Array<{ line: number; text: string; labeled: boolean; hasHost: boolean }> = []
  for (const { line, text } of lines) {
    const labels = [...text.matchAll(LABEL_PATTERN)].map((match) => LABELS.find(([pattern]) => pattern.test(match[1]))?.[1])
    const previous = entries[entries.length - 1]
    if (labels.length && previous?.labeled && !(labels.includes('host') && previous.hasHost)) {
      previous.text += `\n${text}`
      previous.hasHost ||= labels.includes('host')
    } else {
      entries.push({ line, text, labeled: labels.length > 0, hasHost: labels.includes('host') })
    }
  }
  return entries.map(({ line, text }) => ({ line, text }))
}

/** "SOCKS5 · 1.2.3.4:1080 · user" for the line under a quick paste box. */
export function pastedProxySummary(proxy: Pick<PastedProxy, 'host' | 'port' | 'username'>, protocol: ProxyProtocol): string {
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
  return [protocol.toUpperCase(), `${host}:${proxy.port}`, proxy.username].filter(Boolean).join(' · ')
}
