import clsx from 'clsx'
import { GitCompareArrows, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'

import { encodeRunId, type History, type RunDetail } from '../../api/client'
import { useHistories, useProject, useRunDetails } from '../../api/hooks'
import { LineChart, type ChartSeries } from '../../components/LineChart'
import { Card, EmptyState, ErrorBox, PageHeader, Spinner, StatusBadge } from '../../components/ui'
import { seriesVar } from '../../lib/colors'
import { formatDateTime, formatDuration, formatMetric, formatValue } from '../../lib/format'
import { groupImageSeries, sharedImageSeries } from '../../lib/images'
import { MAX_COMPARE, diffConfigs, flattenConfig, groupMetrics, toPoints } from '../../lib/metrics'
import { ImageCompare } from './ImageCompare'

/** 実験の短い名前. 名前が全て同じなら月日と時刻だけ, 違うなら名前と時刻 */
function makeLabel(runIds: string[]): (runId: string) => string {
  const names = new Set(runIds.map((id) => id.split('/')[0]))
  return (runId) => {
    const [name, date, time] = runId.split('/')
    if (!date || !time) return runId
    return names.size === 1 ? `${date.slice(5)} ${time}` : `${name} ${time}`
  }
}

interface Slot {
  id: string
  color: string
  run?: RunDetail
  history?: History
  error?: unknown
}

export function ComparePage() {
  const { projectId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const [showTrain, setShowTrain] = useState(false)
  const [logScale, setLogScale] = useState(false)
  const project = useProject(projectId)

  // 同じ実験の重複を除き, 色の数までに制限
  const runIds = useMemo(
    () => [...new Set(params.getAll('run').filter(Boolean))].slice(0, MAX_COMPARE),
    [params],
  )
  const shortLabel = useMemo(() => makeLabel(runIds), [runIds])

  // 一覧に戻るときに, 比較している実験を選んだままにする
  const backParams = new URLSearchParams()
  for (const id of runIds) backParams.append('sel', id)
  const backUrl = `/projects/${projectId}?${backParams.toString()}`
  const details = useRunDetails(projectId, runIds)
  // 学習中の実験は, 曲線と画像を一定の間隔で読み直す
  const liveIds = new Set(runIds.filter((_, index) => details[index]?.data?.status === 'running'))
  const histories = useHistories(projectId, runIds, liveIds)

  // 実験ごとに, 色と読み込んだ結果をまとめる (色は選んだ順で固定)
  const slots: Slot[] = runIds.map((id, index) => ({
    id,
    color: seriesVar(index),
    run: details[index]?.data,
    history: histories[index]?.data,
    error: details[index]?.error ?? histories[index]?.error ?? undefined,
  }))
  const loading = slots.some((slot) => !slot.error && (!slot.run || !slot.history))
  const ready = slots.filter((slot): slot is Required<Omit<Slot, 'error'>> & Slot =>
    Boolean(slot.run && slot.history),
  )
  // 全ての実験の列を, 指標の順にそろえて並べる
  // 検証用がある指標の学習用は, 指定した場合だけ表示
  // 描き直してもグラフの拡大と凡例の選択は残るので, 描画ごとに作り直す
  const allColumns = [...new Set(ready.flatMap((slot) => slot.history.columns))]
  const charts = groupMetrics(allColumns)
    .flatMap((group) => group.keys)
    .filter(
      (key) =>
        showTrain ||
        !key.startsWith('train/') ||
        !allColumns.includes(key.replace('train/', 'valid/')),
    )
    .map((column) => {
      const having = ready.filter((slot) => slot.history.columns.includes(column))
      const missing = ready.filter((slot) => !slot.history.columns.includes(column))
      const series: ChartSeries[] = having.map((slot) => ({
        name: shortLabel(slot.id),
        color: slot.color,
        points: toPoints(slot.history, column),
      }))
      return { column, series, missing: missing.map((slot) => shortLabel(slot.id)) }
    })

  // 2 つ以上の実験にある番号付きの画像の並び (同じエポックの生成画像などを並べて比べる)
  const sharedImages = sharedImageSeries(ready.map((slot) => groupImageSeries(slot.run.files, 1)))

  const configKeys = diffConfigs(ready.map((slot) => slot.run.config))
  const flatConfigs = ready.map((slot) => flattenConfig(slot.run.config))

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
          <Link to={backUrl} className="hover:text-ink">
            {project.data?.name ?? projectId}
          </Link>
        </>
      }
      title="実験の比較"
      subtitle={`${runIds.length} 件の実験${ready.length < runIds.length && !loading ? ` (表示できたのは ${ready.length} 件)` : ''}`}
    />
  )

  if (runIds.length < 2) {
    return (
      <>
        {header}
        <EmptyState icon={GitCompareArrows} title="比べる実験を選んでください">
          <Link to={backUrl} className="text-accent-text hover:underline">
            実験の一覧
          </Link>
          で 2 つ以上の実験にチェックを入れて「比較」を押します.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      {header}
      <div className="space-y-6">
        {/* 実験ごとの色の凡例と主な結果. 読めなかった実験も外せるように行を残す */}
        <Card title="実験" padded={false}>
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">実験</th>
                  <th className="px-4 py-2 font-medium">状態</th>
                  <th className="px-4 py-2 text-right font-medium">ベスト</th>
                  <th className="px-4 py-2 text-right font-medium">エポック</th>
                  <th className="px-4 py-2 text-right font-medium">学習時間</th>
                  <th className="w-10">
                    <span className="sr-only">比較から外す</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {slots.map((slot) => (
                  <tr key={slot.id} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-1 w-4 shrink-0 rounded-full"
                          style={{ background: `var(${slot.color})` }}
                          aria-hidden
                        />
                        <Link
                          to={`/projects/${projectId}/runs/${encodeRunId(slot.id)}`}
                          className="font-medium hover:text-accent-text"
                        >
                          {shortLabel(slot.id)}
                        </Link>
                      </div>
                      {slot.run && (
                        <div className="pl-6 text-xs text-ink-3">
                          {formatDateTime(slot.run.started_at)}
                        </div>
                      )}
                    </td>
                    {slot.error ? (
                      <td colSpan={4} className="px-4 py-2">
                        <ErrorBox error={slot.error} live={false} />
                      </td>
                    ) : !slot.run ? (
                      <td colSpan={4} className="px-4 py-2 text-xs text-ink-3">
                        読み込み中
                      </td>
                    ) : (
                      <>
                        <td className="px-4 py-2">
                          <StatusBadge status={slot.run.status} />
                        </td>
                        <td className="tabular px-4 py-2 text-right">
                          {slot.run.best ? (
                            <>
                              {formatMetric(slot.run.best.value)}
                              <div className="text-[11px] text-ink-3">
                                {slot.run.best.monitor} @ {slot.run.best.epoch}
                              </div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="tabular px-4 py-2 text-right">{slot.run.epochs}</td>
                        <td className="tabular px-4 py-2 text-right text-ink-2">
                          {formatDuration(slot.run.duration_sec)}
                        </td>
                      </>
                    )}
                    <td className="px-2">
                      <button
                        type="button"
                        onClick={() => remove(slot.id)}
                        className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
                        aria-label={`${slot.id} を比較から外す`}
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {loading && <Spinner />}

        {/* 指標ごとに実験を重ねたグラフ */}
        {!loading && ready.length > 0 && (
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">学習曲線</h2>
              <div className="flex flex-wrap items-center gap-4 text-xs text-ink-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showTrain}
                    onChange={(event) => setShowTrain(event.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  検証用がある指標も学習用を表示する
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={logScale}
                    onChange={(event) => setLogScale(event.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  縦軸を対数にする
                </label>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {charts.map(({ column, series, missing }) => (
                <Card key={column} title={<span className="font-mono">{column}</span>}>
                  <LineChart
                    series={series}
                    logScale={logScale}
                    xLabel="epoch"
                    label={`${column} の実験ごとの推移`}
                  />
                  {missing.length > 0 && (
                    <p className="mt-1 text-[11px] text-ink-3">
                      この指標が無い実験: {missing.join(', ')}
                    </p>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}

        {!loading && sharedImages.length > 0 && (
          <ImageCompare
            series={sharedImages}
            runs={ready.map((slot) => ({
              id: slot.id,
              label: shortLabel(slot.id),
              color: slot.color,
            }))}
            projectId={projectId}
          />
        )}

        {/* config の違う項目 */}
        {!loading && ready.length > 1 && (
          <Card title={`config の違い (${configKeys.length})`} padded={false}>
            {configKeys.length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-3">全ての実験で config が同じです.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-ink-3">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-medium">項目</th>
                      {ready.map((slot) => (
                        <th key={slot.id} className="px-4 py-2 font-medium">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="h-1 w-3 rounded-full"
                              style={{ background: `var(${slot.color})` }}
                              aria-hidden
                            />
                            {shortLabel(slot.id)}
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
                            key={ready[index]?.id}
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
        )}
      </div>
    </>
  )
}
