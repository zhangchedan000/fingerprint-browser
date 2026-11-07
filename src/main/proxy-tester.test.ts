import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { classifyProxyFailure, GEO_SOURCES, geoAnswers, mergeGeoLookups, parseGeoLookup, parseSecondaryGeoLookup, rememberIpZone, sameIpZone } from './proxy-tester'

describe('proxy geolocation result', () => {
  it('maps location, network and security fields', () => {
    const result = parseGeoLookup({
      success: true,
      ip: '203.0.113.8',
      country: 'United States',
      country_code: 'US',
      region: 'California',
      city: 'Los Angeles',
      latitude: 34.0522,
      longitude: -118.2437,
      timezone: { id: 'America/Los_Angeles' },
      connection: { asn: 64500, org: 'Example Network', isp: 'Example ISP' },
      security: { proxy: true, hosting: true }
    }, 87)

    expect(result).toMatchObject({
      ok: true,
      ip: '203.0.113.8',
      latencyMs: 87,
      countryCode: 'US',
      timezone: 'America/Los_Angeles',
      asn: 64500,
      networkRisk: 'proxy'
    })
    expect(result).toMatchObject({ latitude: 34.0522, longitude: -118.2437, accuracyMeters: 25000, ipVersion: 4 })
  })

  it('classifies authentication, timeout and connection failures', () => {
    expect(classifyProxyFailure(new Error('Proxy responded with 407 authentication required'))).toBe('authentication')
    expect(classifyProxyFailure(new Error('headers timeout'))).toBe('timeout')
    expect(classifyProxyFailure(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }))).toBe('connection')
    expect(classifyProxyFailure(new Error('upstream returned 590 Non Successful'))).toBe('connection')
    expect(classifyProxyFailure(new Error('TLS certificate verify failed'))).toBe('connection')
  })

  it('rejects failed and incomplete responses', () => {
    expect(() => parseGeoLookup({ success: false, message: 'rate limited' }, 1)).toThrow('rate limited')
    expect(() => parseGeoLookup({ success: true }, 1)).toThrow('结果无效')
    expect(() => parseGeoLookup({ success: true, ip: 'not-an-ip' }, 1)).toThrow('无效的出口地址')
    expect(() => parseGeoLookup({ success: true, ip: '203.0.113.8', timezone: { id: 'Mars/Olympus' } }, 1))
      .toThrow('无效的时区')
  })

  it('prioritizes Tor over other risk flags', () => {
    const result = parseGeoLookup({ ip: '203.0.113.9', security: { tor: true, vpn: true, proxy: true } }, 1)
    expect(result.networkRisk).toBe('tor')
  })

  it('parses the secondary provider and accepts matching country and timezone data', () => {
    const primary = parseGeoLookup({
      ip: '163.5.13.30',
      country_code: 'FR',
      timezone: { id: 'Europe/Paris' },
      latitude: 48.85,
      longitude: 2.35
    }, 10)
    const secondary = parseSecondaryGeoLookup({
      ip: '163.5.13.30',
      country_code: 'FR',
      timezone: 'Europe/Paris',
      latitude: 48.85,
      longitude: 2.35,
      asn: 'AS216138'
    }, 10)

    expect(secondary.asn).toBe(216138)
    expect(mergeGeoLookups({ source: 'ipwho.is', result: primary }, { source: 'ipapi.co', result: secondary })).toMatchObject({
      geoConfidence: 'consensus',
      geoSources: ['ipwho.is', 'ipapi.co']
    })
  })

  it('goes by the first service listed when only two disagree on the country, keeping the other to switch to', () => {
    const primary = parseGeoLookup({
      ip: '104.251.237.13',
      country_code: 'JP',
      timezone: { id: 'Asia/Tokyo' },
      latitude: 35.68,
      longitude: 139.76
    }, 10)
    const secondary = parseSecondaryGeoLookup({
      ip: '104.251.237.13',
      country_code: 'US',
      timezone: 'America/New_York',
      latitude: 39.8,
      longitude: -75.45
    }, 10)

    const merged = mergeGeoLookups({ source: 'ipwho.is', result: primary }, { source: 'ipapi.co', result: secondary })
    expect(merged).toMatchObject({ geoConfidence: 'consensus', countryCode: 'JP', timezone: 'Asia/Tokyo', countryBy: 'ipwho.is' })
    expect(merged.degraded).toBeUndefined()
    expect(merged.countryVotes?.map((vote) => [vote.countryCode, vote.timezone])).toEqual([['JP', 'Asia/Tokyo'], ['US', 'America/New_York']])
  })

  it('says plainly when the proxy hands out a new IP per connection', () => {
    const spain = parseGeoLookup({ ip: '185.45.165.6', country_code: 'ES', city: 'Caravaca de la Cruz', timezone: { id: 'Europe/Madrid' } }, 10)
    const mexico = parseSecondaryGeoLookup({ ip: '187.190.19.106', country_code: 'MX', city: 'Monterrey', timezone: 'America/Monterrey' }, 10)
    const merged = mergeGeoLookups({ source: 'ipwho.is', result: spain }, { source: 'ipapi.co', result: mexico })
    expect(merged.geoConfidence).toBe('conflict')
    expect(merged.geoConflict).toBe('这个代理每个连接换一个出口 IP（轮换代理）：185.45.165.6（ES Caravaca de la Cruz）、187.190.19.106（MX Monterrey）')
    expect(merged.warning).toContain('固定会话')
  })

  it('goes by the country when two services only disagree on the city', () => {
    const a = parseGeoLookup({ ip: '23.165.248.241', country_code: 'US', city: 'Frankfurt', timezone: { id: 'America/New_York' } }, 10)
    const b = parseSecondaryGeoLookup({ ip: '23.165.248.241', country_code: 'US', city: 'Los Angeles', timezone: 'America/Los_Angeles' }, 10)
    expect(mergeGeoLookups({ source: 'ipwho.is', result: a }, { source: 'ipapi.co', result: b })).toMatchObject({
      geoConfidence: 'consensus', countryCode: 'US', city: undefined, timezone: 'America/New_York'
    })
  })

  it('decides the country by most services: one dissenting database no longer leaves the window on the default', () => {
    const answer = (source: string, country_code: string, city: string, timezone: string) =>
      ({ source, result: parseSecondaryGeoLookup({ ip: '203.0.113.9', country_code, city, timezone, latitude: 34.05, longitude: -118.24 }, 10) })
    // 11-07: an airport node in Los Angeles; the second service asked put it in Japan.
    const merged = mergeGeoLookups(answer('ipwho.is', 'US', 'Los Angeles', 'America/Los_Angeles'), answer('ipapi.co', 'JP', 'Tokyo', 'Asia/Tokyo'), [
      answer('ipinfo.io', 'US', 'Los Angeles', 'America/Los_Angeles'), answer('geojs.io', 'US', '', 'America/Los_Angeles'), answer('ip.sb', 'US', 'Los Angeles', 'America/Los_Angeles')
    ])
    expect(merged).toMatchObject({ geoConfidence: 'consensus', countryCode: 'US', timezone: 'America/Los_Angeles', city: 'Los Angeles' })
    expect(merged.degraded).toBeUndefined()
    expect(merged.countryVotes?.map((vote) => [vote.countryCode, vote.sources])).toEqual([['US', ['ipwho.is', 'ipinfo.io', 'geojs.io', 'ip.sb']], ['JP', ['ipapi.co']]])
    // The majority may also be against the first service: its place is not kept.
    const flipped = mergeGeoLookups(answer('ipwho.is', 'JP', 'Tokyo', 'Asia/Tokyo'), answer('ipapi.co', 'US', 'Los Angeles', 'America/Los_Angeles'), [
      answer('ipinfo.io', 'US', 'Los Angeles', 'America/Los_Angeles')
    ])
    expect(flipped).toMatchObject({ geoConfidence: 'consensus', countryCode: 'US', timezone: 'America/Los_Angeles' })
  })

  it('settles a tie by the measuring service and keeps every country with its zone (user 11-07: 直接联动)', () => {
    const answer = (source: string, country_code: string, timezone: string, latitude: number) =>
      ({ source, result: parseSecondaryGeoLookup({ ip: '203.0.113.10', country_code, timezone, latitude, longitude: 100 }, 10) })
    const merged = mergeGeoLookups(answer('ipwho.is', 'US', 'America/Los_Angeles', 34), answer('ipapi.co', 'JP', 'Asia/Tokyo', 35), [
      answer('ipinfo.io', 'JP', 'Asia/Tokyo', 35), answer('geojs.io', 'US', 'America/Los_Angeles', 34)
    ])
    expect(merged).toMatchObject({ geoConfidence: 'consensus', countryCode: 'JP', timezone: 'Asia/Tokyo', countryBy: 'ipinfo.io' })
    expect(merged.countryVotes).toEqual([
      { countryCode: 'JP', sources: ['ipapi.co', 'ipinfo.io'], timezone: 'Asia/Tokyo', latitude: 35, longitude: 100, accuracyMeters: 25000 },
      { countryCode: 'US', sources: ['ipwho.is', 'geojs.io'], timezone: 'America/Los_Angeles', latitude: 34, longitude: 100, accuracyMeters: 25000 }
    ])
  })

  it('takes the time zone most services give when they disagree on the city', () => {
    const answer = (source: string, city: string, timezone: string) =>
      ({ source, result: parseSecondaryGeoLookup({ ip: '203.0.113.7', country_code: 'US', city, timezone }, 10) })
    // 11-04: four services said Frankfort KY (New York), two Chicago, one Los Angeles; the first two asked were LA and Chicago.
    const merged = mergeGeoLookups(answer('ipinfo.io', 'Los Angeles', 'America/Los_Angeles'), answer('geojs.io', '', 'America/Chicago'), [
      answer('ipwho.is', 'Frankfort', 'America/New_York'), answer('ipapi.co', 'Frankfort', 'America/New_York'),
      answer('ipapi.is', 'Frankfort', 'America/New_York'), answer('ip.sb', 'Frankfort', 'America/Chicago'),
      answer('ip-api', 'Frankfort', 'America/Detroit')
    ])
    // 11-06: the route shows the IP is in Los Angeles; the measuring service (ipinfo.io) decides, with its place.
    expect(merged).toMatchObject({ timezone: 'America/Los_Angeles', timezoneBy: 'ipinfo.io', city: 'Los Angeles' })
    expect(merged.timezoneVotes).toEqual([
      { timezone: 'America/New_York', sources: ['ipwho.is', 'ipapi.co', 'ipapi.is', 'ip-api'] },
      { timezone: 'America/Chicago', sources: ['geojs.io', 'ip.sb'] },
      { timezone: 'America/Los_Angeles', sources: ['ipinfo.io'] }
    ])
    expect(merged.geoSources).toHaveLength(7)
    // Without it (it did not answer): the most votes.
    const others = [answer('geojs.io', '', 'America/Chicago'), answer('ipwho.is', 'Frankfort', 'America/New_York'), answer('ipapi.co', 'Frankfort', 'America/New_York'),
      answer('ipapi.is', 'Frankfort', 'America/New_York'), answer('ip.sb', 'Frankfort', 'America/Chicago')]
    expect(mergeGeoLookups(others[0], others[1], others.slice(2))).toMatchObject({ timezone: 'America/New_York', city: 'Frankfort' })
    expect(mergeGeoLookups(others[0], others[1], others.slice(2)).timezoneBy).toBeUndefined()
  })

  it('without the measuring service, decides a tie by the city most services name, then by the services\' order, never by which answered first', () => {
    const answer = (source: string, city: string, timezone: string) =>
      ({ source, result: parseSecondaryGeoLookup({ ip: '203.0.113.7', country_code: 'US', city, timezone }, 10) })
    // 11-06 (the same Frankfort KY IP): two services New York, two Chicago, one Los Angeles; a check came out Chicago.
    const answers = [
      answer('geojs.io', '', 'America/Chicago'), answer('ipapi.co', 'Frankfort', 'America/New_York'),
      answer('ipwho.is', 'Frankfort', 'America/New_York'), answer('ip.sb', 'Frankfort', 'America/Chicago'),
      answer('ipapi.is', 'Denver', 'America/Denver')
    ]
    // (ipinfo.io did not answer: with it, its zone decides.)
    for (const order of [answers, [...answers].reverse(), [answers[3], answers[0], answers[4], answers[2], answers[1]]]) {
      const merged = mergeGeoLookups(order[0], order[1], order.slice(2))
      expect(merged.timezone).toBe('America/New_York')
      expect(merged.city).toBe('Frankfort')
      expect(merged.timezoneVotes?.map((vote) => [vote.timezone, vote.sources.length])).toEqual([
        ['America/New_York', 2], ['America/Chicago', 2], ['America/Denver', 1]
      ])
    }
    const withMeasured = [...answers, answer('ipinfo.io', 'Los Angeles', 'America/Los_Angeles')].reverse()
    expect(mergeGeoLookups(withMeasured[0], withMeasured[1], withMeasured.slice(2))).toMatchObject({ timezone: 'America/Los_Angeles', timezoneBy: 'ipinfo.io' })
  })

  it('keeps the zone an IP was given by more services when a later check heard from fewer', () => {
    const now = Date.parse('2026-11-06T12:00:00Z')
    const full = { ok: true, latencyMs: 1, ip: '203.0.113.99', timezone: 'America/New_York', geoSources: ['a', 'b', 'c', 'd', 'e'],
      timezoneVotes: [{ timezone: 'America/New_York', sources: ['a', 'b', 'c'] }, { timezone: 'America/Chicago', sources: ['d', 'e'] }] }
    expect(sameIpZone(full, now)).toMatchObject({ timezone: 'America/New_York' })
    // Two services only this time, both Chicago: the earlier, larger vote stands.
    expect(sameIpZone({ ok: true, latencyMs: 1, ip: '203.0.113.99', timezone: 'America/Chicago', geoSources: ['d', 'e'] }, now + 60_000))
      .toEqual({ timezone: 'America/New_York', timezoneVotes: full.timezoneVotes })
    // Another IP: its own answer.
    expect(sameIpZone({ ok: true, latencyMs: 1, ip: '203.0.113.100', timezone: 'America/Chicago', geoSources: ['d', 'e'] }, now)).toEqual({ timezone: 'America/Chicago' })
    // Remembered from a saved check (after a restart) the same way.
    rememberIpZone({ ok: true, ip: '203.0.113.101', timezone: 'America/Denver', geoSources: ['a', 'b', 'c', 'd'], checkedAt: new Date(now).toISOString() })
    expect(sameIpZone({ ok: true, latencyMs: 1, ip: '203.0.113.101', timezone: 'America/Phoenix', geoSources: ['a', 'b'] }, now)).toEqual({ timezone: 'America/Denver' })
    // A decision by the measuring service outranks any count, and is not undone by one.
    const measured = { ok: true, latencyMs: 1, ip: '203.0.113.99', timezone: 'America/Los_Angeles', timezoneBy: 'ipinfo.io', timezoneVotes: full.timezoneVotes }
    expect(sameIpZone(measured, now + 120_000)).toMatchObject({ timezone: 'America/Los_Angeles', timezoneBy: 'ipinfo.io' })
    expect(sameIpZone({ ...full, timezoneVotes: [...full.timezoneVotes, { timezone: 'America/Denver', sources: ['f', 'g'] }] }, now + 180_000)).toMatchObject({ timezone: 'America/Los_Angeles' })
  })

  it('leaves the votes out when the services agree', () => {
    const a = parseSecondaryGeoLookup({ ip: '203.0.113.7', country_code: 'US', timezone: 'America/New_York' }, 10)
    const b = parseSecondaryGeoLookup({ ip: '203.0.113.7', country_code: 'US', timezone: 'America/Detroit' }, 10)
    const merged = mergeGeoLookups({ source: 'ipwho.is', result: a }, { source: 'ipapi.co', result: b })
    expect(merged.timezone).toBe('America/New_York')
    expect(merged.timezoneVotes).toBeUndefined()
  })

  it('reads the other services in the pool', () => {
    const parse = (name: string, data: Record<string, unknown>) => GEO_SOURCES.find((source) => source.name === name)!.parse(data, 5)
    expect(parse('ipinfo.io', { ip: '23.165.248.241', country: 'US', city: 'Los Angeles', loc: '34.05,-118.24', org: 'AS13335 Example', timezone: 'America/Los_Angeles' }))
      .toMatchObject({ countryCode: 'US', country: 'United States', latitude: 34.05, asn: 13335, organization: 'Example', timezone: 'America/Los_Angeles' })
    expect(parse('geojs.io', { ip: '1.2.3.4', country_code: 'DE', country: 'Germany', latitude: '50.1', longitude: '8.6', timezone: 'Europe/Berlin' }))
      .toMatchObject({ countryCode: 'DE', latitude: 50.1, longitude: 8.6 })
    expect(parse('ipapi.is', { ip: '1.2.3.4', is_vpn: true, location: { country_code: 'ES', timezone: 'Europe/Madrid' }, asn: { asn: 3352, org: 'Telefonica' } }))
      .toMatchObject({ countryCode: 'ES', networkRisk: 'vpn', asn: 3352 })
    expect(() => parse('ip.sb', { ip: 'nope' })).toThrow('无效的出口地址')
    expect(GEO_SOURCES.length).toBeGreaterThanOrEqual(6)
  })

  it('asks another service when one is rate-limited, and stops at once when the proxy itself fails', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/limited') { response.writeHead(429).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ip: '203.0.113.7', country_code: 'FR', timezone: { id: 'Europe/Paris' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const source = (name: string, path: string) => ({ name, url: `${base}${path}`, parse: GEO_SOURCES[0].parse })
    try {
      const { answers, failures } = await geoAnswers(undefined, AbortSignal.timeout(5000), Date.now(), [source('a', '/limited'), source('b', '/ok'), source('c', '/ok')])
      expect(answers.map((answer) => answer.source).sort()).toEqual(['b', 'c'])
      expect(failures).toEqual(['a：检测服务返回 HTTP 429'])
      const dead = { name: 'dead', url: 'http://127.0.0.1:1/', parse: GEO_SOURCES[0].parse }
      // A refused connection is the proxy's fault, not the service's: no other service is tried.
      const started = Date.now()
      await expect(geoAnswers(undefined, AbortSignal.timeout(5000), Date.now(), [dead, dead, dead, dead])).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      server.close()
    }
  })
})
