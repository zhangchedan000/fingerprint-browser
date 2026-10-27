import { Alert, Button, Image, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { t, translateMessage as mt } from '../../../../shared/i18n'
import { DEEP_SITES, FINDING_NOTES, type DeepSiteResult } from '../../../../shared/deep-check'
import type { ProfileDraft } from '../../../../shared/types'

const STATUS: Record<DeepSiteResult['status'], [string, string]> = {
  ok: ['success', '通过'],
  warn: ['warning', '有风险'],
  bad: ['error', '不通过'],
  unknown: ['default', '未读到结果']
}

function note(finding: string): string | undefined {
  return FINDING_NOTES.find(([pattern]) => pattern.test(finding))?.[1]
}

/** “Deep check”: what public detection sites (which keep updating their tests) say about the window. */
export function DeepCheck({ draft, profileId }: { draft: () => ProfileDraft; profileId?: string }) {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<DeepSiteResult[]>([])
  const [error, setError] = useState('')

  useEffect(() => window.browserApi.profiles.onDeepCheckProgress((result) => {
    setResults((current) => [...current.filter((item) => item.site !== result.site), result])
  }), [])

  async function run(): Promise<void> {
    setRunning(true)
    setError('')
    setResults([])
    try {
      setResults(await window.browserApi.profiles.deepCheck(draft(), profileId))
    } catch (reason) {
      setError(mt(reason instanceof Error ? reason.message : String(reason)))
    } finally {
      setRunning(false)
    }
  }

  const pending = running ? DEEP_SITES.filter((spec) => !results.some((item) => item.site === spec.site)) : []
  return (
    <div className="fb-deep-check">
      <div className="fb-check-head">
        <span className="fb-check-summary">
          {running
            ? t("正在依次打开 {0} 个检测网站，大约需要 1–3 分钟…", DEEP_SITES.length)
            : t("让 iphey、BrowserScan、Pixelscan、CreepJS 这些持续更新的检测网站来评判这个窗口")}
        </span>
        <Button loading={running} onClick={() => void run()}>{results.length && !running ? t("重新深度检测") : t("深度检测")}</Button>
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      {(results.length > 0 || pending.length > 0) && (
        <div className="fb-deep-results">
          {results.map((result) => {
            const [color, label] = STATUS[result.status]
            return (
              <div key={result.site} className="fb-deep-site">
                {result.screenshot && <Image src={result.screenshot} width={120} className="fb-deep-shot" alt={result.name} />}
                <div className="fb-deep-body">
                  <div className="fb-deep-title">
                    <b>{result.name}</b>
                    <Tag color={color}>{t(label)}</Tag>
                    {result.score && <span className="fb-mono">{result.score}</span>}
                  </div>
                  {result.findings.map((finding) => (
                    <div key={finding} className="fb-deep-finding">
                      <span className="fb-mono">{mt(finding)}</span>
                      {note(finding) && <span className="fb-muted">{t(note(finding)!)}</span>}
                    </div>
                  ))}
                  {result.error && <span className="fb-muted">{mt(result.error)}</span>}
                  <span className="fb-muted fb-ellipsis">{result.url}</span>
                </div>
              </div>
            )
          })}
          {pending.map((spec) => (
            <div key={spec.site} className="fb-deep-site is-pending"><b>{spec.name}</b><span className="fb-muted">{t("等待中…")}</span></div>
          ))}
        </div>
      )}
    </div>
  )
}
