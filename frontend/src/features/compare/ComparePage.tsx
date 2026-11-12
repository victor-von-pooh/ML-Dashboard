import clsx from 'clsx'
import { GitCompareArrows, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'

import { encodeRunId, type History, type RunDetail } from '../../api/client'
import { useHistories, useProject, useRunDetails } from '../../api/hooks'
import { LineChart, type ChartSeries } from '../../components/LineChart'
import { Card, EmptyState, ErrorBox, PageHeader, Spinner, StatusBadge } from '../../components/ui'
import { formatDateTime, formatDuration, formatMetric, formatValue } from '../../lib/format'
import { diffConfigs, flattenConfig, groupMetrics, toPoints } from '../../lib/metrics'
import { seriesVar } from '../../lib/colors'

/** 実験の短い名前 (日付と時刻) */
function shortLabel(runId: string): string {
  const parts = runId.split('/')
  return parts.length >= 3 ? `${parts[0]} ${parts[1]?.slice(5)} ${parts[2]}` : runId
}

export function ComparePage() {
  const { projectId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const runIds = params.getAll('run')
  const project = useProject(projectId)
  const histories = useHistories(projectId, runIds)
  const details = useRunDetails(projectId, runIds)
  const [showTrain, setShowTrain] = useState(false)

  const loaded = details.every((query) => query.data) && histories.every((query) => query.data)
  const error = [...details, ...histories].find((query) => query.error)?.error

  const runs = details.map((query) => query.data).filter((run): run is RunDetail => !!run)
  const historyList = histories.map((query) => query.data).filter((h): h is History => !!h)

  // 全ての実験の列を, 指標の順にそろえて並べる
  // 検証用がある指標の学習用は, 指定した場合だけ表示
  const allColumns = [...new Set(historyList.flatMap((history) => history.columns))]
  const columns = groupMetrics(allColumns)
    .flatMap((group) => group.keys)
    .filter(
      (key) =>
        showTrain ||
        !key.startsWith('train/') ||
        !allColumns.includes(key.replace('train/', 'valid/')),
    )

  // 実験ごとの色の変数名
  const colors = runIds.map((_, index) => `var(${seriesVar(index)})`)

  const configKeys = useMemo(() => diffConfigs(runs.map((run) => run.config)), [runs])
  const flatConfigs = useMemo(() => runs.map((run) => flattenConfig(run.config)), [runs])

  const remove = (runId: string) => {
    const next = new URLSearchParams()
    for (const id of runIds.filter((item) => item !== runId)) next.append('run', id)
    setParams(next)
  }

  const header = (
    <PageHeader
      breadcrumb={
        <>
          <Link to="/" className="hover:text-ink">
            プロジェクト
          </Link>
          {' / '}
          <Link to={`/projects/${projectId}`} className="hover:text-ink">
            {project.data?.name ?? projectId}
          </Link>
        </>
      }
      title="実験の比較"
      subtitle={`${runIds.length} 件の実験`}
    />
  )

  if (runIds.length < 2) {
    return (
      <>
        {header}
        <EmptyState icon={GitCompareArrows} title="比べる実験を選んでください">
          実験の一覧で 2 つ以上の実験にチェックを入れて「比較」を押します.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      {header}
      {error && <ErrorBox error={error} />}
      {!loaded && !error && <Spinner />}

      {loaded && (
        <div className="space-y-6">
          {/* 実験ごとの色の凡例と主な結果 */}
          <Card title="実験" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-xs text-ink-3">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium">実験</th>
                    <th className="px-4 py-2 font-medium">状態</th>
                    <th className="px-4 py-2 text-right font-medium">ベスト</th>
                    <th className="px-4 py-2 text-right font-medium">エポック</th>
                    <th className="px-4 py-2 text-right font-medium">学習時間</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run, index) => (
                    <tr key={run.id} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-1 w-4 shrink-0 rounded-full"
                            style={{ background: colors[index] }}
                            aria-hidden
                          />
                          <Link
                            to={`/projects/${projectId}/runs/${encodeRunId(run.id)}`}
                            className="font-medium hover:text-accent"
                          >
                            {shortLabel(run.id)}
                          </Link>
                        </div>
                        <div className="pl-6 text-xs text-ink-3">
                          {formatDateTime(run.started_at)}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="tabular px-4 py-2 text-right">
                        {run.best ? (
                          <>
                            {formatMetric(run.best.value)}
                            <div className="text-[11px] text-ink-3">
                              {run.best.monitor} @ {run.best.epoch}
                            </div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="tabular px-4 py-2 text-right">{run.epochs}</td>
                      <td className="tabular px-4 py-2 text-right text-ink-2">
                        {formatDuration(run.duration_sec)}
                      </td>
                      <td className="px-2">
                        {runIds.length > 2 && (
                          <button
                            type="button"
                            onClick={() => remove(run.id)}
                            className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
                            aria-label={`${run.id} を比較から外す`}
                          >
                            <X className="size-3.5" aria-hidden />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* 指標ごとに実験を重ねたグラフ */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">学習曲線</h2>
              <label className="flex items-center gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={showTrain}
                  onChange={(event) => setShowTrain(event.target.checked)}
                  className="accent-[var(--accent)]"
                />
                検証用がある指標も学習用を表示する
              </label>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {columns.map((column) => {
                const series: ChartSeries[] = historyList.map((history, index) => ({
                  name: shortLabel(runIds[index] ?? ''),
                  color: seriesVar(index),
                  points: toPoints(history, column),
                }))
                return (
                  <Card key={column} title={<span className="font-mono">{column}</span>}>
                    <LineChart series={series} xLabel="epoch" />
                  </Card>
                )
              })}
            </div>
          </div>

          {/* config の違う項目 */}
          <Card title={`config の違い (${configKeys.length})`} padded={false}>
            {configKeys.length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-3">全ての実験で config が同じです.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-ink-3">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-medium">項目</th>
                      {runs.map((run, index) => (
                        <th key={run.id} className="px-4 py-2 font-medium">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="h-1 w-3 rounded-full"
                              style={{ background: colors[index] }}
                              aria-hidden
                            />
                            {shortLabel(run.id)}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {configKeys.map((key) => (
                      <tr key={key} className="border-b border-line last:border-b-0">
                        <td className="px-4 py-1.5 font-mono text-xs text-ink-2">{key}</td>
                        {flatConfigs.map((config, index) => (
                          <td
                            key={runs[index]?.id}
                            className={clsx(
                              'px-4 py-1.5 font-mono text-xs break-all',
                              config[key] === undefined && 'text-ink-3',
                            )}
                          >
                            {config[key] === undefined ? '—' : formatValue(config[key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
