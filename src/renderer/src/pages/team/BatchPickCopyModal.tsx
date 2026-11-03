import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Modal, Radio, Select, Table } from 'antd'
import { getLocale, t } from '../../../../shared/i18n'
import type { TeamDeviceStateView, TeamProfileView } from '../../../../shared/team'
import { formatBytes, shortDateTime } from '../../components/format'

export interface BatchPickRow {
  profile: TeamProfileView
  /** The window's copies per computer, newest first. */
  states: TeamDeviceStateView[]
}

export interface BatchPickRequest {
  rows: BatchPickRow[]
  /** Per window (cloud id): the copy to put in, or undefined for the usual rule; null: cancelled. */
  resolve: (choices: Map<string, string | undefined> | null) => void
}

const DEFAULT = 'default'
const LATEST = 'latest'

/** A computer across windows: its name and the first characters of its id. */
const computerKey = (state: TeamDeviceStateView) => `${state.deviceName}|${state.deviceShort}`

/**
 * 批量「添加到本机」: which login state goes into each window. The usual rule (this computer's own copy
 * when it has one, else the latest), the latest copy, or one computer's copy for all of them; each
 * window can be changed on its own. Windows with one copy or none take it without a choice.
 */
export function BatchPickCopyModal({ request, onClose }: { request?: BatchPickRequest; onClose: () => void }) {
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [all, setAll] = useState<string>(DEFAULT)
  const [computer, setComputer] = useState<string>()

  useEffect(() => {
    setChoices({})
    setAll(DEFAULT)
    setComputer(undefined)
  }, [request])

  const rows = request?.rows ?? []
  const computers = useMemo(() => {
    const seen = new Map<string, TeamDeviceStateView>()
    for (const row of rows) for (const state of row.states) if (!seen.has(computerKey(state))) seen.set(computerKey(state), state)
    return [...seen.entries()]
  }, [rows])
  const sameName = (state: TeamDeviceStateView) => computers.some(([key, other]) => key !== computerKey(state) && other.deviceName === state.deviceName)
  const computerLabel = (state: TeamDeviceStateView) => [
    state.deviceName + (state.thisComputer ? t("（本机）") : '') + (sameName(state) ? ` · ${t("编号 {0}", state.deviceShort)}` : ''),
    state.os
  ].filter(Boolean).join(' · ')

  /** A quick choice applied to every window that has more than one copy. */
  function applyAll(mode: string, key = computer): void {
    setAll(mode)
    const next: Record<string, string> = {}
    for (const row of rows) {
      if (row.states.length < 2) continue
      if (mode === LATEST) next[row.profile.id] = row.states[0].id
      else if (mode === 'computer' && key) next[row.profile.id] = row.states.find((state) => computerKey(state) === key)?.id ?? DEFAULT
      else next[row.profile.id] = DEFAULT
    }
    setChoices(next)
  }

  function finish(ok: boolean): void {
    if (!request) return
    request.resolve(ok
      ? new Map(rows.map((row) => {
        const choice = choices[row.profile.id]
        return [row.profile.id, choice && choice !== DEFAULT ? choice : undefined]
      }))
      : null)
    onClose()
  }

  const usual = (row: BatchPickRow) => row.states.some((state) => state.thisComputer) ? t("默认：本机那份") : t("默认：云端最新")

  return (
    <Modal
      open={Boolean(request)}
      width={860}
      title={t("添加到本机：用哪台电脑的登录状态")}
      maskClosable={false}
      onCancel={() => finish(false)}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={() => finish(false)}>{t("取消")}</Button>,
        <Button key="ok" type="primary" onClick={() => finish(true)}>{t("添加到本机（{0} 个）", rows.length)}</Button>
      ]}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t("默认规则：本机以前用过的窗口用本机那份备份，没有的用云端最新的一份。只有一份或没有备份的窗口直接添加。")}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span>{t("全部改成：")}</span>
        <Radio.Group
          optionType="button"
          size="small"
          value={all}
          onChange={(event) => applyAll(event.target.value as string)}
          options={[
            { value: DEFAULT, label: t("默认规则") },
            { value: LATEST, label: t("云端最新") },
            { value: 'computer', label: t("某台电脑的"), disabled: !computers.length }
          ]}
        />
        {all === 'computer' && (
          <Select
            size="small"
            style={{ minWidth: 280 }}
            placeholder={t("选一台电脑")}
            value={computer}
            onChange={(key: string) => { setComputer(key); applyAll('computer', key) }}
            options={computers.map(([key, state]) => ({ value: key, label: computerLabel(state) }))}
          />
        )}
      </div>
      <Table<BatchPickRow>
        size="small"
        rowKey={(row) => row.profile.id}
        pagination={false}
        scroll={{ y: 360 }}
        dataSource={rows}
        columns={[
          { title: t("窗口"), key: 'name', width: 180, render: (_value, row) => <strong>{row.profile.name}</strong> },
          {
            title: t("用哪份"),
            key: 'copy',
            render: (_value, row) => row.states.length < 2
              ? <span className="fb-muted">{row.states.length ? t("只有这一份：{0}", computerLabel(row.states[0])) : t("云端最新")}</span>
              : (
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={choices[row.profile.id] ?? DEFAULT}
                  onChange={(value: string) => setChoices((current) => ({ ...current, [row.profile.id]: value }))}
                  options={[
                    { value: DEFAULT, label: usual(row) },
                    ...row.states.map((state, index) => ({
                      value: state.id,
                      label: `${computerLabel(state)} · ${shortDateTime(state.updated, getLocale())} · ${formatBytes(state.size)}${index === 0 ? t("（最新）") : ''}`
                    }))
                  ]}
                />
              )
          }
        ]}
      />
    </Modal>
  )
}
