import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { connect, isIP, type Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { randomBytes } from 'node:crypto'
import type { ProxyConfig } from '../shared/types'

/**
 * WebRTC UDP through the window's SOCKS5 proxy (kernel patch 016, prism6+).
 *
 * The kernel sends every WebRTC packet for a public address to 127.0.0.1:<port> framed as a SOCKS5
 * UDP request (RFC 1928, section 7). Each kernel socket gets its own UDP association with the proxy
 * (username/password per RFC 1929), and the frames go to the proxy's relay unchanged, as do the
 * replies on their way back. So STUN sees the proxy's address and calls flow through the proxy.
 *
 * A proxy that refuses UDP ASSOCIATE, or accepts it but relays nothing, gets no relay: the window
 * then falls back to reporting the proxy's address without sending UDP (patch 013).
 */

const TIMEOUT_MS = 5000
const IDLE_MS = 3 * 60_000
const STUN_HOST = 'stun.l.google.com'
const STUN_PORT = 19302

interface Association {
  control: Socket
  udp: UdpSocket
  relay: { host: string; port: number }
}

/** Reads exactly `size` bytes, failing on close or timeout. */
function reader(socket: Socket): (size: number) => Promise<Buffer> {
  let buffered = Buffer.alloc(0)
  let waiting: { size: number; resolve: (data: Buffer) => void; reject: (error: Error) => void } | undefined
  const settle = () => {
    if (waiting && buffered.length >= waiting.size) {
      const { size, resolve } = waiting
      waiting = undefined
      const data = buffered.subarray(0, size)
      buffered = buffered.subarray(size)
      resolve(data)
    }
  }
  socket.on('data', (chunk: Buffer) => { buffered = Buffer.concat([buffered, chunk]); settle() })
  const fail = (error: Error) => { waiting?.reject(error); waiting = undefined }
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('proxy closed the connection')))
  return (size) => new Promise((resolve, reject) => {
    waiting = { size, resolve, reject }
    settle()
  })
}

async function readAddress(read: (size: number) => Promise<Buffer>): Promise<{ host: string; port: number }> {
  const [type] = await read(1)
  let host: string
  if (type === 1) host = [...await read(4)].join('.')
  else if (type === 4) host = (await read(16)).toString('hex').match(/.{4}/g)!.join(':')
  else if (type === 3) host = (await read((await read(1))[0])).toString('utf8')
  else throw new Error(`unknown address type ${type}`)
  const port = (await read(2)).readUInt16BE(0)
  return { host, port }
}

/** Opens one UDP association with the proxy. */
export async function associate(proxy: ProxyConfig): Promise<Association> {
  const control = connect({ host: proxy.host, port: proxy.port ?? 1080 })
  control.setTimeout(TIMEOUT_MS, () => control.destroy(new Error('proxy timed out')))
  const read = reader(control)
  try {
    await new Promise<void>((resolve, reject) => { control.once('connect', resolve); control.once('error', reject) })
    const withLogin = Boolean(proxy.username || proxy.password)
    control.write(Buffer.from(withLogin ? [5, 2, 0, 2] : [5, 1, 0]))
    const [, method] = await read(2)
    if (method === 2) {
      const user = Buffer.from(proxy.username, 'utf8')
      const pass = Buffer.from(proxy.password, 'utf8')
      control.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
      if ((await read(2))[1] !== 0) throw new Error('proxy login failed')
    } else if (method !== 0) {
      throw new Error('proxy accepts no usable login method')
    }
    control.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]))
    const [, reply] = await read(3)
    if (reply !== 0) throw new Error(`proxy refused UDP (reply ${reply})`)
    const relay = await readAddress(read)
    // "0.0.0.0" means: the proxy's own address.
    if (relay.host === '0.0.0.0' || /^0{4}(:0{4}){7}$/.test(relay.host)) {
      relay.host = isIP(proxy.host) ? proxy.host : (await lookup(proxy.host)).address
    }
    control.setTimeout(0)
    const udp = createSocket(isIP(relay.host) === 6 ? 'udp6' : 'udp4')
    await new Promise<void>((resolve) => udp.bind(0, resolve))
    control.on('close', () => { try { udp.close() } catch { /* already closed */ } })
    return { control, udp, relay }
  } catch (error) {
    control.destroy()
    throw error
  }
}

