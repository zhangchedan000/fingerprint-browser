import { Button, Image, Skeleton } from 'antd'
import { getLocale, t, translateMessage as mt } from '../../../shared/i18n'
import type { IpSiteReading, IpSiteRecord } from '../../../shared/ip-sites'
import { relativeTime } from './format'

const USAGE: Record<NonNullable<IpSiteReading['usage']>, string> = {
  datacenter: '数据中心',
  residential: '家宽',
  mobile: '移动网络',
  business: '企业网络',
  other: '其他'
}

/** One other site's verdicts in a line, in its own words ("风控值 20% 纯净 · IDC机房 IP · 广播 IP"). */
function summary(reading: IpSiteReading): string {
  return [
    reading.score && `${reading.scoreKind === 'risk' ? t("风控值") : t("评分")} ${reading.score}${reading.scoreOf ? `/${reading.scoreOf}` : ''}${reading.scoreNote ? `（${reading.scoreNote}）` : ''}`,
    reading.usageText,
    reading.nativeText
  ].filter(Boolean).join(' · ')
}

/** Where the other site disagrees with the baseline on what counts (native, data centre or home line). */
function differences(baseline: IpSiteReading, other: IpSiteReading): string[] {
  const found: string[] = []
  if (baseline.native !== undefined && other.native !== undefined && baseline.native !== other.native) found.push(other.nativeText ?? '')
  if (baseline.usage && other.usage && baseline.usage !== other.usage) found.push(other.usageText ?? '')
  return found.filter(Boolean)
}

/**
 * The right side of the exit IP card: what the baseline site says about the IP (score, place,
 * company, usage, native), in Chinese, with the other site's verdicts beside it.
 */
export function IpScorePanel({ record, loading, error, checkIp, onRetry, onOpen }: {
  record?: IpSiteRecord
  loading?: boolean
  error?: string
  /** The exit IP of the check shown on the left. */
  checkIp?: string
  onRetry?: () => void
  /** Opens a site in this window (saved windows only). */
  onOpen?: (url: string) => void
}) {
  if (loading) {
    return (
      <div className="fb-ip-score">
        <Skeleton active title={false} paragraph={{ rows: 4, width: ['70%', '55%', '80%', '45%'] }} />
        <div className="fb-ip-score-src">{t("正在用这个窗口打开检测网站读取…（约 10–30 秒）")}</div>
      </div>
    )
  }
  if (error || !record) {
    return (
      <div className="fb-ip-score is-empty">
        <span className="fb-muted">{error ? mt(error) : t("检测后从检测网站读取 IP 评分")}</span>
        {onRetry && <Button type="link" size="small" className="fb-link-start" onClick={onRetry}>{error ? t("重新读取") : t("读取 IP 评分")}</Button>}
      </div>
    )
  }
  const base = record.baseline
  if (base.error || !base.score) {
    return (
      <div className="fb-ip-score is-failed">
        <b>{t("{0} 没读到", base.name)}</b>
        <span className="fb-muted">{mt(base.error ?? '页面没有出结果')}</span>
        <span className="fb-ip-score-actions">
          {onOpen && <Button type="link" size="small" className="fb-link-start" onClick={() => onOpen(base.url)}>{t("在窗口里打开 {0} 看", base.name)}</Button>}
          {onRetry && <Button type="link" size="small" className="fb-link-start" onClick={onRetry}>{t("重新读取")}</Button>}
        </span>
        {base.screenshot && <Image src={base.screenshot} width={120} className="fb-ip-score-shot" />}
        {record.other && !record.other.error && <span className="fb-ip-score-src">{record.other.name}：{summary(record.other)}</span>}
      </div>
    )
  }
  const scoreValue = Number.parseFloat(base.score)
  const scoreMax = Number.parseFloat(base.scoreOf ?? '100')
  const other = record.other
  const diff = other && !other.error ? differences(base, other) : []
  const sameIp = (reading: IpSiteReading | undefined) => !reading?.ip || !checkIp || reading.ip === checkIp
  return (
    <div className="fb-ip-score">
      <span className="k">{base.scoreKind === 'risk' ? t("风控值") : t("IP 评分")}</span>
      <span className="v fb-ip-score-value">
        <b>{base.score}</b>
        {Number.isFinite(scoreValue) && Number.isFinite(scoreMax) && scoreMax > 0 && <span className="fb-ip-score-bar"><i style={{ width: `${Math.min(100, (scoreValue / scoreMax) * 100)}%` }} /></span>}
        {base.scoreOf && <span className="fb-muted">/{base.scoreOf}</span>}
        {base.scoreNote && <span className="fb-muted">{base.scoreNote}</span>}
      </span>
      <span className="k">{t("地区")}</span>
      <span className="v">{[base.country, base.city].filter(Boolean).join(' · ') || '-'}</span>
      <span className="k">{t("厂商")}</span>
      <span className="v">{base.company ?? '-'}</span>
      <span className="k">{t("类型")}</span>
      {/* The site's own words, coloured by what they mean. */}
      <span className="v">{base.usage ? <span className={`fb-ip-tag is-${base.usage}`}>{base.usageText ?? t(USAGE[base.usage])}</span> : '-'}</span>
      <span className="k">{t("原生")}</span>
      <span className="v">{base.nativeText ? <span className={`fb-ip-tag ${base.native ? 'is-native' : 'is-broadcast'}`}>{base.nativeText}</span> : '-'}</span>
      <div className="fb-ip-score-src">
        <span>{t("以 {0} 为准", base.name)}{other ? ` · ${t("对照 {0}：{1}", other.name, other.error ? t("没读到") : summary(other) || t("只截图"))}` : ''}</span>
        {diff.length > 0 && <span className="is-diff">{t("{0} 判断为「{1}」，两边不一致", other!.name, diff.join('、'))}</span>}
        {(!sameIp(base) || !sameIp(other)) && <span className="is-diff">{t("网站看到的 IP 和检测到的不是同一个（代理在换出口 IP）")}</span>}
        <span>{relativeTime(record.checkedAt, getLocale())}</span>
        {other?.screenshot && !other.score && <Image src={other.screenshot} width={96} className="fb-ip-score-shot" />}
      </div>
    </div>
  )
}
