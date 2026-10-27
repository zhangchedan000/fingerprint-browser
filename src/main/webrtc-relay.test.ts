import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openWebRtcRelay, proxySupportsUdp } from './webrtc-relay'
import type { ProxyConfig } from '../shared/types'

/** A SOCKS5 proxy with username/password that relays UDP (or refuses it), echoing STUN. */
async function fakeProxy(options: { udp: boolean }): Promise<{ proxy: ProxyConfig; close: () => void; seen: string[] }> {
  const seen: string[] = []
  const relays: UdpSocket[] = []
  const server: Server = createServer((client) => {
    let stage = 0
    client.on('data', async (data: Buffer) => {
      if (stage === 0) { stage = 1; client.write(Buffer.from([5, 2])); return }
      if (stage === 1) {
        const user = data.subarray(2, 2 + data[1]).toString()
        const pass = data.subarray(3 + data[1], 3 + data[1] + data[2 + data[1]]).toString()
        stage = 2
        client.write(Buffer.from([1, user === 'u' && pass === 'p' ? 0 : 1]))
        return
      }
      if (!options.udp) { client.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return }
      const relay = createSocket('udp4')
      relays.push(relay)
      await new Promise<void>((resolve) => relay.bind(0, '127.0.0.1', resolve))
      relay.on('message', (frame, from) => {
        const type = frame[3]
        const headerSize = type === 1 ? 10 : type === 3 ? 7 + frame[4] : 22
        seen.push(type === 3 ? frame.subarray(5, 5 + frame[4]).toString() : [...frame.subarray(4, 8)].join('.'))
        const payload = frame.subarray(headerSize)
        // Reply as the peer would: STUN gets a binding success with the same transaction id.
        const answer = payload.length >= 20 && payload.readUInt16BE(0) === 1
          ? Buffer.concat([Buffer.from([1, 1, 0, 0]), payload.subarray(4, 20)])
          : payload
        relay.send(Buffer.concat([Buffer.from([0, 0, 0, 1, 93, 184, 216, 34, 0x4a, 0x66]), answer]), from.port, from.address)
      })
      const reply = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
      reply.writeUInt16BE((relay.address() as { port: number }).port, 8)
      client.write(reply)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    proxy: { protocol: 'socks5', host: '127.0.0.1', port, username: 'u', password: 'p' },
    seen,
    close: () => { server.close(); for (const relay of relays) relay.close() }
  }
}

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

describe('WebRTC relay', () => {
  it('detects a proxy that relays UDP and one that refuses it', async () => {
    const good = await fakeProxy({ udp: true })
    const bad = await fakeProxy({ udp: false })
    cleanups.push(good.close, bad.close)
    expect(await proxySupportsUdp(good.proxy)).toBe(true)
    expect(good.seen).toContain('stun.l.google.com')
    expect(await proxySupportsUdp(bad.proxy)).toBe(false)
    expect(await proxySupportsUdp({ ...good.proxy, protocol: 'http' })).toBe(false)
  })

  it('passes the kernel frames through the proxy and the replies back', async () => {
    const fake = await fakeProxy({ udp: true })
    cleanups.push(fake.close)
    const relay = await openWebRtcRelay(fake.proxy)
    expect(relay).toBeDefined()
    cleanups.push(() => relay!.close())
    const kernel = createSocket('udp4')
    cleanups.push(() => kernel.close())
    await new Promise<void>((resolve) => kernel.bind(0, '127.0.0.1', resolve))
    const reply = new Promise<Buffer>((resolve) => kernel.once('message', resolve))
    // A frame for 8.8.8.8:3478 as the kernel sends it.
    kernel.send(Buffer.concat([Buffer.from([0, 0, 0, 1, 8, 8, 8, 8, 0x0d, 0x96]), Buffer.from('ping')]), relay!.port, '127.0.0.1')
    const answer = await reply
    expect([...answer.subarray(0, 4)]).toEqual([0, 0, 0, 1])
    expect(answer.subarray(10).toString()).toBe('ping')
    expect(fake.seen).toContain('8.8.8.8')
  })
})
