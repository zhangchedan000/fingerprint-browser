import { t, getLocale } from '../../../../shared/i18n'
import type { BrowserProfileView, ProfileStatus } from '../../../../shared/types'

let collatorLocale = getLocale()
let collator = new Intl.Collator(collatorLocale, { numeric: true, sensitivity: 'base' })
function compareText(a: string, b: string): number {
  if (collatorLocale !== getLocale()) {
    collatorLocale = getLocale()
    collator = new Intl.Collator(collatorLocale, { numeric: true, sensitivity: 'base' })
  }
  return collator.compare(a, b)
}
const statusLabels: Record<ProfileStatus, string> = {
  closed: '已关闭',
  starting: '启动中',
  running: '运行中',
  stopping: '关闭中',
  orphaned: '进程遗留',
  error: '异常'
}

function tieBreak(first: BrowserProfileView, second: BrowserProfileView): number {
  return first.serialNumber - second.serialNumber || compareText(first.id, second.id)
}

function textThenStable(firstText: string, secondText: string, first: BrowserProfileView, second: BrowserProfileView): number {
  return compareText(firstText, secondText) || tieBreak(first, second)
}

export const profileTableSorters = {
  environment: (first: BrowserProfileView, second: BrowserProfileView) => tieBreak(first, second),
  classification: (first: BrowserProfileView, second: BrowserProfileView) => textThenStable(
    `${first.group || t('未分组')}\u0000${first.tags.join('\u0000')}`,
    `${second.group || t('未分组')}\u0000${second.tags.join('\u0000')}`,
    first,
    second
  ),
  status: (first: BrowserProfileView, second: BrowserProfileView) => textThenStable(
    t(statusLabels[first.status]), t(statusLabels[second.status]), first, second
  ),
  proxy: (first: BrowserProfileView, second: BrowserProfileView) => textThenStable(
    first.proxy.protocol === 'direct' ? t('本地网络') : `${first.proxy.protocol}\u0000${first.proxy.host}\u0000${first.proxy.port ?? 0}`,
    second.proxy.protocol === 'direct' ? t('本地网络') : `${second.proxy.protocol}\u0000${second.proxy.host}\u0000${second.proxy.port ?? 0}`,
    first,
    second
  ),
  fingerprint: (first: BrowserProfileView, second: BrowserProfileView) => textThenStable(
    `${first.fingerprint.platform}\u0000${first.fingerprint.screenWidth}x${first.fingerprint.screenHeight}\u0000${first.fingerprint.timezone}\u0000${first.kernelVersion}`,
    `${second.fingerprint.platform}\u0000${second.fingerprint.screenWidth}x${second.fingerprint.screenHeight}\u0000${second.fingerprint.timezone}\u0000${second.kernelVersion}`,
    first,
    second
  ),
  seed: (first: BrowserProfileView, second: BrowserProfileView) => first.fingerprint.seed - second.fingerprint.seed || tieBreak(first, second)
} satisfies Record<string, (first: BrowserProfileView, second: BrowserProfileView) => number>
