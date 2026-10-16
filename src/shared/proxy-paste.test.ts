import { describe, expect, it } from 'vitest'
import { parsePastedProxy } from './proxy-paste'

describe('parsePastedProxy', () => {
  it('reads URL style proxies with credentials', () => {
    expect(parsePastedProxy('socks5://user:p%40ss@203.0.113.9:1080')).toEqual({
      protocol: 'socks5', host: '203.0.113.9', port: 1080, username: 'user', password: 'p@ss'
    })
    expect(parsePastedProxy(' http://proxy.example.com:8080/ ')).toEqual({
      protocol: 'http', host: 'proxy.example.com', port: 8080, username: '', password: ''
    })
    expect(parsePastedProxy('socks5h://u:p@h.example.com:1').protocol).toBe('socks5')
  })

  it('reads the host:port:user:pass format used by proxy shops', () => {
    expect(parsePastedProxy('203.0.113.9:1080:user01:secret')).toEqual({
      protocol: undefined, host: '203.0.113.9', port: 1080, username: 'user01', password: 'secret'
    })
    expect(parsePastedProxy('203.0.113.9:1080:user01:se:cr:et').password).toBe('se:cr:et')
  })

  it('reads bare and credential-prefixed host:port', () => {
    expect(parsePastedProxy('203.0.113.9:3128')).toMatchObject({ host: '203.0.113.9', port: 3128, username: '' })
    expect(parsePastedProxy('user:pass@203.0.113.9:3128')).toMatchObject({ username: 'user', password: 'pass', port: 3128 })
    expect(parsePastedProxy('[2001:db8::1]:1080')).toMatchObject({ host: '2001:db8::1', port: 1080 })
  })

  it('rejects text it cannot understand', () => {
    expect(() => parsePastedProxy('')).toThrow('请粘贴')
    expect(() => parsePastedProxy('ftp://h:1')).toThrow('不支持')
    expect(() => parsePastedProxy('203.0.113.9')).toThrow('无法识别')
    expect(() => parsePastedProxy('203.0.113.9:99999')).toThrow('端口')
    expect(() => parsePastedProxy('a:1 b:2')).toThrow('一次只能')
  })
})
