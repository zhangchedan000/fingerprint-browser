import { describe, expect, it } from 'vitest'
import { DEFAULT_IP_CHECK_SITES, ipBaseline, ipSiteInTurn, ipSiteUrl, knownIpSite, parseIpSite, validIpCheckSites } from './ip-sites'

// Page text as the prism kernel read it (2026-10), the IP replaced by an example address and the
// visitor's own other exits left out.
const IPLARK = `×
203.0.113.50
reddit unavailable
数据中心
广播IP (US)
OnesProxy-全球动态及静态原生住宅IP
×
数字地址
2554****6466
国家/地区
韩国
ASN
AS31898 Oracle Cloud (https://cloud.oracle.com)...
企业
Oracle Corporation (oracle.com)
使用场景更多数据（IP情报、C段画像等）
数据中心 | 云厂商
代理检测
已开启VPN/代理
IDC/SOCKS识别（AI模型驱动）
点击开始 AI 检测
IP评分
56
56/100
网络出口
地理位置（多源对比）
IPLark
韩国 江原道 春川
Moe+
韩国`
const PING0 = `IP 地址
203.0.113.50
ping
|
trace
IP 位置
(说明?)
韩国 江原道 春川市 — 甲骨文云 Oracle
错误提交
ASN
AS31898
ASN 所有者
IDC
Oracle Corporation
— cloud.oracle.com
企业
IDC
Oracle Corporation
— cloud.oracle.com
IP 类型
(说明?)
IDC机房 IP
为什么双ISP还会显示"IDC机房IP"?
风控值 (说明?)
20%
纯净
原生 IP
(说明?)
广播 IP
大模型检测`

