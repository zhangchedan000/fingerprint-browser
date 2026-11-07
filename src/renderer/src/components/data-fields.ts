import type { BrowserProfileView, ProxyCheckSummary, ProxyRecordView } from '../../../shared/types'
import type { TeamProfileView } from '../../../shared/team'
import { formatBytes, regionName } from './format'

/**
 * Data a table offers for the user's own columns (rule of 11-07): typing a column's name finds the
 * matching field (its label or one of the aliases), or the user picks one; the column then shows it
 * for every row and sorts by it. Rule: data a table holds can be picked here — new data added to a
 * table gets a field too (CLAUDE.md).
 * Labels are source text, translated where shown; aliases are what users may type for the same data.
 */
export interface DataField<T> {
  id: string
  label: string
  aliases: string[]
  /** Numbers sort as numbers; '' and undefined show as — and sort last. */
  value: (row: T) => string | number | undefined
  /** How a number is shown ("120 ms"); the plain value otherwise. */
  format?: (value: number) => string
}

const checked = (check: ProxyCheckSummary | undefined) => (check?.ok ? check : undefined)
const country = (check: ProxyCheckSummary | undefined) => {
  const ok = checked(check)
  return ok?.countryCode ? regionName(ok.countryCode.toUpperCase()) : ok?.country
}
const ms = (value: number) => `${value} ms`
/** This computer's time, written so it sorts as text: 2026-11-07 21:30. */
function localTime(iso: string | undefined): string | undefined {
  const date = iso ? new Date(iso) : undefined
  if (!date || Number.isNaN(date.getTime())) return undefined
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

/** The exit IP and its place, from a proxy check: shared by windows, proxies and nodes. */
function checkFields<T>(check: (row: T) => ProxyCheckSummary | undefined): DataField<T>[] {
  return [
    { id: 'exitIp', label: '出口 IP', aliases: ['IP', 'IP 地址', '出口', 'exit ip', 'ip address'], value: (row) => checked(check(row))?.ip },
    { id: 'country', label: '国家 / 地区', aliases: ['国家', '地区', '国家地区', 'IP 国家', 'country', 'region'], value: (row) => country(check(row)) },
    { id: 'countryCode', label: '国家代码', aliases: ['国家缩写', 'country code', 'cc'], value: (row) => checked(check(row))?.countryCode?.toUpperCase() },
    { id: 'state', label: '州 / 省', aliases: ['州', '省', '省份', 'state', 'province'], value: (row) => checked(check(row))?.region },
    { id: 'city', label: '城市', aliases: ['city', 'IP 城市'], value: (row) => checked(check(row))?.city },
    { id: 'ipTimezone', label: 'IP 时区', aliases: ['出口时区', 'ip timezone', 'ip time zone'], value: (row) => checked(check(row))?.timezone },
    { id: 'isp', label: '运营商', aliases: ['ISP', '服务商', '运营商 / 机构', '机构', 'organization', 'org'], value: (row) => { const ok = checked(check(row)); return ok?.isp || ok?.organization } },
    { id: 'asn', label: 'ASN', aliases: ['AS', 'AS 号'], value: (row) => checked(check(row))?.asn },
    { id: 'latency', label: '延迟', aliases: ['ping', 'latency', '速度', '响应时间'], value: (row) => checked(check(row))?.latencyMs, format: ms },
    { id: 'checkedAt', label: '最后检测', aliases: ['检测时间', '检测日期', 'checked'], value: (row) => localTime(check(row)?.checkedAt) }
  ]
}

export const windowDataFields: DataField<BrowserProfileView>[] = [
  ...checkFields<BrowserProfileView>((row) => row.proxyCheck),
  { id: 'proxyAddress', label: '代理地址', aliases: ['代理', '代理主机', 'proxy', 'host'], value: (row) => row.proxy.protocol === 'direct' ? '' : `${row.proxy.host}:${row.proxy.port}` },
  { id: 'proxyType', label: '代理类型', aliases: ['协议', '代理协议', 'protocol'], value: (row) => row.proxy.protocol === 'direct' ? '' : row.proxy.protocol.toUpperCase() },
  { id: 'timezone', label: '时区', aliases: ['窗口时区', 'timezone', 'time zone'], value: (row) => row.fingerprint.timezone },
  { id: 'language', label: '语言', aliases: ['窗口语言', 'language', 'lang'], value: (row) => row.fingerprint.language },
  { id: 'screen', label: '分辨率', aliases: ['屏幕', '屏幕分辨率', 'screen', 'resolution'], value: (row) => row.fingerprint.screenWidth && row.fingerprint.screenHeight ? `${row.fingerprint.screenWidth} × ${row.fingerprint.screenHeight}` : undefined },
  { id: 'gpu', label: '显卡', aliases: ['GPU', 'WebGL', '显卡型号'], value: (row) => row.fingerprint.gpu?.split('|')[0] },
  { id: 'cpu', label: 'CPU', aliases: ['处理器', 'CPU 型号'], value: (row) => row.fingerprint.cpu },
  { id: 'cores', label: 'CPU 核心数', aliases: ['核心', '核心数', '线程', '线程数', 'cores'], value: (row) => row.fingerprint.hardwareConcurrency },
  { id: 'memory', label: '内存', aliases: ['内存大小', 'memory', 'ram'], value: (row) => row.fingerprint.deviceMemory, format: (value) => `${value} GB` },
  { id: 'kernelVersion', label: '内核版本', aliases: ['内核', 'kernel', 'chrome 版本'], value: (row) => row.kernelVersion },
  { id: 'tags', label: '标签', aliases: ['tag', 'tags'], value: (row) => row.tags.join(', ') },
  { id: 'startUrls', label: '启动网址', aliases: ['网址', '打开网址', 'url', '链接'], value: (row) => row.startUrls.join(', ') },
  { id: 'account', label: '平台账号', aliases: ['账号', '用户名', '账户', 'account', 'username'], value: (row) => row.account.username },
  { id: 'platform', label: '平台', aliases: ['平台名称', 'platform', '店铺平台'], value: (row) => row.account.platform },
  { id: 'updatedAt', label: '修改时间', aliases: ['更新时间', '最后修改', 'updated'], value: (row) => localTime(row.updatedAt) }
]

export const proxyDataFields: DataField<ProxyRecordView>[] = [
  ...checkFields<ProxyRecordView>((row) => row.check).filter((field) => field.id !== 'latency' && field.id !== 'checkedAt'),
  { id: 'host', label: '主机', aliases: ['代理主机', '服务器', 'host', 'server'], value: (row) => row.host },
  { id: 'port', label: '端口', aliases: ['port'], value: (row) => row.port },
  { id: 'username', label: '代理账号', aliases: ['账号', '用户名', 'username', 'user'], value: (row) => row.username },
  { id: 'note', label: '备注', aliases: ['note', '说明'], value: (row) => row.note },
  { id: 'ipScore', label: 'IP 评分', aliases: ['评分', '分数', 'score', 'IP 分数'], value: (row) => { const score = row.ipSites?.baseline.score; const number = score ? Number.parseFloat(score) : NaN; return Number.isFinite(number) ? number : score } },
  { id: 'ipUsage', label: 'IP 类型', aliases: ['住宅', '机房', '用途', 'usage', 'IP 用途'], value: (row) => row.ipSites?.baseline.usageText },
  { id: 'ipNative', label: '原生 IP', aliases: ['原生', '广播', 'native'], value: (row) => row.ipSites?.baseline.nativeText }
]

/** A row of the 节点 table (SubscriptionsSection): the node and its library entry. */
export interface NodeFieldRow {
  source: { name: string }
  node: { name: string; type: string; delay?: number; exitIp?: string; udp?: boolean }
  entry?: ProxyRecordView
}

export const nodeDataFields: DataField<NodeFieldRow>[] = [
  ...checkFields<NodeFieldRow>((row) => row.entry?.check).filter((field) => field.id !== 'exitIp' && field.id !== 'latency'),
  { id: 'subscription', label: '所属订阅', aliases: ['订阅', '订阅名称', 'subscription', '来源'], value: (row) => row.source.name },
  { id: 'udp', label: 'UDP', aliases: ['udp 转发'], value: (row) => row.node.udp === undefined ? undefined : row.node.udp ? '✓' : '✗' },
  { id: 'ipScore', label: 'IP 评分', aliases: ['评分', '分数', 'score'], value: (row) => { const score = row.entry?.ipSites?.baseline.score; const number = score ? Number.parseFloat(score) : NaN; return Number.isFinite(number) ? number : score } }
]

export const teamWindowDataFields: DataField<TeamProfileView>[] = [
  { id: 'dataBy', label: '最后上传', aliases: ['上传人', '上传者', '最后上传人'], value: (row) => row.dataByName },
  { id: 'dataSize', label: '数据大小', aliases: ['大小', '登录态大小', 'size'], value: (row) => row.dataSize || undefined, format: formatBytes },
  { id: 'updated', label: '更新时间', aliases: ['修改时间', 'updated'], value: (row) => localTime(row.updated) },
  { id: 'note', label: '备注', aliases: ['note', '说明'], value: (row) => row.note }
]