function closeAssociation(association: Association): void {
  association.control.destroy()
  try { association.udp.close() } catch { /* already closed */ }
}

/** A STUN binding request through the association; the proxy resolves the server's name. */
export async function relaysUdp(association: Association): Promise<boolean> {
  const id = randomBytes(12)
  const name = Buffer.from(STUN_HOST)
  const port = Buffer.alloc(2)
  port.writeUInt16BE(STUN_PORT)
  const request = Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), id])
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 3, name.length]), name, port, request])
  return new Promise((resolve) => {
    const done = (ok: boolean) => { clearTimeout(timer); association.udp.off('message', onMessage); resolve(ok) }
    const onMessage = (message: Buffer) => {
      // SOCKS5 UDP header, then a STUN binding success response with our transaction id.
      const headerSize = message[3] === 1 ? 10 : message[3] === 4 ? 22 : -1
      if (headerSize < 0) return
      const stun = message.subarray(headerSize)
      if (stun.length >= 20 && stun.readUInt16BE(0) === 0x0101 && stun.subarray(8, 20).equals(id)) done(true)
    }
    const timer = setTimeout(() => done(false), TIMEOUT_MS)
    association.udp.on('message', onMessage)
    for (const delay of [0, 1000, 2000]) {
      setTimeout(() => association.udp.send(frame, association.relay.port, association.relay.host), delay)
    }
  })
}

/** Whether the proxy relays UDP, remembered for a while so launching again does not re-test. */
const supportCache = new Map<string, { ok: boolean; at: number }>()
const CACHE_MS = 10 * 60_000

export async function proxySupportsUdp(proxy: ProxyConfig): Promise<boolean> {
  if (proxy.protocol !== 'socks5' || !proxy.port) return false
  const key = `${proxy.host.toLowerCase()}:${proxy.port}:${proxy.username}`
  const cached = supportCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.ok
  let ok = false
  try {
    const association = await associate(proxy)
    try { ok = await relaysUdp(association) } finally { closeAssociation(association) }
  } catch {
    ok = false
  }
  supportCache.set(key, { ok, at: Date.now() })
  return ok
}

export interface WebRtcRelay {
  port: number
  close(): void
}

/**
 * The window's relay on 127.0.0.1, or undefined when the proxy does not relay UDP. Only frames
 * from this computer are accepted.
 */
export async function openWebRtcRelay(proxy: ProxyConfig): Promise<WebRtcRelay | undefined> {
  if (!await proxySupportsUdp(proxy)) return undefined
  const front = createSocket('udp4')
  await new Promise<void>((resolve, reject) => {
    front.once('error', reject)
    front.bind(0, '127.0.0.1', () => { front.off('error', reject); resolve() })
  })
  const peers = new Map<number, { association: Promise<Association | undefined>; used: number }>()
  front.on('message', (frame, from) => {
    if (from.address !== '127.0.0.1') return
    let peer = peers.get(from.port)
    if (!peer) {
      const association = associate(proxy).then((opened) => {
        opened.udp.on('message', (reply) => front.send(reply, from.port, '127.0.0.1'))
        opened.control.on('close', () => peers.delete(from.port))
        return opened
      }, () => {
        peers.delete(from.port)
        return undefined
      })
      peer = { association, used: Date.now() }
      peers.set(from.port, peer)
    }
    peer.used = Date.now()
    void peer.association.then((opened) => opened?.udp.send(frame, opened.relay.port, opened.relay.host))
  })
  front.on('error', () => undefined)
  const sweep = setInterval(() => {
    for (const [port, peer] of peers) {
      if (Date.now() - peer.used < IDLE_MS) continue
      peers.delete(port)
      void peer.association.then((opened) => opened && closeAssociation(opened))
    }
  }, 60_000)
  sweep.unref()
  return {
    port: (front.address() as { port: number }).port,
    close: () => {
      clearInterval(sweep)
      for (const peer of peers.values()) void peer.association.then((opened) => opened && closeAssociation(opened))
      peers.clear()
      try { front.close() } catch { /* already closed */ }
    }
  }
}
