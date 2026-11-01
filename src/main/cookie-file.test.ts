import { describe, expect, it } from 'vitest'
import { parseCookieFile, serializeCookieFile } from './cookie-file'

describe('Cookie file format', () => {
  it('normalizes a common browser-extension Cookie array', () => {
    const cookies = parseCookieFile(JSON.stringify([{
      domain: '.example.com',
      name: 'session',
      value: 'sensitive-value',
      path: '/',
      expirationDate: 2_000_000_000,
      httpOnly: true,
      secure: true,
      sameSite: 'no_restriction'
    }]))

    expect(cookies).toEqual([{
      domain: '.example.com',
      name: 'session',
      value: 'sensitive-value',
      path: '/',
      expires: 2_000_000_000,
      httpOnly: true,
      secure: true,
      sameSite: 'None'
    }])
  })

  it('round-trips the Prism format and preserves session cookies', () => {
    const raw = serializeCookieFile('环境 1', [{
      url: 'https://example.com/', name: 'session-only', value: '1', path: '/', session: true
    }])
    const cookies = parseCookieFile(raw)

    expect(cookies[0].url).toBe('https://example.com/')
    expect(cookies[0].expires).toBeUndefined()
    expect(raw).toContain('prism-browser-cookies')
  })

  it('rejects malformed domains and oversized batches', () => {
    expect(() => parseCookieFile(JSON.stringify([{ name: 'a', value: 'b', domain: 'https://example.com' }]))).toThrow('域名无效')
    const oversized = Array.from({ length: 10_001 }, () => ({ name: 'a', value: 'b', domain: 'example.com' }))
    expect(() => parseCookieFile(JSON.stringify(oversized))).toThrow('10000')
  })

  it('reads Netscape cookies.txt, including HttpOnly lines', () => {
    const text = [
      '# Netscape HTTP Cookie File',
      '.tiktok.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tabc123',
      '#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t0\tsid_tt\txyz'
    ].join('\n')
    const cookies = parseCookieFile(text)
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toMatchObject({ domain: '.tiktok.com', name: 'sessionid', value: 'abc123', secure: true, httpOnly: false, expires: 1893456000 })
    expect(cookies[1]).toMatchObject({ name: 'sid_tt', httpOnly: true })
    expect(cookies[1].expires).toBeUndefined()
  })

  it('reads a "name=value; …" header when the site is on the first line', () => {
    const cookies = parseCookieFile('https://www.tiktok.com\nCookie: a=1; b=two=2; c=')
    expect(cookies.map((cookie) => [cookie.name, cookie.value])).toEqual([['a', '1'], ['b', 'two=2'], ['c', '']])
    expect(cookies[0]).toMatchObject({ url: 'https://www.tiktok.com', secure: true })
    expect(parseCookieFile('tiktok.com\na=1')[0].url).toBe('https://tiktok.com')
    expect(() => parseCookieFile('a=1; b=2')).toThrow('第一行写上网站地址')
    expect(() => parseCookieFile('hello world')).toThrow('无法识别 Cookie 格式')
  })
})
