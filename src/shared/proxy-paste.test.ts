import { describe, expect, it } from 'vitest'
import { parsePastedProxy, splitPastedProxies } from './proxy-paste'

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

describe('parsePastedProxy: more seller formats', () => {
  const expected = { protocol: undefined, host: '216.23.94.223', port: 19688, username: '82c77e14-1ed2', password: 'p@ss:w0rd' }

  it('reads labeled lists in Chinese or English, on several lines or squashed into one', () => {
    const text = '客户端地址：216.23.94.223\n客户端端口：19688\n客户端用户名：82c77e14-1ed2\n客户端密码：p@ss:w0rd'
    expect(parsePastedProxy(text)).toEqual(expected)
    // A single-line input turns pasted line breaks into spaces.
    expect(parsePastedProxy(text.replace(/\n/g, ' '))).toEqual(expected)
    expect(parsePastedProxy('IP地址: 216.23.94.223  端口号=19688  账号：82c77e14-1ed2  密码：p@ss:w0rd')).toEqual(expected)
    expect(parsePastedProxy('Host: 216.23.94.223\nPort: 19688\nUsername: 82c77e14-1ed2\nPassword: p@ss:w0rd\nType: SOCKS5'))
      .toEqual({ ...expected, protocol: 'socks5' })
    expect(parsePastedProxy('代理地址：216.23.94.223:19688 协议：http')).toMatchObject({ host: '216.23.94.223', port: 19688, protocol: 'http', username: '' })
    expect(parsePastedProxy('地址：socks5://u:p@216.23.94.223:19688')).toMatchObject({ protocol: 'socks5', username: 'u', port: 19688 })
  })

  it('reads reversed and differently separated lists', () => {
    expect(parsePastedProxy('82c77e14-1ed2:secret:216.23.94.223:19688')).toMatchObject({ host: '216.23.94.223', port: 19688, username: '82c77e14-1ed2', password: 'secret' })
    expect(parsePastedProxy('216.23.94.223|19688|user|secret')).toMatchObject({ host: '216.23.94.223', port: 19688, username: 'user', password: 'secret' })
    expect(parsePastedProxy('216.23.94.223,19688,user,secret')).toMatchObject({ port: 19688, password: 'secret' })
    expect(parsePastedProxy('216.23.94.223\t19688\tuser\tsecret')).toMatchObject({ port: 19688, username: 'user' })
    expect(parsePastedProxy('216.23.94.223 19688 user secret')).toMatchObject({ port: 19688, password: 'secret' })
    expect(parsePastedProxy('proxy.example.com:8000:user:secret')).toMatchObject({ host: 'proxy.example.com', port: 8000 })
    expect(parsePastedProxy('216.23.94.223:19688@user:secret')).toMatchObject({ host: '216.23.94.223', port: 19688, username: 'user', password: 'secret' })
  })

  it('cleans up chat-app punctuation and knows protocol nicknames', () => {
    expect(parsePastedProxy('“216.23.94.223：19688：user：secret”')).toMatchObject({ host: '216.23.94.223', port: 19688, password: 'secret' })
    expect(parsePastedProxy('s5://user:secret@216.23.94.223:19688').protocol).toBe('socks5')
    expect(parsePastedProxy('sock5://216.23.94.223:19688').protocol).toBe('socks5')
    expect(() => parsePastedProxy('socks4://216.23.94.223:19688')).toThrow('不支持')
  })

  it('still refuses several proxies in one form', () => {
    expect(() => parsePastedProxy('1.2.3.4:80:u:p\n5.6.7.8:80:u:p')).toThrow('一次只能')
  })
})

describe('splitPastedProxies', () => {
  it('keeps labeled blocks together and splits plain lists by line', () => {
    const text = '地址：1.1.1.1\n端口：80\n用户名：a\n密码：b\n\n地址：2.2.2.2\n端口：81\n# comment\n3.3.3.3:82:u:p'
    expect(splitPastedProxies(text)).toEqual([
      { line: 1, text: '地址:1.1.1.1\n端口:80\n用户名:a\n密码:b' },
      { line: 6, text: '地址:2.2.2.2\n端口:81' },
      { line: 9, text: '3.3.3.3:82:u:p' }
    ])
    expect(splitPastedProxies(text).map((entry) => parsePastedProxy(entry.text).port)).toEqual([80, 81, 82])
  })
})
