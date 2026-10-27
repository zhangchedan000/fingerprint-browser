import { Alert, Button, Image, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { formatList, t, translateMessage as mt } from '../../../../shared/i18n'
import { DEFAULT_DEEP_CHECK_SITES, FINDING_NOTES, type DeepSiteResult } from '../../../../shared/deep-check'
import { useWorkspace } from '../../data/workspace'
import { DeepCheckSites } from './DeepCheckSites'
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
  const [editingSites, setEditingSites] = useState(false)
  const ws = useWorkspace()
  const sites = (ws.preferences.deepCheckSites ?? DEFAULT_DEEP_CHECK_SITES).filter((site) => site.enabled)

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

  const pending = running ? sites.filter((site) => !results.some((item) => item.site === site.id)) : []
  return (
    <div className="fb-deep-check">
      <div className="fb-check-head">
        <span className="fb-check-summary">
          {running
            ? t("正在依次打开 {0} 个检测网站，大约需要 1–3 分钟…", sites.length)
            : sites.length
              ? t("让 {0} 这些持续更新的检测网站来评判这个窗口", formatList(sites.map((site) => site.name)))
              : t("没有打开的检测网站")}
        </span>
        <Button type="link" size="small" onClick={() => setEditingSites(true)}>{t("检测网站")}</Button>
        <Button loading={running} disabled={!sites.length} onClick={() => void run()}>{results.length && !running ? t("重新深度检测") : t("深度检测")}</Button>
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      <DeepCheckSites open={editingSites} onClose={() => setEditingSites(false)} />
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
          {pending.map((site) => (
            <div key={site.id} className="fb-deep-site is-pending"><b>{site.name}</b><span className="fb-muted">{t("等待中…")}</span></div>
          ))}
        </div>
      )}
    </div>
  )
}