describe('IP check sites', () => {
  it('reads IPLark: score, country and city, company, usage, broadcast or native', () => {
    expect(parseIpSite('https://iplark.com/', IPLARK)).toEqual({
      ip: '203.0.113.50',
      score: '56',
      scoreOf: '100',
      scoreKind: 'quality',
      country: '韩国',
      city: '春川',
      company: 'Oracle Corporation (oracle.com)',
      usage: 'datacenter',
      usageText: '数据中心 | 云厂商',
      native: false,
      nativeText: '广播IP (US)'
    })
    // Before the score shows, nothing is read yet.
    expect(parseIpSite('https://iplark.com/', IPLARK.replace('IP评分\n56', 'IP评分\n-'))).toBeUndefined()
    expect(parseIpSite('https://iplark.com/', IPLARK.replace('广播IP (US)', '原生IP (US)'))).toMatchObject({ native: true })
  })

  it('reads ping0.cc: risk, place, company, IP type, native', () => {
    expect(parseIpSite('https://ping0.cc/', PING0)).toEqual({
      ip: '203.0.113.50',
      score: '20%',
      scoreKind: 'risk',
      scoreNote: '纯净',
      country: '韩国',
      city: '春川市',
      company: 'Oracle Corporation',
      usage: 'datacenter',
      usageText: 'IDC机房 IP',
      native: false,
      nativeText: '广播 IP'
    })
    expect(parseIpSite('https://ping0.cc/', PING0.replace('IDC机房 IP', '家庭宽带 IP'))).toMatchObject({ usage: 'residential' })
    expect(parseIpSite('https://ping0.cc/', '加载中')).toBeUndefined()
  })

  it('knows its own sites; any other is read by the general reader', () => {
    expect(knownIpSite('https://www.iplark.com/search')).toBe('iplark')
    expect(knownIpSite('https://ping0.cc/ip/1.1.1.1')).toBe('ping0')
    expect(knownIpSite('https://ipure.dev/')).toBeUndefined()
  })

  // Label formats as the pages showed them in the prism kernel (2026-10-30); the values are documentation ones.
  it('reads a tab-separated page (browserleaks.com/ip)', () => {
    const page = 'My IP Address\nIP Address\t203.0.113.9\nHostname\tn/a\nIP Address Location\nCountry\tGermany (DE)\nState/Region\tHesse\nCity\tFrankfurt am Main\nISP\tExample Hosting GmbH\nOrganization\tExample Hosting GmbH\nUsage Type\tCorporate / Hosting\nTimezone\tEurope/Berlin (CET)'
    expect(parseIpSite('https://browserleaks.com/ip', page, '203.0.113.9')).toEqual({
      ip: '203.0.113.9', country: 'Germany (DE)', city: 'Frankfurt am Main', company: 'Example Hosting GmbH', usage: 'datacenter', usageText: 'Corporate / Hosting'
    })
  })

  it('reads labels with the value on the next line, and a score', () => {
    const page = '我的IP: 203.0.113.9\n国家\n日本\n提供商:\nExample Net\nIP 类型\n住宅 IP\n原生 IP\n原生 IP\n欺诈分数\n12（低风险）'
    expect(parseIpSite('https://example.com/', page, '203.0.113.9')).toEqual({
      ip: '203.0.113.9', score: '12', scoreKind: 'risk', scoreOf: '100', scoreNote: '低风险', country: '日本', company: 'Example Net', usage: 'residential', usageText: '住宅 IP', native: true, nativeText: '原生 IP'
    })
  })

  it('reads a JSON answer, and not a page about another IP (a sample on a home page)', () => {
    const json = '{\n  "ip": "203.0.113.9",\n  "country": "Australia",\n  "city": "Brisbane",\n  "org": "AS13335 Example Inc.",\n  "usage_type": "hosting"\n}'
    expect(parseIpSite('https://ipinfo.example/', json, '203.0.113.9')).toMatchObject({ country: 'Australia', city: 'Brisbane', company: 'AS13335 Example Inc.', usage: 'datacenter' })
    expect(parseIpSite('https://ipinfo.example/', json, '198.51.100.7')).toBeUndefined()
    expect(parseIpSite('https://ipure.dev/', 'Nothing about any IP here', '203.0.113.9')).toBeUndefined()
  })

  it('reads Chinese IP-property pages (ippure.com) and prefers a trust score to a threat score (ipdata.co)', () => {
    const ippure = 'IP\n203.0.113.9\nASN\nAS64500 - Example Corp\nIP来源\n广播IP\nIP属性\n机房IP\nIPPure系数\n56%'
    expect(parseIpSite('https://ippure.com/', ippure, '203.0.113.9')).toMatchObject({ score: '56%', scoreKind: 'quality', usage: 'datacenter', usageText: '机房IP', native: false, nativeText: '广播IP' })
    const ipdata = '"ip": "203.0.113.9",\n"country_name": "South Korea",\n"scores": {\n"vpn_score": 100,\n"proxy_score": 1,\n"threat_score": 100,\n"trust_score": 33\n},\n6\tcompany.name\t\nExample Corp\nCOMPANY\nABOUT'
    expect(parseIpSite('https://ipdata.co/', ipdata, '203.0.113.9')).toMatchObject({ score: '33', scoreKind: 'quality', country: 'South Korea', company: 'Example Corp' })
  })

  it('puts the exit IP into an address that asks for it', () => {
    expect(ipSiteUrl('https://scamalytics.com/ip/{ip}', '203.0.113.9')).toBe('https://scamalytics.com/ip/203.0.113.9')
    expect(ipSiteUrl('https://scamalytics.com/ip/%7Bip%7D', '203.0.113.9')).toBe('https://scamalytics.com/ip/203.0.113.9')
    expect(ipSiteUrl('https://scamalytics.com/ip/{ip}')).toBeUndefined()
    expect(ipSiteUrl('https://iplark.com/')).toBe('https://iplark.com/')
  })

  it('picks the baseline (IPLark unless another one is picked) and the other site in turn', () => {
    const sites = [...DEFAULT_IP_CHECK_SITES, { id: 'mine', name: 'Mine', url: 'https://example.com/', enabled: true }]
    expect(ipBaseline(sites, undefined)?.id).toBe('iplark')
    expect(ipBaseline(sites, 'ping0')?.id).toBe('ping0')
    // Any site can be the baseline now (the general reader reads it).
    expect(ipBaseline(sites, 'mine')?.id).toBe('mine')
    expect(ipBaseline(sites.map((site) => site.id === 'iplark' ? { ...site, enabled: false } : site), undefined)?.id).toBe('ping0')
    const baseline = ipBaseline(sites, undefined)
    expect([0, 1, 2].map((turn) => ipSiteInTurn(sites, baseline, turn)?.id)).toEqual(['ping0', 'mine', 'ping0'])
    expect(ipSiteInTurn([DEFAULT_IP_CHECK_SITES[0]], baseline, 0)).toBeUndefined()
  })

  it('keeps a clean list from the settings', () => {
    expect(validIpCheckSites('x')).toBeUndefined()
    expect(validIpCheckSites([{ id: 'a', name: ' A ', url: 'https://a.example/', enabled: true }, { id: 'a', name: 'dup', url: 'https://b.example/' }, { id: 'c', name: 'c', url: 'ftp://c' }]))
      .toEqual([{ id: 'a', name: 'A', url: 'https://a.example/', enabled: true }])
  })
})
